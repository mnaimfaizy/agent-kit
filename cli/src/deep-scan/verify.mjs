// The Verification run (#372): `deep-scan --verify <file> --ref <ref>`
// re-attempts the Reproduction of known findings on a ref the maintainer
// chose, to check whether a fix holds. It is local only (refused in CI, where
// a concept id under response would enter a log), and confirm-only: the
// agent is handed the Verification-run procedure from DEEP.md, not the full
// deep procedure, and the finding file. The report stays on the machine.
//
// This module reads and checks the finding file on the host, cuts the
// Verification-run procedure out of DEEP.md, writes the agent's brief, and
// checks the report that comes out against the findings given.

import { existsSync, readFileSync, statSync } from "node:fs";
import { CLI_VERSION } from "../tags.mjs";
import { stripBom } from "../yaml-subset.mjs";
import {
  DISCOVERED,
  fence,
  groundingLines,
  SETUP_DONE,
  SKILL_DIR,
  threatPackAndRecipe,
} from "./agent.mjs";

export const VERIFY_DOCS_URL = `https://github.com/mnaimfaizy/agent-kit/blob/v${CLI_VERSION}/docs/security-audit.md#verification-run`;

/** Where the finding file goes in the sandbox, beside the brief. */
export const FINDINGS_PATH = "/agent-kit/in/findings.md";

export const MAX_FINDING_FILE_BYTES = 512 * 1024;

/** A concept id as report-format.md gives it: kebab-case. */
const CONCEPT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A ref as `--ref` takes it: no option, no space, no control character. */
export const REF_NAME = /^[^\s\x00-\x1f\x7f-][^\s\x00-\x1f\x7f]*$/;

const FIELD = /^[ \t]*[-*][ \t]+\*\*([A-Za-z ]+):\*\*[ \t]*(.*)$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Markdown's `###` sections, outside code fences, each with its fields
 * (`- **Name:** value`), keyed by name.
 * @returns {Array<{ heading: string, fields: Record<string, string> }>}
 */
function sections(text) {
  const out = [];
  let open = null;
  for (const line of text.split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (open !== null) {
      if (f && f[1][0] === open[0] && f[1].length >= open.length) open = null;
      continue;
    }
    if (f) {
      open = f[1];
      continue;
    }
    const h = /^(#{1,3})[ \t]+(.*)$/.exec(line);
    if (h) {
      out.push({ heading: h[2].trim(), fields: {}, level: h[1].length });
      continue;
    }
    const m = FIELD.exec(line);
    const current = out.at(-1);
    if (m && current && current.level === 3 && !(m[1] in current.fields)) {
      current.fields[m[1]] = m[2].trim();
    }
  }
  return out.filter((s) => s.level === 3);
}

/** A field's value without the backticks around it: its first `code span`, if any. */
const unquote = (value) => /`([^`]*)`/.exec(value)?.[1].trim() ?? value.trim();

/**
 * Read and check the finding file on the host, before anything runs.
 * @param {string} file  an absolute path
 * @returns {{ findings: Finding[], data: Buffer } | { refused: string[] }}
 *
 * @typedef {{ conceptId: string, location: string }} Finding
 */
export function readFindingFile(file) {
  const cannot = (why) => ({ refused: [`Cannot read the finding file ${file}: ${why}.`] });
  if (!existsSync(file)) return cannot("it does not exist");
  let data;
  try {
    const st = statSync(file);
    if (!st.isFile()) return cannot("it is not a regular file");
    if (st.size > MAX_FINDING_FILE_BYTES) {
      return cannot(`it is larger than ${MAX_FINDING_FILE_BYTES / 1024} KiB`);
    }
    data = readFileSync(file);
    // It may have grown since the stat: what goes in is what was checked.
    if (data.length > MAX_FINDING_FILE_BYTES) {
      return cannot(`it is larger than ${MAX_FINDING_FILE_BYTES / 1024} KiB`);
    }
  } catch (e) {
    return cannot(e?.code ?? e?.message ?? String(e));
  }
  let text;
  try {
    text = stripBom(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    text = null;
  }
  if (text === null || text.includes("\0")) return cannot("it is not text (UTF-8 Markdown)");

  const problems = [];
  const findings = [];
  const seen = new Set();
  for (const { heading, fields } of sections(text)) {
    if (!("Concept id" in fields)) continue;
    const conceptId = unquote(fields["Concept id"]);
    if (!CONCEPT_ID.test(conceptId)) {
      problems.push(
        `${heading}: its concept id ${JSON.stringify(conceptId)} is not kebab-case (lowercase letters and digits, joined by -).`,
      );
      continue;
    }
    const name = `\`${conceptId}\` (${heading})`;
    for (const field of ["Location", "Observation"]) {
      if (!fields[field]) problems.push(`${name} has no ${field}.`);
    }
    if (seen.has(conceptId)) problems.push(`\`${conceptId}\` is given more than once.`);
    seen.add(conceptId);
    findings.push({ conceptId, location: fields.Location ?? "" });
  }
  if (!findings.length && !problems.length) {
    return {
      refused: [
        `The finding file ${file} has no findings. A Verification run needs at least one \`###\` finding with a **Concept id**, a **Location** and an **Observation**, as a deep report gives them.`,
      ],
    };
  }
  if (problems.length) {
    return {
      refused: [
        `The finding file ${file} is not in the expected shape:`,
        ...problems.map((p) => `  - ${p}`),
        "Each finding is a `###` section with `- **Concept id:**`, `- **Location:**` and `- **Observation:**` lines, as a deep report gives them.",
      ],
    };
  }
  return { findings, data };
}

