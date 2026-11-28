// The Support Level table (ADR 0028): kit-owned, harness by Stage, each cell a
// level and a link to the run that earned it. It is published inside
// `cli/harnesses.json` (ADR 0030), which `node scripts/gen_harnesses.mjs`
// writes from here and the adapters; preflight and the docs read that file.
//
// A pair starts at `documented` when its adapter merges. A level changes only
// by a pull request that edits its cell here and cites the run:
//
//   documented  merged with its adapter; no run recorded.
//   tried       one recorded run of the Stage on the harness through the
//               Launcher, in this repository, with a valid Stage result and
//               every Guard probe passing. Any other gap is named.
//   verified    a recorded run with no named gap: the Stage's whole outcome
//               landed, and the wall clock and token cap were seen to hold.
//
// A pair whose Guard probe fails has no level (`level: null`) and is refused.

/** Every Stage, in rollout order. Static security audit and Deep scan are two. */
export const STAGES = Object.freeze([
  "deep-scan",
  "security-audit",
  "review",
  "plan",
  "implement",
  "review-response",
]);

/** The Stages refused on a pair below `tried`, outside a Proving run. */
export const SECURITY_STAGES = Object.freeze(["deep-scan", "security-audit"]);

/** The levels, lowest first. */
export const SUPPORT_LEVELS = Object.freeze(["documented", "tried", "verified"]);

const documented = () => ({ level: "documented", run: null });

/** @type {Record<string, Record<string, { level: string | null, run: string | null }>>} */
export const SUPPORT_TABLE = Object.freeze({
  "claude-code": {
    "deep-scan": documented(),
    "security-audit": documented(),
    review: documented(),
    plan: documented(),
    implement: documented(),
    "review-response": documented(),
  },
});
