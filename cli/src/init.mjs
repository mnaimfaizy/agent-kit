// `agent-kit init --tag vX`: adopt Agent-kit in a Consumer from one tag. It
// copies the Kit-owned paths, writes a Caller per chosen flow from the tag's
// examples/ with its placeholders filled in, writes the Threat pack skeleton
// and (if there is none) .github/dependabot.yml, then prints the GitHub-side
// steps as `gh` commands for the Consumer to run. It writes only local files.
//
// Plan first, then write: every file is read and every refusal checked
// before anything on disk changes.

import { join } from "node:path";
import { DEFAULT_KIT_REPO } from "./callers.mjs";
import { command } from "./checks/result.mjs";
import { formatResult } from "./doctor.mjs";
import { firstLine } from "./exec.mjs";
import { EXECUTABLE_MODE, openKitTag, PreManifestTagError, serverFromEnv } from "./kit-tag.mjs";
import {
  applyPlan,
  checkDeletable,
  checkLocalPath,
  kitFileWrites,
  lstatOrNull,
  Refusal,
  stageExecutableBits,
} from "./local-writes.mjs";
import { caseCollisions, checkSafePath } from "./safe-paths.mjs";
import { isReleaseTag } from "./tags.mjs";
import {
  DEFAULT_THREAT_PACK_DIR,
  FLOWS,
  renderCaller,
  TemplateError,
  THREAT_PACK_FILES,
} from "./templates.mjs";
import { checksAfterWrite } from "./upgrade.mjs";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const PRESET = /^[a-z0-9][a-z0-9-]*$/;
// Tab and newline are allowed in --verify; every other control character is not.
// eslint-disable-next-line no-control-regex
const VERIFY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const DEPENDABOT_FILES = [".github/dependabot.yml", ".github/dependabot.yaml"];
const MAX_LISTED = 20;

export const DEPENDABOT_BLOCK = `version: 2
updates:
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "*"
        versions:
          - "*-alpha.*"
          - "*-beta.*"
          - "*-rc.*"
`;

const LABELS = [
  ["agent:plan", "1D76DB", "Agent-kit: plan this issue"],
  ["agent:implement", "0E8A16", "Agent-kit: implement the Verified plan"],
  ["agent:review", "5319E7", "Agent-kit: review this PR"],
];

/** The `init` answers, as flags name them, with what each one asks. */
export const QUESTIONS = [
  { key: "tag", flag: "--tag <vX>", ask: "Agent-kit tag to adopt (for example v1.0.0)" },
  { key: "flows", flag: "--flows pipeline,audit", ask: "Flows to set up (pipeline, audit)" },
  { key: "actors", flag: "--actors <login,...>", ask: "GitHub logins allowed to trigger runs" },
  { key: "defaultBranch", flag: "--default-branch <name>", ask: "Default branch" },
  {
    key: "verify",
    flag: "--verify <commands>",
    ask: "verify_commands (lint/tests/typecheck; use \\n between commands)",
    only: "pipeline",
  },
  {
    key: "preset",
    flag: "--preset <name|none>",
    ask: "setup_commands preset (python, node, mixed, redis-service, or none)",
    only: "pipeline",
  },
  {
    key: "threatPackDir",
    flag: "--threat-pack-dir <dir>",
    ask: "Folder for the Threat pack",
    only: "audit",
  },
];

/** Answers with a default: asked about only on a terminal, never required. */
const DEFAULTS = { preset: "none", threatPackDir: DEFAULT_THREAT_PACK_DIR };

const split = (s) =>
  String(s)
    .split(/[\s,]+/)
    .filter(Boolean);

/**
 * Check and normalise one answer. Returns { value } or { error }.
 */
