// Reads a Consumer's Caller workflows: the jobs that `uses:` an Agent-kit
// reusable workflow, the secrets they pass, the repository variables they
// read, and their Trigger labels.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseScalar, parseYamlSubset, stripComment } from "./yaml-subset.mjs";

export const KIT_REPO_NAME = "agent-kit";
export const DEFAULT_KIT_REPO = "mnaimfaizy/agent-kit";

// owner/agent-kit/.github/workflows/<file>@<ref>
const KIT_USES =
  /^([A-Za-z0-9-]+)\/agent-kit\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)@(\S+)$/;
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(.+)$/;
const NAME = "[A-Za-z_][A-Za-z0-9_]*";

/** Parse a `uses:` value; null unless it points at an Agent-kit reusable workflow. */
export function parseKitUses(value) {
  const m = KIT_USES.exec(parseScalar(stripComment(String(value))));
  return m ? { owner: m[1], repo: `${m[1]}/${KIT_REPO_NAME}`, file: m[2], ref: m[3] } : null;
}

/** Every Agent-kit `uses:` line in a workflow file, with its line number. */
export function findKitPins(text) {
  const pins = [];
  String(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line, idx) => {
      if (line.trimStart().startsWith("#")) return;
      const m = USES_LINE.exec(line);
      if (!m) return;
      const pin = parseKitUses(m[1]);
      if (pin) pins.push({ ...pin, line: idx + 1 });
    });
  return pins;
}

function lines(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .map(stripComment);
}

/** Names of `secrets.X` in an expression. */
export function secretNames(value) {
  return [...String(value ?? "").matchAll(new RegExp(`secrets\\.(${NAME})`, "g"))].map((m) => m[1]);
}

/**
 * Every `vars.X` a file reads. A variable is optional when every read of it
 * falls back with `||` (as the model variables do); otherwise it is required
 * (the Kill switch variables: unset means the flow never runs).
 */
export function variableRefs(text) {
  const refs = new Map();
  const re = new RegExp(`vars\\.(${NAME})(\\s*\\|\\|)?`, "g");
  for (const line of lines(text)) {
    for (const m of line.matchAll(re)) {
      const optional = Boolean(m[2]);
      const prev = refs.get(m[1]);
      refs.set(m[1], { name: m[1], optional: prev ? prev.optional && optional : optional });
    }
  }
  return [...refs.values()];
}

/** The jobs of one workflow file that call an Agent-kit reusable workflow. */
export function parseCaller(text) {
  const doc = parseYamlSubset(text);
  const jobs = [];
  const jobMap = doc.jobs && typeof doc.jobs === "object" && !doc.jobs.$seq ? doc.jobs : {};
  for (const [name, job] of Object.entries(jobMap)) {
    if (!job || typeof job !== "object" || typeof job.uses !== "string") continue;
    const uses = parseKitUses(job.uses);
    if (!uses) continue;
    const withBlock = job.with && typeof job.with === "object" && !job.with.$seq ? job.with : {};
    let secrets = {};
    if (job.secrets === "inherit") secrets = "inherit";
    else if (job.secrets && typeof job.secrets === "object" && !job.secrets.$seq)
      secrets = job.secrets;
    jobs.push({ name, uses, with: withBlock, secrets });
  }
  return { jobs, pins: findKitPins(text), variables: variableRefs(text) };
}

/** Workflow files in .github/workflows/ (relative paths, sorted). */
export function listWorkflowFiles(repoRoot) {
  const dir = join(repoRoot, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => `.github/workflows/${e.name}`)
    .sort();
}

/** Read every workflow file; `callers` are the ones with at least one Agent-kit pin. */
export function readWorkflows(repoRoot) {
  const files = listWorkflowFiles(repoRoot).map((path) => {
    const text = readFileSync(join(repoRoot, path), "utf8");
    return { path, text, ...parseCaller(text) };
  });
  return { files, callers: files.filter((f) => f.pins.length > 0) };
}