/**
 * The Verification-run procedure, cut from DEEP.md: its hard rules, the
 * procedure steps the Verification run section keeps (1, 2 and 6), and that
 * section. Null for each part DEEP.md lacks, named in `missing`.
 * @returns {{ procedure: string } | { missing: string[] }}
 */
export function verificationProcedure(deepMd) {
  const parts = new Map();
  for (const chunk of lfOf(deepMd).split(/^(?=## )/m)) {
    const title = /^## (.+)$/m.exec(chunk)?.[1].trim();
    if (title) parts.set(title, chunk.replace(/\n+$/, "\n"));
  }
  const missing = ["Hard rules", "Procedure", "Verification run"].filter((t) => !parts.has(t));
  if (missing.length) return { missing };
  const items = [];
  for (const line of parts.get("Procedure").split("\n").slice(1)) {
    const n = /^(\d+)\.[ \t]/.exec(line);
    if (n) items.push({ n: Number(n[1]), lines: [line] });
    else if (items.length) items.at(-1).lines.push(line);
  }
  const kept = items.filter((i) => [1, 2, 6].includes(i.n));
  if (kept.length !== 3) return { missing: ["Procedure steps 1, 2 and 6"] };
  const steps = kept.map((i) => i.lines.join("\n").replace(/\n+$/, "")).join("\n");
  return {
    procedure: [
      parts.get("Hard rules").trimEnd(),
      "",
      "## Procedure (the steps a Verification run keeps)",
      "",
      steps,
      "",
      parts.get("Verification run").trimEnd(),
      "",
    ].join("\n"),
  };
}

const lfOf = (text) => text.replace(/\r\n?/g, "\n");

/**
 * The brief for a Verification run: confirm-only, on the ref the maintainer
 * named, with the finding file.
 * @param {{
 *   ref: string,
 *   short: string,
 *   findings: Finding[],
 *   procedure: string,
 *   recipePath: string,
 *   recipeText: string,
 *   handIn: import("./agent.mjs").HandIn,
 *   grounding: Array<{ source: string, at: string }>,
 *   paths: { workspace: string, grounding: string, report: string },
 *   discovers?: boolean,
 * }} opts  `discovers`: Claude Code runs without `--bare` (the
 *   subscription path), so the brief says what it discovers.
 */
export function verificationBrief({
  ref,
  short,
  findings,
  procedure,
  recipePath,
  recipeText,
  handIn,
  grounding,
  paths,
  discovers = false,
}) {
  return [
    "# Verification run brief, from the agent-kit deep-scan launcher",
    "",
    "This is the launcher's brief. You are running inside the closed, disposable sandbox that `agent-kit deep-scan --verify` started for a Verification run: re-attempt the Reproduction of each finding in the finding file, by the Verification-run procedure below, and nothing more. Your only network route is the launcher's model proxy, and the web tools (WebFetch, WebSearch) are off.",
    "",
    "## Where things are",
    "",
    `- The repository: \`${paths.workspace}\`, an export of \`${ref}\` at ${short}, the ref the maintainer chose to verify (name it as the report's Scope).`,
    `- The finding file: \`${FINDINGS_PATH}\`. Its findings, in the order to report them:`,
    ...findings.map((f) => `  - \`${f.conceptId}\` at ${f.location}`),
    ...groundingLines(grounding, paths),
    `- The report: write it to \`${paths.report}\`, in the Verification-run variant of the report format below, early, and update it as each answer lands. It is the only file that leaves the sandbox.`,
    SETUP_DONE,
    ...(discovers ? [DISCOVERED] : []),
    "",
    `## The Verification-run procedure, from ${SKILL_DIR}/DEEP.md`,
    "",
    `Read every link in it as relative to \`${paths.workspace}/${SKILL_DIR}/\`.`,
    "",
    ...fence(procedure),
    "",
    `## ${SKILL_DIR}/report-format.md`,
    "",
    "Use its Verification-run variant.",
    "",
    ...fence(handIn.skill["report-format.md"]),
    "",
    ...threatPackAndRecipe({ handIn, recipePath, recipeText }),
  ].join("\n");
}

/**
 * Check a Verification run's report against the findings given: the
 * variant's Mode line, and a `Reproduced: yes | no` entry for each.
 * @param {string} text
 * @param {Finding[]} findings
 * @returns {{ answers: Array<{ conceptId: string, reproduced: string }>, problems: string[] }}
 */
export function checkVerificationReport(text, findings) {
  const problems = [];
  if (!/^[ \t]*[-*][ \t]+\*\*Mode:\*\*[ \t]*deep \(Verification run\)[ \t]*$/m.test(text)) {
    problems.push("it has no `- **Mode:** deep (Verification run)` line");
  }
  const entries = new Map();
  for (const { heading, fields } of sections(text)) {
    const id = unquote(heading);
    if (!entries.has(id)) entries.set(id, fields);
  }
  const answers = [];
  for (const { conceptId } of findings) {
    const fields = entries.get(conceptId);
    const reproduced = /^(yes|no)\b/.exec(fields?.Reproduced ?? "")?.[1];
    if (!fields) problems.push(`it has no entry for \`${conceptId}\``);
    else if (!reproduced) problems.push(`\`${conceptId}\`'s entry has no Reproduced: yes or no`);
    else answers.push({ conceptId, reproduced });
  }
  return { answers, problems };
}
