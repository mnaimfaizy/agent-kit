// What a sandbox lifecycle step can end with, shared by the lifecycle and
// its drivers: a failed step (the run ends before the agent step, with what
// to show), or an interrupt (SIGINT or SIGTERM).

import { firstLine } from "../exec.mjs";

export class StepFailed extends Error {
  /** @param {string[]} lines */
  constructor(lines) {
    super(lines[0]);
    this.lines = lines;
  }
}

export class Interrupted extends Error {
  /** @param {string} signal */
  constructor(signal) {
    super(`interrupted by ${signal}`);
    this.signal = signal;
  }
}

export const ENDS_HERE = "The run ends here, before the agent step.";

/** The step failure for a command that did not succeed. */
export function failed(what, r, { showOutput = false, extra = [] } = {}) {
  return new StepFailed([
    `FAILED  ${what}: ${firstLine(r.stderr) || `exit ${r.status}`}`,
    ...(showOutput ? outputLines(r) : []),
    ...extra,
    ENDS_HERE,
  ]);
}

/** `r` unchanged when it succeeded, else its step failure, thrown. */
export function must(r, what, opts) {
  if (r.status === 0) return r;
  throw failed(what, r, opts);
}

/** A command's output, indented, for a failure message. */
export function outputLines(r) {
  const text = `${r.stdout.toString("utf8")}${r.stderr}`.trimEnd();
  return text ? ["Output:", ...indent(text)] : ["(no output)"];
}

export const indent = (text) => text.split(/\r\n|\r|\n/).map((l) => `  ${l}`);
