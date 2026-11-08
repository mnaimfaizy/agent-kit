// Runs `git` and `gh` as argument arrays, never through a shell, so no string
// from a Consumer file or a GitHub response is ever parsed as shell syntax.
// Every module takes a runner as a parameter; tests inject a fake one.

import { spawnSync } from "node:child_process";

const ALLOWED = new Set(["git", "gh"]);

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string }} RunResult
 * @typedef {{ status: number | null, stdout: Buffer, stderr: string }} BufferResult
 * @typedef {(cmd: string, args: string[], opts?: { cwd?: string, env?: NodeJS.ProcessEnv, encoding?: "utf8" | "buffer" }) => RunResult} Runner
 *   With `encoding: "buffer"`, stdout is the raw bytes (a Buffer): use it for
 *   file contents, which need not be UTF-8. stderr is always text.
 */

/** @type {Runner} */
export function systemRunner(cmd, args, opts = {}) {
  if (!ALLOWED.has(cmd)) throw new Error(`refusing to run ${cmd}: only git and gh are allowed`);
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new TypeError("runner arguments must be an array of strings");
  }
  const result = spawnSync(cmd, args, {
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
}

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