export function parseAnswer(key, raw) {
  const s = String(raw ?? "");
  switch (key) {
    case "tag":
      return isReleaseTag(s)
        ? { value: s }
        : {
            error: `--tag must be a Release-line tag (vX.Y.Z or vX.Y.Z-stage.N), got ${JSON.stringify(s)}`,
          };
    case "flows": {
      const flows = [...new Set(split(s))];
      const bad = flows.filter((f) => !(f in FLOWS));
      if (flows.length === 0 || bad.length) {
        return { error: `--flows takes pipeline and/or audit, got ${JSON.stringify(s)}` };
      }
      return { value: Object.keys(FLOWS).filter((f) => flows.includes(f)) };
    }
    case "actors": {
      const actors = [...new Set(split(s))];
      const bad = actors.filter((a) => !LOGIN.test(a));
      if (actors.length === 0 || bad.length) {
        return { error: `--actors takes GitHub logins, got ${JSON.stringify(bad[0] ?? s)}` };
      }
      return { value: actors };
    }
    case "defaultBranch":
      return BRANCH.test(s) && !s.includes("..") && !/\.lock(?:\/|$)/.test(s) && !s.endsWith(".")
        ? { value: s }
        : { error: `--default-branch is not a branch name this CLI accepts: ${JSON.stringify(s)}` };
    case "verify": {
      const v = s
        .replace(/\r\n?/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/^\n+|\s+$/g, "");
      if (!v.trim()) return { error: "--verify must not be empty" };
      if (VERIFY_CONTROL.test(v)) return { error: "--verify contains a control character" };
      return { value: v };
    }
    case "preset":
      if (s === "none") return { value: null };
      return PRESET.test(s)
        ? { value: s }
        : { error: `--preset takes a preset name or none, got ${JSON.stringify(s)}` };
    case "threatPackDir": {
      const dir = s.replace(/\/+$/, "");
      try {
        checkSafePath(dir, "--threat-pack-dir");
      } catch (err) {
        return { error: err.message };
      }
      if (dir === ".github/workflows" || dir.startsWith(".github/workflows/")) {
        return { error: "--threat-pack-dir must not be inside .github/workflows" };
      }
      return { value: dir };
    }
    default:
      throw new Error(`unknown answer ${key}`);
  }
}

/**
 * Gather every answer from flags, then (on a terminal, without --yes) by
 * asking. Returns { answers } or { missing: [flags] } or { error }.
 *
 * @param {{ flags: Record<string, string | undefined>, prompt: ((q: string) => Promise<string>) | null, yes: boolean, defaultBranch: string }} opts
 */
export async function collectAnswers({ flags, prompt, yes, defaultBranch }) {
  const interactive = Boolean(prompt) && !yes;
  const answers = {};
  const missing = [];
  for (const q of QUESTIONS) {
    if (q.only && answers.flows && !answers.flows.includes(q.only)) continue;
    let raw = flags[q.key];
    const fallback = q.key === "defaultBranch" ? defaultBranch : DEFAULTS[q.key];
    if (raw === undefined && interactive) {
      const hint = fallback !== undefined ? ` [${fallback}]` : "";
      raw = (await prompt(`${q.ask}${hint}: `)) || fallback;
    }
    if (raw === undefined) raw = fallback;
    if (raw === undefined || raw === "") {
      missing.push(q.flag);
      continue;
    }
    const parsed = parseAnswer(q.key, raw);
    if (parsed.error) return { error: parsed.error };
    answers[q.key] = parsed.value;
  }
  if (missing.length) return { missing };
  return { answers };
}

/** The default branch to suggest: origin's HEAD, else the current branch, else main. */
export function detectDefaultBranch(runner, cwd) {
  for (const args of [
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
  ]) {
    const r = runner("git", ["-C", cwd, ...args]);
    const name = r.status === 0 ? r.stdout.trim().replace(/^origin\//, "") : "";
    if (name && parseAnswer("defaultBranch", name).value) return name;
  }
  return "main";
}

/** Text from the tag that will be inlined into YAML or written as a file. */
function tagText(snap, path) {
  const text = snap.readFile(path);
  if (text === null) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\r�]|[\u0000-\u0008\u000b-\u001f]/.test(text)) {
    throw new Refusal(`${path} at ${snap.tag} is not plain UTF-8 text with LF line endings.`);
  }
  return text;
}

