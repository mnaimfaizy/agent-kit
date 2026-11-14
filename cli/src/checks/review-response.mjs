// Review response mode: what CLAUDE_REVIEW_RESPONSE_MODE is set to, and, in
// auto mode, whether the Callers carry what the Handoff needs. The Trigger
// label and the Kill switch variable are covered by the trigger-labels and
// variables checks, which read them from the Callers like any other flow's.
//
// Auto mode needs both ends wired: the review Caller passes `response_mode`
// and names the Review response Caller in `response_workflow`, and that
// Caller passes `response_mode` and takes a `workflow_dispatch` with a
// `pr_number` input. Anything short of that never starts a round, without an
// error anywhere a Consumer would look.

import { result } from "./result.mjs";

const ID = "review-response-mode";
const TITLE = "Review response mode is set up";
export const MODE_VARIABLE = "CLAUDE_REVIEW_RESPONSE_MODE";
const RESPONSE_REUSABLE = "agent-review-response-reusable.yml";
const REVIEW_REUSABLE = "agent-review-reusable.yml";
/** What the review workflow's handoff accepts as `response_workflow`. */
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.ya?ml$/;

/**
 * The variable's value as a workflow run sees it: the repository's, else the
 * organization's. null when neither sets it. Throws when it cannot be read.
 */
export function readMode(github, repo, ownerType) {
  try {
    return String(github.getJson(`repos/${repo}/actions/variables/${MODE_VARIABLE}`).value ?? "");
  } catch (err) {
    if (err?.httpStatus !== 404) throw err;
  }
  if (ownerType !== "Organization") return null;
  const lines = github.getLines(
    `repos/${repo}/actions/organization-variables`,
    `.variables[] | select(.name == "${MODE_VARIABLE}") | .value`,
  );
  return lines.length ? lines[0] : null;
}

const jobsUsing = (callers, file) =>
  callers.flatMap((caller) =>
    caller.jobs
      .filter((job) => job.uses.file === file)
      .map((job) => ({ caller, job, where: `${caller.path}:${job.name}` })),
  );

const passes = (job, input) =>
  typeof job.with?.[input] === "string" && job.with[input].trim() !== "";

/**
 * Where a job's `response_mode` comes from: "auto" (the literal), "variable"
 * (an expression reading the mode variable), "other" (anything else), or
 * null when the job does not pass it.
 */
export function modeSource(job) {
  if (!passes(job, "response_mode")) return null;
  const value = job.with.response_mode.trim();
  if (value === "auto") return "auto";
  // An expression that reads the variable: `${{ vars.CLAUDE_REVIEW_RESPONSE_MODE || 'manual' }}`.
  if (/^\$\{\{.*\bvars\.CLAUDE_REVIEW_RESPONSE_MODE\b.*\}\}$/i.test(value)) return "variable";
  return "other";
}

/** Does any Caller hardcode `response_mode: auto`, whatever the variable says? */
const hardcodesAuto = (callers) =>
  [...jobsUsing(callers, RESPONSE_REUSABLE), ...jobsUsing(callers, REVIEW_REUSABLE)].some(
    ({ job }) => modeSource(job) === "auto",
  );

/**
 * Why a job would not see `auto` as its `response_mode`, given the
 * variable's value; null when it would.
 */
function notAuto(job, mode, consequence) {
  const source = modeSource(job);
  if (source === null) {
    return `does not pass response_mode (vars.${MODE_VARIABLE}), so ${consequence}.`;
  }
  if (source === "other") {
    return (
      `passes response_mode ${JSON.stringify(job.with.response_mode.trim())}, which neither ` +
      `reads vars.${MODE_VARIABLE} nor is auto, so ${consequence}.`
    );
  }
  if (source === "variable" && mode !== "auto") {
    return `reads response_mode from vars.${MODE_VARIABLE}, which is not auto, so ${consequence}.`;
  }
  return null;
}

/**
 * Why auto mode would never start a round from these Callers; empty when it
 * would. `mode` is the variable's value (null when unset).
 */
