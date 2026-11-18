// Pattern guide skeleton: docs/patterns/merge-train.md in Agent-kit.
//
// The merge train's decision core. Every decision lives here: what one read of
// a pull request means, when to update, wait, merge or stop, and whether an
// optional auto-merge would merge. Nothing here calls the forge, reads the
// clock or sleeps; the IO shell (merge-train.mjs) does that and hands this
// module plain objects, so the contract suite (merge-train-core.test.mjs) can
// drive every branch, the whole loop included, over fixtures.
//
// Copy it into your repository, fill in each TODO(adopt), and delete the
// Pattern guide line above.

// TODO(adopt): the branch the train merges into, and whose ruleset it reads.
export const BASE = "<base branch>";
export const DEFAULT_POLL_SECONDS = 30;
// TODO(adopt): about three times your slowest normal check run. Past it a run
// is stuck, not slow.
export const DEFAULT_TIMEOUT_MINUTES = 45;
// How often one pull request may be brought up to date. Each update happens
// because something else merged under it; past this, a person should look.
export const MAX_UPDATES = 3;
// How often the forge may refuse a merge on a green, up-to-date head.
export const MAX_MERGE_REFUSALS = 3;
// Reads in a row that may say BLOCKED while every required check is green.
// The forge's merge state lags its checks by a few seconds; several reads in
// a row mean something else (a review, a rule the train does not know).
export const MAX_BLOCKED_GREEN_READS = 4;

const MERGEABLE = new Set(["CLEAN", "UNSTABLE", "HAS_HOOKS"]);

/**
 * The required check names, from the forge's merged branch rules (on GitHub,
 * `repos/<owner>/<repo>/rules/branches/<base>`). Read every run, never listed
 * here, so a check added to the ruleset is waited on the day it is added.
 */
export function requiredChecksFromRules(rules) {
  if (!Array.isArray(rules)) return [];
  const names = new Set();
  for (const rule of rules) {
    if (rule?.type !== "required_status_checks") continue;
    for (const check of rule.parameters?.required_status_checks ?? []) {
      if (check?.context) names.add(check.context);
    }
  }
  return [...names].sort();
}

/**
 * Sorts each required check into red, waiting or green. A required check with
 * no run on this head is waiting, never green: right after an update the new
 * head has no checks yet, and reading that absence as a pass is the unchecked
 * merge the train exists to stop. When a name has several runs, the newest
 * decides.
 */
export function requiredCheckState(required, checks) {
  const newest = new Map();
  for (const check of checks) {
    const seen = newest.get(check.name);
    if (!seen || (check.startedAt ?? "") >= (seen.startedAt ?? "")) {
      newest.set(check.name, check);
    }
  }
  const state = { red: [], waiting: [], green: [] };
  for (const name of required) {
    const bucket = newest.get(name)?.bucket;
    if (bucket === "fail" || bucket === "cancel") state.red.push(name);
    // TODO(adopt): count `skipping` as green only if your forge treats a
    // skipped required check as passing, as GitHub does.
    else if (bucket === "pass" || bucket === "skipping") state.green.push(name);
    else state.waiting.push(name);
  }
  return state;
}

/**
 * What to do with one pull request after one read of it. The order of the
 * checks is the decision: a branch that is behind is updated before its
 * checks are read, because checks on a stale head say nothing about what
 * would land; a red check stops before anything is waited on; and the merge
 * names the exact head whose checks were just read.
 */
export function decideNext(pr, required, { blockedGreenReads = 0 } = {}) {
  const stop = (reason) => ({ kind: "stop", reason: `#${pr.number} ${reason}` });
  if (pr.state === "MERGED") return { kind: "merged" };
  if (pr.state !== "OPEN") return stop(`is ${pr.state.toLowerCase()}`);
  if (pr.isDraft) return stop("is a draft");
  if (pr.baseRefName !== BASE) return stop(`targets ${pr.baseRefName}, not ${BASE}`);
  if (pr.mergeStateStatus === "DIRTY") return stop(`conflicts with ${BASE}; rebase it by hand`);
  if (pr.mergeStateStatus === "BEHIND") return { kind: "update" };

  const checks = requiredCheckState(required, pr.checks);
  if (checks.red.length > 0) return stop(`has a red required check: ${checks.red.join(", ")}`);
  if (checks.waiting.length > 0)
    return { kind: "wait", reason: `waiting on ${checks.waiting.join(", ")}` };

  if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED") {
    return stop(`needs a review (${pr.reviewDecision})`);
  }
  if (MERGEABLE.has(pr.mergeStateStatus)) return { kind: "merge", head: pr.headRefOid };
  if (pr.mergeStateStatus === "BLOCKED") {
    return blockedGreenReads + 1 >= MAX_BLOCKED_GREEN_READS
      ? stop("stays BLOCKED with every required check green")
      : { kind: "wait", reason: "the forge has not unblocked the merge yet", blockedGreen: true };
  }
  return { kind: "wait", reason: `merge state is ${pr.mergeStateStatus}` };
}

