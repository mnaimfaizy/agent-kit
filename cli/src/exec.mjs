// Runs commands as argument arrays, never through a shell, so no string from a
// Consumer file or a GitHub response is ever parsed as shell syntax. Each
// subcommand gets a runner that runs only the commands on its own allowlist:
// `init`, `upgrade` and `doctor` reach only `git` and `gh`, and `deep-scan`
// alone adds the accepted sandbox runtimes' CLIs (ADR 0019). There is no
// second runner that bypasses this. Every module takes a runner as a
// parameter; tests inject a fake one, or a fake spawn behind the real
// allowlist.

import { spawnSync } from "node:child_process";

/** The sandbox runtimes' command-line tools, which only `deep-scan` may run. */
export const RUNTIME_CLIS = Object.freeze([
  "sbx",
  "docker",
  "runsc",
  "kata-runtime",
  "firecracker",
]);

const ALLOWLISTS = Object.freeze({
  init: Object.freeze(["git", "gh"]),
  upgrade: Object.freeze(["git", "gh"]),
  doctor: Object.freeze(["git", "gh"]),
  "deep-scan": Object.freeze(["git", ...RUNTIME_CLIS]),
});

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string }} RunResult
 * @typedef {{ status: number | null, stdout: Buffer, stderr: string }} BufferResult
 * @typedef {(cmd: string, args: string[], opts?: { cwd?: string, env?: NodeJS.ProcessEnv, encoding?: "utf8" | "buffer" }) => RunResult} Runner
 *   With `encoding: "buffer"`, stdout is the raw bytes (a Buffer): use it for
 *   file contents, which need not be UTF-8. stderr is always text.
 */

/** The commands a subcommand's runner may run. */
export function allowedCommands(subcommand) {
  const list = Object.hasOwn(ALLOWLISTS, subcommand) ? ALLOWLISTS[subcommand] : null;
  if (!list) throw new Error(`no process allowlist for ${JSON.stringify(subcommand)}`);
  return list;
}

/**
 * The runner for one subcommand. `spawn` is the process boundary, replaceable
 * only by tests; the allowlist check always runs first.
 * @param {string} subcommand
 * @param {{ spawn?: typeof spawnSync }} [opts]
 * @returns {Runner}
 */
export function runnerFor(subcommand, { spawn = spawnSync } = {}) {
  return makeRunner(allowedCommands(subcommand), subcommand, spawn);
}

function makeRunner(list, who, spawn) {
  const allowed = new Set(list);
  const names = `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
  return function run(cmd, args, opts = {}) {
    if (!allowed.has(cmd)) {
      throw new Error(`refusing to run ${cmd}: ${who} may run only ${names}`);
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new TypeError("runner arguments must be an array of strings");
    }
    const result = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", ...opts.env },
      encoding: "buffer",
      shell: false,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    const raw = opts.encoding === "buffer";
    if (result.error) {
      return {
        status: null,
        stdout: raw ? Buffer.alloc(0) : "",
        stderr: `${cmd}: ${result.error.message}`,
      };
    }
    const stdout = result.stdout ?? Buffer.alloc(0);
    return {
      status: result.status,
      stdout: raw ? stdout : stdout.toString("utf8"),
      stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
    };
  };
}

/**
 * A `git` and `gh` runner, the allowlist `init`, `upgrade` and `doctor` share.
 * @type {Runner}
 */
export const systemRunner = makeRunner(["git", "gh"], "agent-kit", spawnSync);

/**
 * The line of a command's stderr that says what went wrong, for short
 * messages: the first `fatal:` or `error:` line, else the first line that is
 * not a `warning:` or `hint:` (git prints those before the real error, for
 * example about line endings), else the first non-empty line.
 */
export function firstLine(text) {
  const lines = String(text ?? "")
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    lines.find((l) => /^(fatal|error):/i.test(l)) ??
    lines.find((l) => !/^(warning|hint):/i.test(l)) ??
    lines[0] ??
    ""
  );
}