export function autoModeProblems(callers, mode = "auto") {
  const problems = [];
  const responders = jobsUsing(callers, RESPONSE_REUSABLE);
  // A responder file whose trigger is wrong is reported once, here, not again
  // for every review Caller that names it.
  const responderFiles = new Set(responders.map((r) => r.caller.path));
  for (const caller of new Set(responders.map((r) => r.caller))) {
    if (caller.dispatchInputs === null) {
      problems.push(
        `${caller.path}: has no workflow_dispatch trigger, so the review handoff cannot start it.`,
      );
    } else if (!caller.dispatchInputs.includes("pr_number")) {
      problems.push(
        `${caller.path}: its workflow_dispatch trigger has no pr_number input, so GitHub refuses the review handoff's dispatch.`,
      );
    }
  }
  for (const { job, where } of responders) {
    const why = notAuto(job, mode, "its gate refuses every dispatched round");
    if (why) problems.push(`${where}: ${why}`);
  }

  const reviewers = jobsUsing(callers, REVIEW_REUSABLE);
  if (reviewers.length === 0) {
    problems.push(
      `No Caller uses ${REVIEW_REUSABLE}, so no review hands off: auto mode never starts a round.`,
    );
  }
  for (const { job, where } of reviewers) {
    const why = notAuto(job, mode, "its reviews never hand off");
    if (why) problems.push(`${where}: ${why}`);
    const target = passes(job, "response_workflow") ? job.with.response_workflow.trim() : "";
    if (!target) {
      problems.push(
        `${where}: does not pass response_workflow, your Review response Caller as .github/workflows/<file>.yml.`,
      );
    } else if (target.includes("${{")) {
      problems.push(`${where}: response_workflow is an expression, which doctor cannot check.`);
    } else if (!WORKFLOW_PATH.test(target)) {
      problems.push(
        `${where}: response_workflow ${JSON.stringify(target)} is not a file directly under .github/workflows/.`,
      );
    } else if (!responderFiles.has(target)) {
      problems.push(
        `${where}: response_workflow ${JSON.stringify(target)} is not a Review response Caller here ` +
          `(a workflow whose job uses ${RESPONSE_REUSABLE}).`,
      );
    }
  }
  return problems;
}

export function checkReviewResponseMode({ github, repo, ownerType, callers }) {
  if (jobsUsing(callers, RESPONSE_REUSABLE).length === 0) {
    return result(ID, TITLE, "pass", "No Caller uses the Review response flow.");
  }
  let mode;
  try {
    mode = readMode(github, repo, ownerType);
  } catch (err) {
    return result(ID, TITLE, "skip", `Could not read ${MODE_VARIABLE}: ${err.message}`);
  }
  // A Caller that hardcodes `response_mode: auto` is in auto mode whatever
  // the variable says, so its wiring is checked too.
  if (mode !== "auto" && hardcodesAuto(callers)) {
    const problems = autoModeProblems(callers, mode);
    if (problems.length) {
      return result(
        ID,
        TITLE,
        "fail",
        `A Caller passes response_mode: auto, but ${problems.length} problem(s) keep the handoff from starting a round.`,
        { details: problems },
      );
    }
    return result(
      ID,
      TITLE,
      "pass",
      "Auto (response_mode: auto in the Callers): a finished review that left findings starts a round.",
    );
  }
  if (mode === null || mode === "" || mode === "manual") {
    return result(
      ID,
      TITLE,
      "pass",
      `Manual: ${MODE_VARIABLE} is ${mode === null ? "not set" : JSON.stringify(mode)}, so only the Trigger label starts a round.`,
    );
  }
  if (mode !== "auto") {
    return result(
      ID,
      TITLE,
      "warn",
      `${MODE_VARIABLE} is ${JSON.stringify(mode)}, which is not exactly auto, so Review response stays manual.`,
      { details: ["Set it to auto for auto mode, or to manual (or delete it) for manual mode."] },
    );
  }
  const problems = autoModeProblems(callers, mode);
  if (problems.length) {
    return result(
      ID,
      TITLE,
      "fail",
      `${MODE_VARIABLE} is auto, but ${problems.length} problem(s) keep the handoff from starting a round.`,
      { details: problems },
    );
  }
  return result(ID, TITLE, "pass", "Auto: a finished review that left findings starts a round.");
}
