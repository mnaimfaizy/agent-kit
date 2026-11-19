// The agent step (#370): the real Claude Code, run in the sandbox after the
// network is cut, with the model proxy as its only route out.
//
// `--bare` skips skill and CLAUDE.md discovery, so the launcher hands the
// agent everything explicitly, in a brief: the security-audit skill's `deep`
// procedure (DEEP.md, with SKILL.md and report-format.md, which it builds
// on), the Threat pack and the Scan recipe, all read at the trusted ref, and
// the sandbox's paths. Claude Code holds only a placeholder API key. Its
// model API base URL is pinned by the launcher's own `--settings`, which
// outrank project settings, and project and local settings are not even
// loaded (`--setting-sources user`), so the scanned repository's
// `.claude/settings.json` cannot point it elsewhere. Web tools are not in
// its tool set, and are denied as well. Its turn limit is the launcher's
// `--max-turns` on the command line (#371).

import { firstLine } from "../exec.mjs";
import { checkSafePath, UnsafePathError } from "../safe-paths.mjs";
import { isMapping, parseYamlSubset, stripBom } from "../yaml-subset.mjs";
import { PLACEHOLDER_API_KEY } from "./credential.mjs";

/** Where a Consumer's security-audit skill lives, as Agent-kit installs it. */
export const SKILL_DIR = ".claude/skills/security-audit";

/** The skill's files the brief hands in, the `deep` procedure among them. */
export const SKILL_FILES = Object.freeze(["DEEP.md", "SKILL.md", "report-format.md"]);

/** The Threat pack's paths when no security-audit Caller names them. */
export const DEFAULT_THREAT_PACK = Object.freeze({
  threatModel: ".security/threat-model.md",
  findingsLedger: ".security/findings-ledger.md",
});

