// Runs `git` and `gh` as argument arrays, never through a shell, so no string
// from a Consumer file or a GitHub response is ever parsed as shell syntax.
// Every module takes a runner as a parameter; tests inject a fake one.

import { spawnSync } from "node:child_process";

const ALLOWED = new Set(["git", "gh"]);

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string }} RunResult
 * @typedef {(cmd: string, args: string[], opts?: { cwd?: string, env?: NodeJS.ProcessEnv }) => RunResult} Runner
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
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    return { status: null, stdout: "", stderr: `${cmd}: ${result.error.message}` };
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** First non-empty line of a command's stderr, for short messages. */
export function firstLine(text) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ""
  );
}
