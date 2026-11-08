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

// `key: |` or `- key: >-`: the lines after it, indented deeper than the key,
// are a block scalar (a `run:` script, say), not YAML keys.
const BLOCK_START = /^(-\s+)?[^\s:#][^:]*:\s*[|>][-+0-9]*\s*$/;

/**
 * Every Agent-kit `uses:` line in a workflow file, with its line number.
 * Text inside block scalars, such as a `run: |` script, is not a pin.
 */
export function findKitPins(text) {
  const pins = [];
  let blockIndent = null;
  String(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line, idx) => {
      const indent = line.length - line.trimStart().length;
      if (blockIndent !== null) {
        if (line.trim() === "" || indent > blockIndent) return;
        blockIndent = null;
      }
      if (line.trimStart().startsWith("#")) return;
      const content = stripComment(line.slice(indent)).trimEnd();
      const block = BLOCK_START.exec(content);
      if (block) {
        blockIndent = indent + (block[1]?.length ?? 0);
        return;
      }
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
 * (the Kill switch variables: unset means the flow never runs). The `||`
 * may sit on the next line of a multi-line expression.
 */
export function variableRefs(text) {
  const refs = new Map();
  const re = new RegExp(`vars\\.(${NAME})(\\s*\\|\\|)?`, "g");
  for (const m of lines(text).join("\n").matchAll(re)) {
    const optional = Boolean(m[2]);
    const prev = refs.get(m[1]);
    refs.set(m[1], { name: m[1], optional: prev ? prev.optional && optional : optional });
  }
  return [...refs.values()];
}

/**
 * Why a job's `secrets:` cannot be read, or null. The parser reads block
 * mappings and `inherit`; a flow mapping, an anchor, an alias or a merge key
 * would need a full YAML parser, so those jobs are reported, not guessed at.
 */
function unsupportedSecrets(value) {
  if (value === undefined || value === null || value === "inherit") return null;
  if (typeof value === "string") {
    if (value.startsWith("{")) return "`secrets:` is a flow mapping ({ ... })";
    if (value.startsWith("*")) return "`secrets:` is a YAML alias";
    if (value.startsWith("&")) return "`secrets:` uses a YAML anchor";
    return `\`secrets:\` is ${JSON.stringify(value)}`;
  }
  if (value.$seq) return "`secrets:` is a list";
  if ("<<" in value) return "`secrets:` uses a YAML merge key (<<)";
  return null;
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
    const secretsUnsupported = unsupportedSecrets(job.secrets);
    let secrets = {};
    if (job.secrets === "inherit") secrets = "inherit";
    else if (!secretsUnsupported && job.secrets && typeof job.secrets === "object") {
      secrets = job.secrets;
    }
    jobs.push({ name, uses, with: withBlock, secrets, secretsUnsupported });
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
