// Every Trigger label a Caller passes as `trigger_label` must exist.

import { result, shellQuote } from "./result.mjs";

const ID = "trigger-labels";
const TITLE = "Trigger labels exist";

export function triggerLabels(callers) {
  const labels = new Map();
  for (const caller of callers) {
    for (const job of caller.jobs) {
      const label = job.with?.trigger_label;
      if (typeof label !== "string" || label === "" || label.includes("${{")) continue;
      labels.set(label.toLowerCase(), {
        name: label,
        where: [...(labels.get(label.toLowerCase())?.where ?? []), `${caller.path}:${job.name}`],
      });
    }
  }
  return [...labels.values()];
}

export function checkLabels({ github, repo, callers }) {
  const wanted = triggerLabels(callers);
  if (wanted.length === 0) return result(ID, TITLE, "pass", "No Caller sets a trigger_label.");
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
