// The Caller templates `init` fills in: which example each flow copies, where
// it lands, and the placeholders in it, each with the exact number of times
// it must appear. A count that does not match means the tag's example
// changed shape, and init fails loudly instead of writing a half-filled
// Caller. scripts/example-placeholders-contract.test.mjs holds this
// repository's examples to the same counts.

export class TemplateError extends Error {}

/** The flows init sets up, keyed by the name `--flows` takes, in the order it writes them. */
export const FLOWS = {
  pipeline: {
    example: "examples/plan-implement-review-caller.yml",
    caller: ".github/workflows/agent-pipeline.yml",
  },
  audit: {
    example: "examples/security-audit-caller.yml",
    caller: ".github/workflows/security-audit.yml",
  },
  "review-response": {
    example: "examples/review-response-caller.yml",
    caller: ".github/workflows/agent-review-response.yml",
  },
};

export const DEFAULT_THREAT_PACK_DIR = ".security";
export const THREAT_PACK_FILES = ["threat-model.md", "findings-ledger.md"];

const VERIFY_LINE =
  /^( *)echo "Provide Consumer verify commands here \(lint\/tests\/typecheck\)\."$/gm;
const SETUP_BLOCK = /^( *)# setup_commands: \|\n\1# {3}set -euo pipefail\n\1# {3}\.\.\.$/gm;
const KIT_PIN =
  /(\/agent-kit\/\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml)@v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?(?=$|[\s"'#])/gm;

const indentLines = (text, indent) =>
  text
    .split("\n")
    .map((line) => (line ? indent + line : ""))
    .join("\n");

/**
 * Each placeholder: what it matches, how many times per flow, and what it
 * becomes. `values` is { actors, tag, defaultBranch, verify, preset,
 * threatPackDir }; `preset` is the preset's text, or null to leave the
 * commented block as it is.
 */
export const PLACEHOLDERS = [
  {
    name: "your-github-login",
    pattern: /your-github-login/g,
    counts: { pipeline: 4, audit: 1, "review-response": 1 },
    replace: (v) => () => v.actors.join('","'),
  },
  {
    name: "the @vX.Y.Z pin of each Agent-kit uses:",
    pattern: KIT_PIN,
    counts: { pipeline: 3, audit: 1, "review-response": 1 },
    replace: (v) => (_, path) => `${path}@${v.tag}`,
  },
  {
    name: '"main" (the default branch)',
    pattern: /"main"/g,
    counts: { pipeline: 2, audit: 0, "review-response": 0 },
    replace: (v) => () => `"${v.defaultBranch}"`,
  },
  {
    name: "the placeholder verify_commands echo line",
    pattern: VERIFY_LINE,
    counts: { pipeline: 1, audit: 0, "review-response": 1 },
    replace: (v) => (_, indent) => indentLines(v.verify, indent),
  },
  {
    name: "the commented `# setup_commands: |` block",
    pattern: SETUP_BLOCK,
    counts: { pipeline: 1, audit: 0, "review-response": 1 },
    replace: (v) => (match, indent) =>
      v.preset === null
        ? match
        : `${indent}setup_commands: |\n${indentLines(v.preset.replace(/\n+$/, ""), `${indent}  `)}`,
  },
  {
    name: '".security/threat-model.md"',
    pattern: /"\.security\/threat-model\.md"/g,
    counts: { pipeline: 0, audit: 1, "review-response": 0 },
    replace: (v) => () => `"${v.threatPackDir}/threat-model.md"`,
  },
  {
    name: '".security/findings-ledger.md"',
    pattern: /"\.security\/findings-ledger\.md"/g,
    counts: { pipeline: 0, audit: 1, "review-response": 0 },
    replace: (v) => () => `"${v.threatPackDir}/findings-ledger.md"`,
  },
];

/** How many times each placeholder appears in `text`, by name. */
export function placeholderCounts(text) {
  return Object.fromEntries(
    PLACEHOLDERS.map((p) => [p.name, [...String(text).matchAll(p.pattern)].length]),
  );
}

/**
 * Fill in the example for `flow`. Throws TemplateError, naming every
 * placeholder whose count is wrong, before replacing anything.
 */
export function renderCaller(flow, text, values) {
  const { example } = FLOWS[flow];
  if (/\r/.test(text)) throw new TemplateError(`${example} has CR line endings`);
  const found = placeholderCounts(text);
  const wrong = PLACEHOLDERS.filter((p) => found[p.name] !== p.counts[flow]).map(
    (p) => `${p.name}: expected ${p.counts[flow]}, found ${found[p.name]}`,
  );
  if (wrong.length) {
    throw new TemplateError(
      `${example} does not have the placeholders this CLI fills in (${wrong.join("; ")}). ` +
        "Use the CLI version that matches the tag, or copy the example by hand.",
    );
  }
  // One pass over the original text: a value written for one placeholder
  // (an actor called main, say) is never matched by a later one.
  const edits = PLACEHOLDERS.filter((p) => p.counts[flow] > 0).flatMap((p) =>
    [...text.matchAll(p.pattern)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      text: p.replace(values)(...m),
    })),
  );
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const e of edits) {
    if (e.start < at) throw new TemplateError(`${example}: two placeholders overlap`);
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}