/** The tools the agent has; the web tools are not among them. */
export const AGENT_TOOLS = Object.freeze(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
export const WEB_TOOLS = Object.freeze(["WebFetch", "WebSearch"]);

/**
 * What the agent step's script prints when Claude Code stopped at its turn
 * limit: a fixed line, so nothing of Claude Code's own output leaves the
 * sandbox. It is read from Claude Code's error output (where print mode says
 * "Error: Reached max turns"), never from its answer, which the agent writes.
 */
export const TURNS_MARKER = "agent-kit-deep-scan: Claude Code reached its turn limit";

/** Where the brief goes in the sandbox: the launcher's, outside /workspace. */
export const BRIEF_PATH = "/agent-kit/in/brief.md";

const MAX_HANDED_BYTES = 512 * 1024;
const CALLER_USES = /(^|\/)\.github\/workflows\/security-audit-reusable\.ya?ml(@\S+)?$/;

/**
 * Read what the brief hands the agent at the trusted ref: the skill's files
 * and the Threat pack. Refusal lines when any is missing, so the run stops
 * before any runtime is touched.
 * @param {{ runner: import("../exec.mjs").Runner, root: string, ref: string, branch: string }} opts
 * @returns {{ handIn: HandIn } | { refused: string[] }}
 *
 * @typedef {{
 *   skill: Record<string, string>,
 *   threatModel: { path: string, text: string },
 *   findingsLedger: { path: string, text: string },
 *   from: string | null,
 * }} HandIn
 */
export function readHandIn({ runner, root, ref, branch }) {
  const read = (path) => fileAtRef(runner, root, ref, path);
  const skill = {};
  for (const name of SKILL_FILES) {
    const path = `${SKILL_DIR}/${name}`;
    const r = read(path);
    if ("error" in r) return { refused: [`Could not read ${path} on ${branch}: ${r.error}`] };
    if (r.text === null) {
      return {
        refused: [
          `The security-audit skill on ${branch} has no ${path}, and a Deep scan hands the agent its deep procedure from there.`,
          `Bring the skill up to date on ${branch} (npx @mnaimfaizy/agent-kit upgrade, then commit), then run deep-scan again.`,
        ],
      };
    }
    skill[name] = r.text;
  }

  const caller = threatPackCaller(runner, root, ref);
  if ("error" in caller) {
    return { refused: [`Could not read the workflows on ${branch}: ${caller.error}`] };
  }
  const paths = caller.paths ?? DEFAULT_THREAT_PACK;
  const pack = {};
  for (const [key, path] of Object.entries(paths)) {
    const r = read(path);
    if ("error" in r) return { refused: [`Could not read ${path} on ${branch}: ${r.error}`] };
    if (r.text === null) {
      return {
        refused: [
          `No Threat pack on ${branch}: ${path} is missing${caller.from ? ` (named by ${caller.from})` : ""}. A Deep scan walks the Threat pack's attack paths, so it needs both the threat model and the findings ledger.`,
          `Commit them on ${branch} (agent-kit init writes a skeleton at .security/), then run deep-scan again.`,
        ],
      };
    }
    pack[key] = { path, text: r.text };
  }
  return {
    handIn: {
      skill,
      threatModel: pack.threatModel,
      findingsLedger: pack.findingsLedger,
      from: caller.from,
    },
  };
}

/**
 * A regular file's text at `ref`: null when there is none, else its text.
 * @returns {{ text: string | null } | { error: string }}
 */
function fileAtRef(runner, root, ref, path) {
  const listed = runner("git", ["-C", root, "ls-tree", "--full-tree", "-z", ref, "--", path]);
  if (listed.status !== 0) return { error: firstLine(listed.stderr) || "git ls-tree failed" };
  const entry = listed.stdout.split("\0").find((e) => e.endsWith(`\t${path}`));
  if (!entry) return { text: null };
  const [mode, type, oid] = entry.slice(0, entry.indexOf("\t")).split(" ");
  if (type !== "blob" || mode === "120000") return { error: `${path} is not a regular file` };
  const size = runner("git", ["-C", root, "cat-file", "-s", oid]);
  if (size.status !== 0) return { error: firstLine(size.stderr) || "git cat-file failed" };
  if (Number(size.stdout.trim()) > MAX_HANDED_BYTES) {
    return { error: `${path} is larger than ${MAX_HANDED_BYTES / 1024} KiB` };
  }
  const blob = runner("git", ["-C", root, "cat-file", "blob", oid]);
  if (blob.status !== 0) return { error: firstLine(blob.stderr) || "git cat-file failed" };
  return { text: stripBom(blob.stdout) };
}

/**
 * The Threat pack paths a security-audit Caller at `ref` passes, as the
 * skill finds them in `full`: the first Caller, by file name, that passes
 * both as plain paths. `paths` is null when there is none.
 * @returns {{ paths: { threatModel: string, findingsLedger: string } | null, from: string | null } | { error: string }}
 */
function threatPackCaller(runner, root, ref) {
  const listed = runner("git", [
    "-C",
    root,
    "ls-tree",
    "--full-tree",
    "-z",
    "--name-only",
    ref,
    "--",
    ".github/workflows/",
  ]);
  if (listed.status !== 0) return { error: firstLine(listed.stderr) || "git ls-tree failed" };
  const files = listed.stdout
    .split("\0")
    .filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))
    .sort();
  for (const file of files) {
    const r = fileAtRef(runner, root, ref, file);
    if ("error" in r || r.text === null) continue;
    let doc;
    try {
      doc = parseYamlSubset(r.text);
    } catch {
      continue;
    }
    const jobs = isMapping(doc.jobs) ? doc.jobs : {};
    for (const job of Object.values(jobs)) {
      if (!isMapping(job) || typeof job.uses !== "string" || !CALLER_USES.test(job.uses.trim())) {
        continue;
      }
      const given = isMapping(job.with) ? job.with : {};
      const threatModel = plainPath(given.threat_model_path);
      const findingsLedger = plainPath(given.findings_ledger_path);
      if (threatModel && findingsLedger) {
        return { paths: { threatModel, findingsLedger }, from: file };
      }
    }
  }
  return { paths: null, from: null };
}

