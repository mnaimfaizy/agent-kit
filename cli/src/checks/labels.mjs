// Every Trigger label a Caller uses must exist: its `trigger_label`, or the
// reusable workflow's default for that input at the pinned tag when the
// Caller leaves it out.

import { parseWorkflowCallInputs } from "../workflow-call.mjs";
import { result, shellQuote } from "./result.mjs";

const ID = "trigger-labels";
const TITLE = "Trigger labels exist";

/**
 * @param {object[]} callers
 * @param {((workflowFile: string) => string | null) | null} readReusable reads
 *   .github/workflows/<file> at the pinned tag; null when the tag is unknown.
 */
export function triggerLabels(callers, readReusable = null) {
  const labels = new Map();
  const defaults = new Map();
  const defaultFor = (file) => {
    if (!readReusable) return null;
    if (!defaults.has(file)) {
      const text = readReusable(file);
      const inputs = text === null ? null : parseWorkflowCallInputs(text);
      defaults.set(file, inputs?.get("trigger_label")?.default ?? null);
    }
    return defaults.get(file);
  };
  for (const caller of callers) {
    for (const job of caller.jobs) {
      const explicit = job.with && "trigger_label" in job.with;
      const label = explicit ? job.with.trigger_label : defaultFor(job.uses.file);
      if (typeof label !== "string" || label === "" || label.includes("${{")) continue;
      const where = `${caller.path}:${job.name}${explicit ? "" : " (default)"}`;
      labels.set(label.toLowerCase(), {
        name: label,
        where: [...(labels.get(label.toLowerCase())?.where ?? []), where],
      });
    }
  }
  return [...labels.values()];
}

export function checkLabels({ github, repo, callers, readReusable = null }) {
  const wanted = triggerLabels(callers, readReusable);
  if (wanted.length === 0) return result(ID, TITLE, "pass", "No Caller uses a Trigger label.");
  let existing;
  try {
    existing = new Set(
      github.getLines(`repos/${repo}/labels`, ".[].name").map((n) => n.toLowerCase()),
    );
  } catch (err) {
    return result(ID, TITLE, "skip", `Could not list labels: ${err.message}`);
  }
  const missing = wanted.filter((l) => !existing.has(l.name.toLowerCase()));
  if (missing.length === 0)
    return result(ID, TITLE, "pass", `All ${wanted.length} Trigger label(s) exist.`);
  return result(ID, TITLE, "fail", `${missing.length} Trigger label(s) missing.`, {
    details: missing.map((l) => `${l.name} (${l.where.join(", ")})`),
    fix: missing.map((l) => `gh label create ${shellQuote(l.name)} --repo ${repo}`),
  });
}
