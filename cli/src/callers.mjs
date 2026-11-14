// Reads a Consumer's Caller workflows: the jobs that `uses:` an Agent-kit
// reusable workflow, the secrets they pass, the repository variables they
// read, and their Trigger labels.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseScalar, parseYamlSubset, stripBom, stripComment } from "./yaml-subset.mjs";

export const KIT_REPO_NAME = "agent-kit";
export const DEFAULT_KIT_REPO = "mnaimfaizy/agent-kit";

// owner/agent-kit/.github/workflows/<file>@<ref>. GitHub owner and repository
// names are case-insensitive, so the match is too.
const KIT_USES =
  /^([A-Za-z0-9][A-Za-z0-9-]*)\/(agent-kit)\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)@(\S+)$/i;
// `uses:`, `"uses":`, `'uses' :`, optionally as a list item.
const USES_LINE = /^\s*(?:-\s+)?(?:uses|"uses"|'uses')\s*:\s*(.+)$/;
const NAME = "[A-Za-z_][A-Za-z0-9_]*";

/** Parse a `uses:` value; null unless it points at an Agent-kit reusable workflow. */
export function parseKitUses(value) {
  const m = KIT_USES.exec(parseScalar(stripComment(String(value))));
  return m ? { owner: m[1], repo: `${m[1]}/${m[2]}`, file: m[3], ref: m[4] } : null;
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
  stripBom(String(text))
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

export class PinRewriteError extends Error {}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Point every Agent-kit `uses:` pin in `text` at `newRef`. Only the `@ref`
 * of each pin line changes: every other byte of the file, the line endings
 * and a byte-order mark included, stays as it was. Throws PinRewriteError
 * when a pin line cannot be rewritten unambiguously.
 *
 * @returns {{ text: string, count: number }}
 */
export function rewriteKitPins(text, newRef) {
  const pins = findKitPins(text);
  if (pins.length === 0) return { text, count: 0 };
  // Split the raw text the way findKitPins numbers lines (\r\n, \r or \n),
  // keeping each separator so the file is rebuilt byte for byte.
  const parts = String(text).split(/(\r\n|\r|\n)/);
  let count = 0;
  for (const pin of pins) {
    const idx = (pin.line - 1) * 2;
    const line = parts[idx];
    const re = new RegExp(
      `(/${escapeRegExp(pin.file)}@)${escapeRegExp(pin.ref)}(?=$|[\\s"'#])`,
      "g",
    );
    const matches = [...line.matchAll(re)];
    if (matches.length !== 1) {
      throw new PinRewriteError(
        `line ${pin.line}: cannot find exactly one ${pin.file}@${pin.ref} to rewrite`,
      );
    }
    parts[idx] = line.replace(re, (_, prefix) => `${prefix}${newRef}`);
    if (parts[idx] !== line) count++;
  }
  return { text: parts.join(""), count };
}

function lines(text) {
  return stripBom(String(text))
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
 * (the Kill switch variables: unset means the flow never runs). The `||` may
 * follow closing parentheses, and may sit on the next line of a multi-line
 * expression.
 */
export function variableRefs(text) {
  const refs = new Map();
  const re = new RegExp(`vars\\.(${NAME})((?:\\s*\\))*\\s*\\|\\|)?`, "g");
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

/**
 * The input names of a workflow's `workflow_dispatch` trigger: [] when it
 * takes none, null when the workflow has no such trigger. `on:` may be a
 * mapping, one event name, or a list of names.
 */
function dispatchInputs(on) {
  const named = (text) => /(?:^|[\s,[])workflow_dispatch(?:$|[\s,\]])/.test(text);
  if (typeof on === "string") return named(on) ? [] : null;
  if (!on || typeof on !== "object") return null;
  if (on.$seq) return on.$seq.some((line) => named(String(line))) ? [] : null;
  if (!("workflow_dispatch" in on)) return null;
  const trigger = on.workflow_dispatch;
  const inputs = trigger && typeof trigger === "object" && !trigger.$seq ? trigger.inputs : null;
  return inputs && typeof inputs === "object" && !inputs.$seq ? Object.keys(inputs) : [];
}

/**
 * The jobs of one workflow file that call an Agent-kit reusable workflow.
 * `parseIncomplete` is set when the file has more Agent-kit pins than jobs
 * the parser could read, so checks built on the jobs report it instead of
 * passing.
 */
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
  const pins = findKitPins(text);
  const parseIncomplete =
    pins.length > jobs.length
      ? `${pins.length} Agent-kit pin(s) but only ${jobs.length} job(s) doctor could read; ` +
        "the rest were not checked"
      : null;
  return {
    jobs,
    pins,
    variables: variableRefs(text),
    dispatchInputs: dispatchInputs(doc.on),
    parseIncomplete,
  };
}

/** Workflow files in .github/workflows/ (relative paths, sorted). */
export class WorkflowsDirError extends Error {}

export function listWorkflowFiles(repoRoot) {
  const dir = join(repoRoot, ".github", "workflows");
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) {
    throw new WorkflowsDirError(
      ".github/workflows is not a folder, so there are no Callers to read.",
    );
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => `.github/workflows/${e.name}`)
    .sort();
}

/** Read every workflow file; `callers` are the ones with at least one Agent-kit pin. */
export function readWorkflows(repoRoot) {
  const files = listWorkflowFiles(repoRoot).map((path) => {
    const text = stripBom(readFileSync(join(repoRoot, path), "utf8"));
    return { path, text, ...parseCaller(text) };
  });
  return { files, callers: files.filter((f) => f.pins.length > 0) };
}