/**
 * Drives one pull request until it merges or cannot. `io` is the shell's:
 * read(pr), update(pr, head), merge(pr, head), sleep(seconds), now(), log(line).
 * `beforeMerge(snapshot)` may return a reason that holds the merge (the
 * auto-merge rules use it); it can only stop a merge, never start one.
 */
export async function drive(pr, args, io, required, beforeMerge = () => null) {
  const deadline = io.now() + args.timeoutMinutes * 60_000;
  let updates = 0;
  let refusals = 0;
  let blockedGreenReads = 0;
  for (;;) {
    const snapshot = io.read(pr);
    if (!snapshot) return { kind: "stopped", reason: `#${pr} could not be read` };
    const step = decideNext(snapshot, required, { blockedGreenReads });
    if (step.kind === "merged") return { kind: "merged" };
    if (step.kind === "stop") return { kind: "stopped", reason: step.reason };
    if (step.kind === "update") {
      if (updates >= MAX_UPDATES) {
        return { kind: "stopped", reason: `#${pr} fell behind ${BASE} ${updates + 1} times` };
      }
      updates += 1;
      if (!io.update(pr, snapshot.headRefOid)) {
        return { kind: "stopped", reason: `#${pr} could not be brought up to date` };
      }
      blockedGreenReads = 0;
    } else if (step.kind === "merge") {
      const hold = beforeMerge(snapshot);
      if (hold) return { kind: "stopped", reason: hold };
      if (io.merge(pr, step.head)) return { kind: "merged", head: step.head };
      refusals += 1;
      if (refusals >= MAX_MERGE_REFUSALS) {
        return {
          kind: "stopped",
          reason: `the forge refused #${pr} ${refusals} times on a green head`,
        };
      }
    } else {
      blockedGreenReads = step.blockedGreen ? blockedGreenReads + 1 : 0;
      if (io.now() >= deadline) {
        return {
          kind: "stopped",
          reason: `#${pr} waited ${args.timeoutMinutes} min and is still ${step.reason}`,
        };
      }
      io.log(`#${pr}: ${step.reason}`);
    }
    await io.sleep(args.pollSeconds);
  }
}

/**
 * The train a person starts: one at a time, in the order given. It stops at
 * the first pull request it cannot merge and names the ones it never reached.
 */
export async function runTrain(args, io) {
  const required = io.requiredChecks();
  const merged = [];
  const stopAt = (index, reason) => ({
    merged,
    stoppedAt: { pr: args.pullRequests[index], reason },
    notReached: args.pullRequests.slice(index + 1),
  });
  if (required.length === 0) {
    return stopAt(
      0,
      `no required checks could be read for ${BASE}; the train will not merge what it cannot check`,
    );
  }
  for (const [index, pr] of args.pullRequests.entries()) {
    const outcome = await drive(pr, args, io, required);
    if (outcome.kind === "stopped") return stopAt(index, outcome.reason);
    merged.push(pr);
  }
  return { merged, stoppedAt: null, notReached: [] };
}

// ---------------------------------------------------------------------------
// Optional: auto-merge. Leave this out until you want it, and switch it on
// only through `shadow` (docs/patterns/merge-train.md, "Optional: auto-merge").

export const MODES = ["off", "shadow", "on"];

/** The mode from the setting file's text. Anything unreadable is `off`. */
export function parseMode(text) {
  try {
    const mode = JSON.parse(text ?? "").mode;
    return MODES.includes(mode) ? mode : "off";
  } catch {
    return "off";
  }
}

