// Every Trigger label a Caller uses must exist: its `trigger_label`, or the
// reusable workflow's default for that input at the pinned tag when the
// Caller leaves it out.

import { parseWorkflowCallInputs } from "../workflow-call.mjs";
import { byHand, command, LABEL_PATTERN, result } from "./result.mjs";

const ID = "trigger-labels";
const TITLE = "Trigger labels exist";

/**
 * @param {object[]} callers
 * @param {((workflowFile: string) => string | null) | null} readReusable reads
 *   .github/workflows/<file> at the pinned tag; null when the tag is unknown.
 * @returns {{ labels: { name: string, where: string[] }[], unknown: string[] }}
 *   `unknown`: jobs whose label could not be worked out (a default that could
 *   not be read, or a Caller file doctor could not parse fully).
 */
export function triggerLabels(callers, readReusable = null) {
  const labels = new Map();
  const unknown = [];
  const defaults = new Map();
  const defaultFor = (file) => {
    if (!readReusable) return undefined;
    if (!defaults.has(file)) {
      const text = readReusable(file);
      const inputs = text === null ? null : parseWorkflowCallInputs(text);
      defaults.set(file, inputs ? (inputs.get("trigger_label")?.default ?? null) : undefined);
    }
    return defaults.get(file);
  };
  for (const caller of callers) {
    if (caller.parseIncomplete) unknown.push(`${caller.path}: ${caller.parseIncomplete}`);
    for (const job of caller.jobs) {
      const explicit = job.with && "trigger_label" in job.with;
      const label = explicit ? job.with.trigger_label : defaultFor(job.uses.file);
      const where = `${caller.path}:${job.name}${explicit ? "" : " (default)"}`;
      if (label === undefined) {
        unknown.push(
          `${where}: uses the default trigger_label of ${job.uses.file}, which could not be read`,
        );
        continue;
      }
      if (typeof label !== "string" || label === "" || label.includes("${{")) continue;
      labels.set(label.toLowerCase(), {
        name: label,
        where: [...(labels.get(label.toLowerCase())?.where ?? []), where],
      });
    }
  }
  return { labels: [...labels.values()], unknown };
}

export function checkLabels({ github, repo, callers, readReusable = null }) {
  const { labels: wanted, unknown } = triggerLabels(callers, readReusable);
  if (wanted.length === 0 && unknown.length === 0) {
    return result(ID, TITLE, "pass", "No Caller uses a Trigger label.");
  }
  let existing = new Set();
  if (wanted.length) {
    try {
      existing = new Set(
        github.getLines(`repos/${repo}/labels`, ".[].name").map((n) => n.toLowerCase()),
      );
    } catch (err) {
      return result(ID, TITLE, "skip", `Could not list labels: ${err.message}`, {
        details: unknown,
      });
    }
  }
  const missing = wanted.filter((l) => !existing.has(l.name.toLowerCase()));
  if (missing.length) {
    const fix = [];
    const notes = [];
    for (const l of missing) {
      if (LABEL_PATTERN.test(l.name))
        fix.push(command("gh", "label", "create", l.name, "--repo", repo));
      else notes.push(byHand("create the label", l.name));
    }
    return result(ID, TITLE, "fail", `${missing.length} Trigger label(s) missing.`, {
      details: [
        ...missing.map((l) => `${JSON.stringify(l.name)} (${l.where.join(", ")})`),
        ...unknown,
        ...notes,
      ],
      fix,
    });
  }
  if (unknown.length) {
    // A label that could not be worked out is never reported as existing.
    return result(
      ID,
      TITLE,
      "skip",
      `${wanted.length} Trigger label(s) exist; ${unknown.length} could not be worked out.`,
      { details: unknown },
    );
  }
  return result(ID, TITLE, "pass", `All ${wanted.length} Trigger label(s) exist.`);
}