/** A repository-relative path given as a plain value (no expression), or null. */
function plainPath(value) {
  if (typeof value !== "string" || value.includes("${{")) return null;
  try {
    return checkSafePath(value.trim().replace(/^\.\//, ""), "a Threat pack path");
  } catch (e) {
    if (e instanceof UnsafePathError) return null;
    throw e;
  }
}

/**
 * The brief the launcher hands the agent on stdin: what DEEP.md's step 1
 * calls the launcher's brief.
 * @param {{
 *   branch: string,
 *   short: string,
 *   recipePath: string,
 *   recipeText: string,
 *   handIn: HandIn,
 *   grounding: Array<{ source: string, at: string }>,
 *   paths: { workspace: string, grounding: string, report: string },
 * }} opts
 */
export function agentBrief({ branch, short, recipePath, recipeText, handIn, grounding, paths }) {
  const fence = (text) => {
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
    const ticks = "`".repeat(longest + 1);
    return [ticks, text.replace(/\n$/, ""), ticks];
  };
  const groundingLines = grounding.length
    ? grounding.map((g) => `- ${g.source}: ${g.at}`)
    : ["- (none: the Scan recipe lists no grounding)"];
  return [
    "# Deep scan brief, from the agent-kit deep-scan launcher",
    "",
    "This is the launcher's brief. You are running inside the closed, disposable sandbox that `agent-kit deep-scan` started for a Deep scan: run the security-audit skill in `deep` mode, by the procedure below. Your only network route is the launcher's model proxy, and the web tools (WebFetch, WebSearch) are off.",
    "",
    "## Where things are",
    "",
    `- The repository: \`${paths.workspace}\`, an export of \`${branch}\` at ${short} (the trusted ref). Scan the whole repository.`,
    `- The grounding, at \`${paths.grounding}\`, copied in or fetched on the host before you entered:`,
    ...groundingLines.map((l) => `  ${l}`),
    `- The report: write it to \`${paths.report}\`, early, and update it as each finding lands. It is the only file that leaves the sandbox.`,
    "- The launcher already ran the Scan recipe's `setup`, `start`, `ready` and `seed`: the services it starts are running. Do not run them again.",
    "",
    `## The deep procedure: ${SKILL_DIR}/DEEP.md`,
    "",
    `It refers to SKILL.md and report-format.md, given after it. Read every link in it as relative to \`${paths.workspace}/${SKILL_DIR}/\`.`,
    "",
    ...fence(handIn.skill["DEEP.md"]),
    "",
    `## ${SKILL_DIR}/SKILL.md`,
    "",
    ...fence(handIn.skill["SKILL.md"]),
    "",
    `## ${SKILL_DIR}/report-format.md`,
    "",
    ...fence(handIn.skill["report-format.md"]),
    "",
    `## The Threat pack${handIn.from ? ` (paths from ${handIn.from})` : ""}`,
    "",
    `### Threat model: ${handIn.threatModel.path}`,
    "",
    ...fence(handIn.threatModel.text),
    "",
    `### Findings ledger: ${handIn.findingsLedger.path}`,
    "",
    ...fence(handIn.findingsLedger.text),
    "",
    `## The Scan recipe: ${recipePath}`,
    "",
    "Its entry points (each with its note) are what you may probe, its fixtures are the test users and roles to probe with (fake values), its grounding is listed above, and its notes say what stays static-only.",
    "",
    ...fence(recipeText),
    "",
  ].join("\n");
}

/**
 * The launcher's own settings for the sandboxed Claude Code: the model API
 * base URL pinned to the proxy, and the web tools denied.
 * @param {string} baseUrl  the model proxy, as the sandbox reaches it
 */
export function agentSettings(baseUrl) {
  return {
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    permissions: { allow: [...AGENT_TOOLS], deny: [...WEB_TOOLS] },
  };
}

/** The agent's environment: the placeholder key, never the real one. */
export const AGENT_ENV = Object.freeze([
  `ANTHROPIC_API_KEY=${PLACEHOLDER_API_KEY}`,
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
]);

/**
 * The agent step's script, run with `sh -c` in the sandbox: Claude Code in
 * print mode, its brief on stdin, its own output kept in the sandbox (its
 * error output is passed on too), and TURNS_MARKER when it stopped at the
 * launcher's turn limit.
 * @param {{ baseUrl: string, report: string, workspace: string, maxTurns: number }} opts
 */
export function agentScript({ baseUrl, report, workspace, maxTurns }) {
  const args = [
    "claude",
    "--bare",
    "--print",
    "--settings",
    JSON.stringify(agentSettings(baseUrl)),
    "--setting-sources",
    "user",
    "--tools",
    AGENT_TOOLS.join(","),
    "--allowedTools",
    AGENT_TOOLS.join(","),
    "--disallowedTools",
    WEB_TOOLS.join(","),
    "--permission-mode",
    "dontAsk",
    "--add-dir",
    "/agent-kit",
    "--no-session-persistence",
    "--max-turns",
    String(maxTurns),
  ];
  const outDir = report.slice(0, report.lastIndexOf("/"));
  return [
    "set -eu",
    `mkdir -p ${outDir} /agent-kit/logs`,
    `cd ${workspace}`,
    "status=0",
    `${args.map(shQuote).join(" ")} < ${BRIEF_PATH} > /agent-kit/logs/agent.log 2> /agent-kit/logs/agent.err || status=$?`,
    "cat /agent-kit/logs/agent.err >&2",
    `if grep -q '^Error: Reached max turns' /agent-kit/logs/agent.err; then echo ${shQuote(TURNS_MARKER)}; fi`,
    'exit "$status"',
  ].join("\n");
}

/** A word quoted for `sh`. */
function shQuote(s) {
  return /^[A-Za-z0-9_./:,=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
