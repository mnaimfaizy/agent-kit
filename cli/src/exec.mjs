// Runs commands as argument arrays, never through a shell, so no string from a
// Consumer file or a GitHub response is ever parsed as shell syntax. Each
// subcommand gets a runner that runs only the commands on its own allowlist:
// `init`, `upgrade` and `doctor` reach only `git` and `gh`, and `deep-scan`
// alone adds the accepted sandbox runtimes' CLIs and the 1Password CLI, which
// reads its model credential (ADR 0019). There is no
// second runner that bypasses this. Every module takes a runner as a
// parameter; tests inject a fake one, or a fake spawn behind the real
// allowlist. A runner also has `start`, the same command run without
// blocking (`deep-scan`'s long sandbox steps), so an interrupt can stop the
// step and the sandbox still be torn down; it checks the same allowlist.

import { spawn as spawnChild, spawnSync } from "node:child_process";

/** The sandbox runtimes' command-line tools, which only `deep-scan` may run. */
export const RUNTIME_CLIS = Object.freeze([
  "sbx",
  "docker",
  "runsc",
  "kata-runtime",
  "firecracker",
]);

/** The secret managers' command-line tools, which only `deep-scan` may run. */
export const SECRET_MANAGER_CLIS = Object.freeze(["op"]);

const ALLOWLISTS = Object.freeze({
  init: Object.freeze(["git", "gh"]),
  upgrade: Object.freeze(["git", "gh"]),
  doctor: Object.freeze(["git", "gh"]),
  "deep-scan": Object.freeze(["git", ...RUNTIME_CLIS, ...SECRET_MANAGER_CLIS]),
});

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string, code?: string }} RunResult
 * @typedef {{ status: number | null, stdout: Buffer, stderr: string, code?: string }} BufferResult
 * @typedef {{ status: number | null, signal: string | null, aborted: boolean, stdout: Buffer, stderr: string }} StartResult
 *   `aborted` is true when `opts.signal` stopped the command.
 * @typedef {(cmd: string, args: string[], opts?: { cwd?: string, env?: NodeJS.ProcessEnv, stdin?: Buffer | string, signal?: AbortSignal }) => Promise<StartResult>} Start
 * @typedef {((cmd: string, args: string[], opts?: { cwd?: string, env?: NodeJS.ProcessEnv, encoding?: "utf8" | "buffer", maxBuffer?: number }) => RunResult) & { start: Start }} Runner
 *   With `encoding: "buffer"`, stdout is the raw bytes (a Buffer): use it for
 *   file contents, which need not be UTF-8. stderr is always text. `start`
 *   runs a command without blocking, feeds it `stdin`, and kills it when
 *   `signal` aborts.
 */

/** The commands a subcommand's runner may run. */
export function allowedCommands(subcommand) {
  const list = Object.hasOwn(ALLOWLISTS, subcommand) ? ALLOWLISTS[subcommand] : null;
  if (!list) throw new Error(`no process allowlist for ${JSON.stringify(subcommand)}`);
  return list;
}

const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * How much of a child's error output is kept: its start and its end. Only
 * the first line or the last lines are ever shown, and the output can come
 * from untrusted code (a setup step), so it must not fill the heap.
 */
const MAX_ERR_HEAD = 64 * 1024;
const MAX_ERR_TAIL = 1024 * 1024;
const ERR_CUT = "\n[... error output cut ...]\n";

/** A collector for a child's error output that keeps its head and a tail ring. */
function errorCollector() {
  const head = [];
  let headSize = 0;
  let tail = [];
  let tailSize = 0;
  let cut = false;
  return {
    push(b) {
      if (headSize < MAX_ERR_HEAD) {
        const take = b.subarray(0, MAX_ERR_HEAD - headSize);
        head.push(take);
        headSize += take.length;
        b = b.subarray(take.length);
      }
      if (!b.length) return;
      tail.push(b);
      tailSize += b.length;
      while (tail.length > 1 && tailSize - tail[0].length >= MAX_ERR_TAIL) {
        tailSize -= tail.shift().length;
        cut = true;
      }
    },
    text() {
      let rest = Buffer.concat(tail);
      if (rest.length > MAX_ERR_TAIL) {
        rest = rest.subarray(rest.length - MAX_ERR_TAIL);
        cut = true;
      }
      return `${Buffer.concat(head).toString("utf8")}${cut ? ERR_CUT : ""}${rest.toString("utf8")}`;
    },
  };
}

/**
 * The runner for one subcommand. `spawn` and `spawnAsync` are the process
 * boundary (blocking and not), replaceable only by tests; the allowlist check
 * always runs first.
 * @param {string} subcommand
 * @param {{ spawn?: typeof spawnSync, spawnAsync?: typeof spawnChild }} [opts]
 * @returns {Runner}
 */
export function runnerFor(subcommand, { spawn = spawnSync, spawnAsync = spawnChild } = {}) {
  return makeRunner(allowedCommands(subcommand), subcommand, spawn, spawnAsync);
}

function makeRunner(list, who, spawn, spawnAsync = spawnChild) {
  const allowed = new Set(list);
  const names = `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
  const check = (cmd, args) => {
    if (!allowed.has(cmd)) {
      throw new Error(`refusing to run ${cmd}: ${who} may run only ${names}`);
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new TypeError("runner arguments must be an array of strings");
    }
  };
  const envFor = (opts) => ({
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    ...opts.env,
  });
  /** @type {Start} */
  const start = (cmd, args, opts = {}) => {
    check(cmd, args);
    return new Promise((resolve) => {
      let done = false;
      let aborted = false;
      const out = [];
      const err = errorCollector();
      let size = 0;
      const finish = (result) => {
        if (done) return;
        done = true;
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({ aborted, ...result });
      };
      let child;
      const onAbort = () => {
        aborted = true;
        child?.kill("SIGTERM");
      };
      try {
        child = spawnAsync(cmd, args, {
          cwd: opts.cwd,
          env: envFor(opts),
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        finish({
          status: null,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: `${cmd}: ${e.message}`,
        });
        return;
      }
      child.stdout.on("data", (b) => {
        size += b.length;
        if (size <= MAX_OUTPUT) out.push(b);
      });
      child.stderr.on("data", (b) => err.push(b));
      child.on("error", (e) =>
        finish({
          status: null,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: `${cmd}: ${e.message}`,
        }),
      );
      child.on("close", (status, signal) =>
        finish({
          status,
          signal,
          stdout: Buffer.concat(out),
          stderr: err.text(),
        }),
      );
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdin ?? undefined);
    });
  };
  function run(cmd, args, opts = {}) {
    check(cmd, args);
    const result = spawn(cmd, args, {
      cwd: opts.cwd,
      env: envFor(opts),
      encoding: "buffer",
      shell: false,
      windowsHide: true,
      maxBuffer: opts.maxBuffer ?? MAX_OUTPUT,
    });
    const raw = opts.encoding === "buffer";
    if (result.error) {
      return {
        status: null,
        stdout: raw ? Buffer.alloc(0) : "",
        stderr: `${cmd}: ${result.error.message}`,
        ...(result.error.code ? { code: result.error.code } : {}),
      };
    }
    const stdout = result.stdout ?? Buffer.alloc(0);
    return {
      status: result.status,
      stdout: raw ? stdout : stdout.toString("utf8"),
      stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
    };
  }
  run.start = start;
  return run;
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