function presetText(snap, name) {
  const path = `examples/setup-presets/${name}.sh`;
  const text = tagText(snap, path);
  if (text === null) {
    let known = [];
    try {
      known = snap
        .listFiles("examples/setup-presets/")
        .map((f) => f.path.replace(/^.*\//, "").replace(/\.sh$/, ""));
    } catch {
      // listed below as unknown
    }
    throw new Refusal(
      `${snap.tag} has no setup preset ${JSON.stringify(name)}` +
        (known.length ? `; it has: ${known.join(", ")}, or none.` : "."),
    );
  }
  // The same rules scripts/setup-presets-contract.test.py holds presets to.
  if (text.includes("${{") || text.includes("<<")) {
    throw new Refusal(`${path} at ${snap.tag} cannot be inlined into setup_commands safely.`);
  }
  return text;
}

/**
 * Work out everything init would write and throw Refusal for anything that
 * stops it. Touches nothing on disk.
 */
export function planInit({ root, snap, answers, force }) {
  const { tag } = snap;
  const conflicts = [];
  const deletes = [];
  const writes = [];
  const notes = [];
  const exists = (rel) => lstatOrNull(join(root, rel)) !== null;

  // Kit-owned paths: copied whole. An existing one is an earlier adoption.
  for (const p of snap.kitOwnedPaths) {
    const rel = p.replace(/\/$/, "");
    checkLocalPath(root, rel);
    if (exists(rel)) {
      if (!force) conflicts.push(`${p} (Kit-owned path)`);
      else {
        checkDeletable(root, rel);
        deletes.push(rel);
      }
    }
  }
  writes.push(...kitFileWrites(snap));

  const dir = answers.threatPackDir ?? DEFAULT_THREAT_PACK_DIR;
  const kitOwned = snap.kitOwnedPaths.find(
    (p) => `${dir}/`.startsWith(p) || p.startsWith(`${dir}/`),
  );
  if (answers.flows.includes("audit") && kitOwned) {
    throw new Refusal(
      `--threat-pack-dir ${dir} overlaps the Kit-owned path ${kitOwned}, which upgrade replaces.`,
    );
  }

  const values = {
    actors: answers.actors,
    tag,
    defaultBranch: answers.defaultBranch,
    verify: answers.verify ?? "",
    preset: answers.preset ? presetText(snap, answers.preset) : null,
    threatPackDir: dir,
  };
  for (const flow of answers.flows) {
    const { example, caller } = FLOWS[flow];
    const text = tagText(snap, example);
    if (text === null) throw new Refusal(`${tag} has no ${example}.`);
    let rendered;
    try {
      rendered = renderCaller(flow, text, values);
    } catch (err) {
      if (err instanceof TemplateError) throw new Refusal(err.message);
      throw err;
    }
    checkLocalPath(root, caller);
    if (exists(caller)) conflicts.push(`${caller} (Caller)`);
    writes.push({ path: caller, bytes: Buffer.from(rendered, "utf8") });
  }

  if (answers.flows.includes("audit")) {
    const files = THREAT_PACK_FILES.map((f) => [f, tagText(snap, `examples/threat-pack/${f}`)]);
    if (files.some(([, text]) => text === null)) {
      notes.push(
        `${tag} has no examples/threat-pack/, so no Threat pack was written: create ` +
          `${dir}/threat-model.md and ${dir}/findings-ledger.md by hand (Getting started, step 7).`,
      );
    } else {
      for (const [f, text] of files) {
        const path = `${dir}/${f}`;
        checkLocalPath(root, path);
        if (exists(path)) conflicts.push(`${path} (Threat pack)`);
        writes.push({ path, bytes: Buffer.from(text, "utf8") });
      }
    }
  }

  const dependabot = DEPENDABOT_FILES.find(exists) ?? null;
  if (!dependabot) {
    checkLocalPath(root, DEPENDABOT_FILES[0]);
    writes.push({ path: DEPENDABOT_FILES[0], bytes: Buffer.from(DEPENDABOT_BLOCK, "utf8") });
  }

  if (conflicts.length && !force) {
    throw new Refusal(
      `${conflicts.length} path(s) init would write already exist, and init does not overwrite them. ` +
        `To move an existing adoption to another tag, run \`npx @mnaimfaizy/agent-kit upgrade --tag ${tag}\`; ` +
        "to overwrite anyway, run init again with --force.",
      [...conflicts.slice(0, MAX_LISTED), ...(conflicts.length > MAX_LISTED ? ["…"] : [])],
    );
  }
  const clash = caseCollisions(writes.map((w) => w.path));
  if (clash.length) {
    throw new Refusal(`Two files differ only in case: ${clash[0].join(" and ")}.`);
  }
  return { deletes, writes, conflicts, notes, dependabot };
}

/**
 * The GitHub-side steps init does not take, as POSIX-shell commands built
 * with checks/result.mjs `command()` (every argument fixed or allowlisted).
 */
export function manualSteps({ flows, tag, repo, serverUrl }) {
  const lines = [];
  const step = (title, ...cmds) => {
    lines.push(title);
    for (const c of cmds) lines.push(`  $ ${c}`);
  };
  step(
    "1. Secrets (gh asks for each value; CLAUDE_CODE_OAUTH_TOKEN comes from `claude setup-token`):",
    command("gh", "secret", "set", "CLAUDE_CODE_OAUTH_TOKEN"),
    ...(flows.includes("audit")
      ? [command("gh", "secret", "set", "AGENT_KIT_ADVISORIES_TOKEN")]
      : []),
  );
  if (flows.includes("pipeline")) {
    step(
      "2. Trigger labels:",
      ...LABELS.map(([name, color, description]) =>
        command("gh", "label", "create", name, "--color", color, "--description", description),
      ),
    );
    lines.push(
      "3. Install the Claude GitHub App on this repository: https://github.com/apps/claude",
    );
  }
  step(
    `${flows.includes("pipeline") ? "4" : "2"}. Rulesets the Claude GitHub App cannot bypass: list yours, then follow ` +
      `${serverUrl}/${repo}/blob/${tag}/docs/repository-hardening.md`,
    command("gh", "api", "repos/{owner}/{repo}/rulesets"),
  );
  step(
    `${flows.includes("pipeline") ? "5" : "3"}. Last, after you have reviewed and pushed the Callers, turn the flows on (Kill switch variables):`,
    ...(flows.includes("pipeline")
      ? [command("gh", "variable", "set", "CLAUDE_PIPELINE_ENABLED", "--body", "true")]
      : []),
    ...(flows.includes("audit")
      ? [command("gh", "variable", "set", "CLAUDE_SECURITY_AUDIT_ENABLED", "--body", "true")]
      : []),
  );
  return lines;
}

/**
 * @param {{
 *   cwd: string,
 *   runner: import("./exec.mjs").Runner,
 *   flags: Record<string, string | undefined>,
 *   force?: boolean,
 *   yes?: boolean,
 *   prompt?: ((question: string) => Promise<string>) | null,
 *   confirm?: ((question: string) => Promise<boolean>) | null,
 *   out: (text: string) => void,
 *   err: (text: string) => void,
 *   openTag?: typeof openKitTag,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 * @returns {Promise<number>} exit code
 */
export async function runInit({
  cwd,
  runner,
  flags,
  force = false,
  yes = false,
  prompt = null,
  confirm = null,
  out,
  err,
  openTag = openKitTag,
  env = process.env,
}) {
  const refuse = (e) => {
    out(`REFUSED  ${e.message}`);
    for (const d of e.details ?? []) out(`      ${d}`);
    out("Nothing was changed.");
    return 1;
  };

  const collected = await collectAnswers({
    flags,
    prompt,
    yes,
    defaultBranch: detectDefaultBranch(runner, cwd),
  });
  if (collected.error) {
    err(collected.error);
    return 2;
  }
  if (collected.missing) {
    const why = prompt && yes ? "--yes asks nothing" : "there is no terminal to ask on";
    const needed = [...collected.missing, ...(prompt || yes ? [] : ["--yes"])];
    err(`agent-kit init: ${why}, so pass ${needed.join(" and ")}.`);
    return 2;
  }
  if (!prompt && !yes) {
    err("agent-kit init: there is no terminal to confirm on, so pass --yes.");
    return 2;
  }
  const { answers } = collected;

  const top = runner("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return refuse(new Refusal(`${cwd} is not a git repository.`));
  const root = top.stdout.trim();
  const serverUrl = serverFromEnv(env);
  out(`Adopting ${DEFAULT_KIT_REPO}@${answers.tag} (${answers.flows.join(", ")}) in ${root}.`);

  let snap;
  try {
    snap = openTag({
      runner,
      repo: DEFAULT_KIT_REPO,
      tag: answers.tag,
      serverUrl,
      forDeletion: true,
    });
  } catch (e) {
    if (e instanceof PreManifestTagError) return refuse(e);
    return refuse(new Refusal(firstLine(e?.message ?? e)));
  }
  try {
    let plan;
    try {
      plan = planInit({ root, snap, answers, force });
    } catch (e) {
      if (e instanceof Refusal) return refuse(e);
      return refuse(new Refusal(firstLine(e?.message ?? e)));
    }

    out("");
    out(`Write (from ${answers.tag}):`);
    for (const p of snap.kitOwnedPaths) {
      const n = plan.writes.filter((w) => w.path.startsWith(p)).length;
      out(
        `  ${p} (${n} file${n === 1 ? "" : "s"}${plan.deletes.includes(p.replace(/\/$/, "")) ? ", replacing the existing copy" : ""})`,
      );
    }
    for (const w of plan.writes.filter(
      (x) => !snap.kitOwnedPaths.some((p) => x.path.startsWith(p)),
    )) {
      out(`  ${w.path}`);
    }
    if (plan.conflicts.length) {
      out(`--force: overwriting ${plan.conflicts.length} existing path(s):`);
      for (const c of plan.conflicts.slice(0, MAX_LISTED)) out(`  ${c}`);
    }
    out("");

    if (!yes && !(await confirm("Go ahead? [y/N] "))) {
      out("Stopped. Nothing was changed.");
      return 1;
    }
    try {
      applyPlan(root, plan);
    } catch (e) {
      if (e instanceof Refusal) return refuse(e);
      out(`FAILED  init stopped part-way: ${firstLine(e?.message ?? e)}`);
      out("      See `git status`; remove what was written and run init again.");
      return 1;
    }
    out(`Wrote ${plan.writes.length} file(s).`);
    const note = stageExecutableBits({
      runner,
      root,
      files: plan.writes.filter((w) => w.mode === EXECUTABLE_MODE).map((w) => w.path),
    });
    if (note) out(note);
    for (const n of plan.notes) out(n);
    if (plan.dependabot) {
      out("");
      out(
        `${plan.dependabot} already exists, so init left it alone. Merge this block into its updates: by hand:`,
      );
      out(DEPENDABOT_BLOCK.replace(/\n$/, ""));
    }
    if (answers.flows.includes("audit")) {
      out("");
      out(
        `Fill in ${answers.threatPackDir}/threat-model.md before the first audit; it is a skeleton.`,
      );
    }

    out("");
    out("Checks (as doctor --ci):");
    const results = checksAfterWrite({ runner, root, snap });
    for (const r of results) for (const line of formatResult(r)) out(line);
    const failed = results.some((r) => r.status === "fail");

    out("");
    out(
      "Still to do on GitHub (init changed nothing there). Lines starting with $ are POSIX shell commands for you to run:",
    );
    for (const line of manualSteps({
      flows: answers.flows,
      tag: answers.tag,
      repo: DEFAULT_KIT_REPO,
      serverUrl,
    })) {
      out(line);
    }
    out("");
    out(
      failed
        ? "Result: a check failed (exit 1)."
        : "Result: done. Review `git status` and `git diff`, commit, then run `npx @mnaimfaizy/agent-kit doctor` for the GitHub-side checks.",
    );
    return failed ? 1 : 0;
  } finally {
    snap.cleanup();
  }
}