/**
 * The rules, in order. Each reads one fact the shell gathered for the head
 * about to merge and returns a reason to hold, or null. A fact the shell could
 * not read arrives as `{ status: 'missing', reason }` and always holds.
 * TODO(adopt): replace these with the facts your repository can read for one
 * exact commit. Keep the shape: every rule can hold; none can allow alone.
 */
const RULES = [
  [
    "requiredChecks",
    (f) => (f.status === "green" ? null : "required checks are not green on this head"),
  ],
  ["baseCi", (f) => (f.status === "green" ? null : `the latest ${BASE} run is not green`)],
  // A verdict counts only for the head it names; a verdict for an older head is stale.
  [
    "review",
    (f, head) =>
      f.status === "approve" && f.head === head ? null : "no approving review for this head",
  ],
  // The path guard: a pull request that edits the mode file, these rules, or
  // the paths that set its review level could approve itself. Read from the
  // base branch's copy, which the pull request has not changed.
  [
    "pathGuard",
    (f) => (f.status === "clear" ? null : `it changes a guarded path: ${f.paths?.join(", ")}`),
  ],
  // A judgment (the PR pipeline's Merge risk line) can hold, never allow:
  // only `no` is read; a missing or unreadable line changes nothing.
  [
    "reversible",
    (f) => (f.status === "no" ? "its Merge risk says a revert does not undo it" : null),
  ],
];

export function decideAutoMerge(facts, mode) {
  if (mode === "off") return { action: "skip", held: true, reason: "auto-merge is off" };
  const holds = RULES.map(([name, rule]) =>
    facts[name]?.status === "missing"
      ? `${name} could not be read: ${facts[name].reason}`
      : rule(facts[name] ?? {}, facts.head),
  ).filter(Boolean);
  const held = holds.length > 0;
  const action = mode === "on" && !held ? "merge" : mode === "shadow" ? "comment" : "skip";
  return { action, held, reason: held ? holds.join("; ") : `every fact holds for ${facts.head}` };
}

/**
 * One auto-merge pass. Unlike the train a person starts, a held candidate is
 * skipped with its reason and the pass moves on: here a hold is the normal
 * answer, not an incident. Under `on` the facts are judged again at the head
 * about to merge, after any update, so a merge never rests on facts read for
 * an earlier head. `io` adds facts(pr, snapshot, checksGreen) and
 * comment(pr, body) to the train's shell.
 */
export async function runAutoPass(args, io) {
  const result = { merged: [], wouldMerge: [], held: [] };
  if (args.mode === "off") return result;
  const required = io.requiredChecks();
  for (const pr of args.pullRequests) {
    const hold = (reason) => result.held.push({ pr, reason });
    if (required.length === 0) {
      hold("no required checks could be read");
      continue;
    }
    const first = io.read(pr);
    if (!first || first.state !== "OPEN") {
      hold(first ? `#${pr} is ${first.state.toLowerCase()}` : `#${pr} could not be read`);
      continue;
    }
    if (args.mode === "shadow") {
      const checksGreen = requiredCheckState(required, first.checks);
      const ready = checksGreen.red.length === 0 && checksGreen.waiting.length === 0;
      const decision = decideAutoMerge(io.facts(pr, first, ready), "shadow");
      // A comment that fails to post is reported; it never turns into a merge.
      if (!io.comment(pr, shadowComment(decision, first.headRefOid)))
        hold("the shadow comment could not be written");
      if (decision.held) hold(decision.reason);
      else result.wouldMerge.push(pr);
      continue;
    }
    // `on`: the checks are gated by `drive` on the updated head, so judge the rest first.
    const early = decideAutoMerge(io.facts(pr, first, true), "on");
    if (early.held) {
      hold(early.reason);
      continue;
    }
    const outcome = await drive(pr, args, io, required, (snapshot) => {
      const atHead = decideAutoMerge(io.facts(pr, snapshot, true), "on");
      return atHead.held ? atHead.reason : null;
    });
    if (outcome.kind === "merged") result.merged.push(pr);
    else hold(outcome.reason);
  }
  return result;
}

// The one comment per candidate in shadow, found again by its marker and
// edited in place. TODO(adopt): a marker of your own.
export const SHADOW_MARKER = "<!-- merge-train:auto-merge -->";

export function shadowComment(decision, head) {
  const line = decision.held ? `held: ${decision.reason}` : `would merge at \`${head}\``;
  return `${SHADOW_MARKER}\n**Merge train auto-merge (shadow):** ${line}`;
}
