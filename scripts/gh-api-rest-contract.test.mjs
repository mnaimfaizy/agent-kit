/**
 * Contract test (issue #389): every label, body, and assignee write in the kit
 * goes through `gh api` REST endpoints rather than `gh issue edit` / `gh pr edit`
 * (which fail on older `gh` CLIs when GitHub Projects classic `projectCards` is
 * unavailable).
 *
 * Covers:
 * - Static scan of skill docs, agent docs, example scripts, and active
 *   (non-archived) workflows for any `gh issue edit` / `gh pr edit` write.
 * - Expected HTTP method and REST path for each updated file.
 * - End-to-end execution of `orchestrate` `set-state` and `qa-plan` body
 *   update against a fake `gh` on `PATH` (including `404` on label removal).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Recursively collect files under `relDir` matching `exts`, excluding `skipDirs`. */
function collectFiles(relDir, exts, skipDirs = new Set()) {
  const results = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (exts.some((ext) => entry.name.endsWith(ext))) {
        results.push(relative(ROOT, join(dir, entry.name)).replace(/\\/g, "/"));
      }
    }
  };
  walk(join(ROOT, relDir));
  return results.sort();
}

/** Extract a markdown section from `heading` to the next heading of same or higher depth. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const depth = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${depth}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

/** Extract `Consume trigger label` step's `run:` script from a workflow YAML. */
function consumeTriggerStep(workflowRel) {
  const text = read(workflowRel);
  const marker = "- name: Consume trigger label\n";
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `${workflowRel} has Consume trigger label step`);
  const afterMarker = text.slice(start + marker.length);
  const nextStep = afterMarker.search(/\n {6}- (?:name|uses): |\n {2}[a-z-]+:\n/);
  return nextStep < 0 ? afterMarker : afterMarker.slice(0, nextStep);
}

describe("no active kit doc, script, or workflow writes via gh issue edit / gh pr edit", () => {
  const scanRoots = [
    ...collectFiles(".claude/skills", [".md"]),
    ...collectFiles("docs/agents", [".md"]),
    ...collectFiles("examples", [".sh", ".md"]),
    ...collectFiles(".github/workflows", [".yml", ".yaml"]),
    ...collectFiles(".github/agent-pipeline", [".sh", ".md"]),
    ...collectFiles(".github/agent-runtime", [".mjs", ".json"]),
    ...collectFiles(".github/agent-review-response", [".mjs"]),
    ...collectFiles(".github/security-audit", [".sh", ".md"]),
  ];

  // pr-drafter.agent.md explicitly forbids running `gh pr edit`; that is a prohibition, not a write instruction.
  const ALLOWED_PROHIBITION = {
    file: "examples/patterns/pr-pipeline/pr-drafter.agent.md",
    pattern: /^- Do not run .*`gh pr edit`/,
  };

  it("finds no `gh issue edit` or `gh pr edit` write instructions", () => {
    const violations = [];
    for (const rel of scanRoots) {
      const lines = read(rel).split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/\bgh\s+(?:issue|pr)\s+edit\b/.test(line)) continue;
        if (rel === ALLOWED_PROHIBITION.file && ALLOWED_PROHIBITION.pattern.test(line)) continue;
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
    assert.deepEqual(violations, [], `Found gh issue/pr edit writes:\n${violations.join("\n")}`);
  });
});

describe("each updated file names the expected gh api REST method and path", () => {
  it("trackers/github.md uses REST POST and DELETE for labels, documents 404 and missing-label creation, drops comma caveat, and dates Facts from 2026-11-26", () => {
    const text = read(".claude/skills/orchestrate/trackers/github.md");
    const facts = /^- \*\*Facts from:\*\* (.*)$/m.exec(text)?.[1] ?? "";
    assert.match(facts, /2026-11-26/);
    assert.match(facts, /repos\/\{owner\}\/\{repo\}\/issues\/\{n\}\/labels|labels/i);
    assert.doesNotMatch(facts, /gh issue edit/);

    const setState = section(text, "### `set-state`");
    assert.match(setState, /gh api[^\n]*-X POST[^\n]*repos\/<owner>\/<repo>\/issues\/<n>\/labels/);
    assert.match(setState, /labels\[\]=<new>/);
    assert.match(setState, /node -p 'encodeURIComponent\(process\.argv\[1\]\)' "<old>"/);
    assert.match(setState, /\[ -n "\$encoded" \]/);
    assert.match(
      setState,
      /gh api[^\n]*-X DELETE[^\n]*repos\/<owner>\/<repo>\/issues\/<n>\/labels\//,
    );
    assert.match(setState, /404/);
    assert.match(setState, /gh issue view <n> --json labels/);
    assert.match(setState, /creates/i);
    assert.match(setState, /only[^.\n]*labels the repository (?:already )?has/i);
    assert.doesNotMatch(setState, /\bcomma\b/i);
    assert.doesNotMatch(setState, /\bjq -rn\b/);
    assert.doesNotMatch(setState, /--add-label/);
    assert.doesNotMatch(setState, /--remove-label/);

    // Add comes before remove in the set-state commands.
    const postIdx = setState.indexOf("-X POST");
    const deleteIdx = setState.indexOf("-X DELETE");
    const viewIdx = setState.indexOf("gh issue view");
    assert.ok(
      postIdx >= 0 && deleteIdx > postIdx && viewIdx > deleteIdx,
      "add -> remove -> read-back order",
    );
  });

  it("qa-plan/SKILL.md updates tracker-issue via PATCH repos/{owner}/{repo}/issues/<m> with body=@", () => {
    const text = read(".claude/skills/qa-plan/SKILL.md");
    assert.match(text, /gh api -X PATCH repos\/\{owner\}\/\{repo\}\/issues\/<m> -F body=@<plan>/);
  });

  it("manual-qa/SKILL.md updates tracker-issue via PATCH repos/{owner}/{repo}/issues/<planIssue> with body=@", () => {
    const text = read(".claude/skills/manual-qa/SKILL.md");
    assert.match(
      text,
      /gh api -X PATCH "repos\/\{owner\}\/\{repo\}\/issues\/<planIssue>" -F "?body=@<tmp>\/issue-new\.md"?/,
    );
  });

  it("docs/agents/issue-tracker.md leads with REST gh api for sub-issues, dependencies, labels (with 404), and assignees", () => {
    const text = read("docs/agents/issue-tracker.md");
    assert.match(
      text,
      /\*\*Make an issue a sub-issue of a parent\*\*:\s*`gh api (?:-X|--method) POST repos\/\{owner\}\/\{repo\}\/issues\/<parent>\/sub_issues -F sub_issue_id=<child-db-id>`/,
    );
    assert.match(
      text,
      /\*\*Blocking\*\*:[^\n]*`gh api (?:-X|--method) POST repos\/\{owner\}\/\{repo\}\/issues\/<child>\/dependencies\/blocked_by -F issue_id=<blocker-db-id>`/,
    );
    assert.match(
      text,
      /gh api -X POST repos\/\{owner\}\/\{repo\}\/issues\/<number>\/labels -f "labels\[\]=<name>"/,
    );
    assert.match(text, /node -p 'encodeURIComponent\(process\.argv\[1\]\)' "<name>"/);
    assert.match(
      text,
      /gh api -X DELETE "repos\/\{owner\}\/\{repo\}\/issues\/<number>\/labels\/\$encoded"/,
    );
    assert.match(text, /404/);
    assert.match(
      text,
      /\*\*Claim a ticket\*\*:\s*`gh api -X POST repos\/\{owner\}\/\{repo\}\/issues\/<n>\/assignees -f "assignees\[\]=/,
    );
  });

  it("examples/patterns/pr-pipeline/pr-runner.sh updates an existing PR through REST gh api endpoints", () => {
    const text = read("examples/patterns/pr-pipeline/pr-runner.sh");
    assert.match(text, /gh api -X PATCH "repos\/\{owner\}\/\{repo\}\/pulls\/\$\{?[a-z_]+\}?"/);
    assert.match(text, /-F "body=@\$body_file"/);
    assert.match(
      text,
      /gh api -X POST "repos\/\{owner\}\/\{repo\}\/issues\/\$\{?[a-z_]+\}?\/assignees"/,
    );
    assert.match(text, /assignees\[\]=/);
    assert.match(
      text,
      /gh api -X POST "repos\/\{owner\}\/\{repo\}\/issues\/\$\{?[a-z_]+\}?\/labels"/,
    );
    assert.match(text, /labels\[\]=/);
    assert.match(
      text,
      /gh api -X POST "repos\/\{owner\}\/\{repo\}\/pulls\/\$\{?[a-z_]+\}?\/requested_reviewers"/,
    );
    assert.match(text, /reviewers\[\]=/);
  });

  for (const wf of [
    ".github/workflows/agent-plan-reusable.yml",
    ".github/workflows/agent-implement-reusable.yml",
    ".github/workflows/agent-review-reusable.yml",
    ".github/workflows/agent-review-response-reusable.yml",
    ".github/workflows/security-audit-reusable.yml",
  ]) {
    it(`${wf} consumes its trigger label via URL-encoded REST DELETE with || true`, () => {
      const step = consumeTriggerStep(wf);
      assert.match(step, /@uri/);
      assert.match(
        step,
        /gh api -X DELETE "repos\/\$GITHUB_REPOSITORY\/issues\/\$\{?(?:ISSUE|PR)\}?\/labels\/\$ENCODED_LABEL"\s*\|\|\s*true/,
      );
    });
  }
});

describe("contract: orchestrate set-state and qa-plan body update against fake gh on PATH", () => {
  const scratch = mkdtempSync(join(tmpdir(), "gh-api-rest-contract-"));
  const binDir = join(scratch, "bin");
  after(() => rmSync(scratch, { recursive: true, force: true }));

  /** Create a fake `gh` on `PATH` (both POSIX `gh` and Windows `gh.cmd`). */
  function setupFakeGh(initialLabels = ["bug", "team: running"]) {
    mkdirSync(binDir, { recursive: true });
    const logFile = join(scratch, "calls.jsonl");
    const stateFile = join(scratch, "state.json");
    writeFileSync(logFile, "", "utf8");
    writeFileSync(stateFile, JSON.stringify({ labels: initialLabels, body: "" }), "utf8");

    const ghScript = join(binDir, "gh.mjs");
    writeFileSync(
      ghScript,
      `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const logFile = process.env.FAKE_GH_LOG;
const stateFile = process.env.FAKE_GH_STATE;

if ((argv[0] === "issue" || argv[0] === "pr") && argv[1] === "edit") {
  process.stderr.write("GraphQL: Projects (classic) is being deprecated; projectCards field is unavailable.\\n");
  process.exit(1);
}

appendFileSync(logFile, JSON.stringify({ argv }) + "\\n", "utf8");
const state = JSON.parse(readFileSync(stateFile, "utf8"));

if (argv[0] === "issue" && argv[1] === "view") {
  for (const label of state.labels) process.stdout.write(label + "\\n");
  process.exit(0);
}

if (argv[0] === "api") {
  let method = "GET";
  const fields = [];
  let endpoint = "";
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-X" || a === "--method") {
      method = argv[++i];
    } else if (a === "-f" || a === "-F") {
      fields.push(argv[++i]);
    } else if (!a.startsWith("-") && !endpoint) {
      endpoint = a;
    }
  }

  if (method === "POST" && /^repos\\/[^/]+\\/[^/]+\\/issues\\/\\d+\\/labels$/.test(endpoint)) {
    for (const f of fields) {
      if (f.startsWith("labels[]=")) {
        const name = f.slice("labels[]=".length);
        if (!state.labels.includes(name)) state.labels.push(name);
      }
    }
    writeFileSync(stateFile, JSON.stringify(state), "utf8");
    process.exit(0);
  }

  if (method === "DELETE" && /^repos\\/[^/]+\\/[^/]+\\/issues\\/\\d+\\/labels\\/$/.test(endpoint)) {
    process.stderr.write("BAD: empty label name on DELETE /labels/\\n");
    process.exit(2);
  }

  const delMatch = /^repos\\/[^/]+\\/[^/]+\\/issues\\/\\d+\\/labels\\/(.+)$/.exec(endpoint);
  if (method === "DELETE" && delMatch) {
    const name = decodeURIComponent(delMatch[1]);
    const idx = state.labels.indexOf(name);
    if (idx === -1) {
      process.stderr.write("gh: Label does not exist (HTTP 404)\\n");
      process.exit(1);
    }
    state.labels.splice(idx, 1);
    writeFileSync(stateFile, JSON.stringify(state), "utf8");
    process.exit(0);
  }

  if (method === "PATCH" && /^repos\\/[^/]+\\/[^/]+\\/issues\\/\\d+$/.test(endpoint)) {
    const bodyField = fields.find((f) => f.startsWith("body=@"));
    if (!bodyField) {
      process.stderr.write("missing body=@file field\\n");
      process.exit(1);
    }
    state.body = readFileSync(bodyField.slice("body=@".length), "utf8");
    writeFileSync(stateFile, JSON.stringify(state), "utf8");
    process.exit(0);
  }
}

process.stderr.write("unexpected gh call: " + JSON.stringify(argv) + "\\n");
process.exit(1);
`,
      "utf8",
    );

    const posixWrapper = join(binDir, "gh");
    writeFileSync(
      posixWrapper,
      `#!/bin/sh\nexec "${process.execPath}" "${ghScript}" "$@"\n`,
      "utf8",
    );
    chmodSync(posixWrapper, 0o755);

    const winWrapper = join(binDir, "gh.cmd");
    writeFileSync(winWrapper, `@echo off\r\n"${process.execPath}" "${ghScript}" %*\r\n`, "utf8");

    return { logFile, stateFile };
  }

  /** Find a working `bash` binary (always present on Linux/macOS CI; may be blocked in Windows sandbox). */
  function findWorkingBash() {
    const candidates =
      process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe", "bash"] : ["bash"];
    for (const candidate of candidates) {
      const probe = spawnSync(candidate, ["-c", "printf ok"], { encoding: "utf8" });
      if (!probe.error && probe.status === 0 && probe.stdout === "ok") return candidate;
    }
    return null;
  }

  /** Split a simple shell command line into argv tokens (handles double/single quotes). */
  function splitShellArgs(line) {
    const tokens = [];
    let current = "";
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = null;
        else current += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (/\s/.test(ch)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);
    return tokens;
  }

  /** Invoke `gh` via `PATH` cleanly on Windows and POSIX. */
  function runGh(args, extraEnv) {
    const env = {
      ...process.env,
      ...extraEnv,
      PATH: `${binDir}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    };
    if (process.platform === "win32") {
      return spawnSync("cmd.exe", ["/d", "/c", "gh", ...args], { env, encoding: "utf8" });
    }
    return spawnSync("gh", args, { env, encoding: "utf8" });
  }

  /** Run a bash script file against `binDir` on `PATH` when `bash` works. */
  function runBashScript(bashBin, scriptText, extraEnv) {
    const scriptPath = join(scratch, "run-step.sh");
    writeFileSync(scriptPath, `set -euo pipefail\n${scriptText}\n`, "utf8");
    const env = {
      ...process.env,
      ...extraEnv,
      PATH: `${binDir}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    };
    return spawnSync(bashBin, [scriptPath], { env, encoding: "utf8" });
  }

  it("fake gh reproduces the Projects (classic) error on issue edit / pr edit", () => {
    const { logFile, stateFile } = setupFakeGh();
    const env = { FAKE_GH_LOG: logFile, FAKE_GH_STATE: stateFile };
    for (const sub of ["issue", "pr"]) {
      const res = runGh([sub, "edit", "42", "--add-label", "bug"], env);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /projectCards/);
    }
  });

  it("orchestrate set-state commands extracted from trackers/github.md succeed (add, remove, 404-as-removed, empty-guard, read-back)", () => {
    const { logFile, stateFile } = setupFakeGh(["bug", "team: running"]);
    const env = { FAKE_GH_LOG: logFile, FAKE_GH_STATE: stateFile };

    const setState = section(
      read(".claude/skills/orchestrate/trackers/github.md"),
      "### `set-state`",
    );
    const bashMatch = /```bash\n([\s\S]*?)```/.exec(setState);
    assert.ok(bashMatch, "set-state has a bash code block");
    const blockLines = bashMatch[1].trim().split("\n");
    assert.equal(
      blockLines.length,
      4,
      "set-state block has add, encode, guarded delete, read-back",
    );

    const fill = (line, oldLabel) =>
      line
        .replaceAll("<owner>/<repo>", "acme/app")
        .replaceAll("<n>", "42")
        .replaceAll("<new>", "team: ready to merge")
        .replaceAll("<old>", oldLabel);

    const [addTemplate, encodeTemplate, deleteTemplate, viewTemplate] = blockLines;
    // Build the exact sequence: add new label, remove present label, remove absent label (404),
    // skip empty label via [ -n "$encoded" ] guard, then read labels back.
    const concreteLines = [
      fill(addTemplate, ""),
      fill(encodeTemplate, "team: running"),
      fill(deleteTemplate, "team: running"),
      fill(encodeTemplate, "team: parked"),
      fill(deleteTemplate, "team: parked"),
      fill(encodeTemplate, ""),
      fill(deleteTemplate, ""),
      fill(viewTemplate, ""),
    ];

    const workingBash = findWorkingBash();
    let stdout;
    if (workingBash) {
      const res = runBashScript(workingBash, concreteLines.join("\n"), env);
      assert.equal(res.status, 0, `bash exited ${res.status}: ${res.stderr}`);
      stdout = res.stdout;
    } else {
      // Restricted Windows sandbox fallback: execute the exact extracted `node -p` expression and `gh` lines.
      const addRes = runGh(splitShellArgs(concreteLines[0]).slice(1), env);
      assert.equal(addRes.status, 0, addRes.stderr);

      const nodeCodeMatch = /node -p '([^']+)'/.exec(encodeTemplate);
      assert.ok(nodeCodeMatch, "extracted node -p expression");
      const nodeExpr = nodeCodeMatch[1];

      for (const oldLabel of ["team: running", "team: parked", ""]) {
        const encRes = spawnSync(process.execPath, ["-p", nodeExpr, oldLabel], {
          encoding: "utf8",
        });
        assert.equal(encRes.status, 0, encRes.stderr);
        const encoded = encRes.stdout.trim();
        if (!encoded) continue; // Mirrors `[ -n "$encoded" ]` guard in extracted delete line.
        const deleteCmdMatch = /\$\((gh api -X DELETE [^)]+) 2>&1\)/.exec(
          fill(deleteTemplate, oldLabel).replaceAll("$encoded", encoded),
        );
        assert.ok(deleteCmdMatch, "extracted DELETE gh command");
        const delRes = runGh(splitShellArgs(deleteCmdMatch[1]).slice(1), env);
        if (delRes.status !== 0) {
          assert.match(delRes.stderr, /HTTP 404/, `expected 404 or success, got: ${delRes.stderr}`);
        }
      }

      const viewRes = runGh(splitShellArgs(concreteLines.at(-1)).slice(1), env);
      assert.equal(viewRes.status, 0, viewRes.stderr);
      stdout = viewRes.stdout;
    }

    const labels = stdout.trim().split(/\r?\n/);
    assert.deepEqual(labels, ["bug", "team: ready to merge"]);

    // Verify only expected gh api calls (and read-back gh issue view) were made,
    // and that the empty label guard prevented any DELETE .../labels/ call.
    const calls = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).argv);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0].slice(0, 4), [
      "api",
      "-X",
      "POST",
      "repos/acme/app/issues/42/labels",
    ]);
    assert.deepEqual(calls[1].slice(0, 4), [
      "api",
      "-X",
      "DELETE",
      "repos/acme/app/issues/42/labels/team%3A%20running",
    ]);
    assert.deepEqual(calls[2].slice(0, 4), [
      "api",
      "-X",
      "DELETE",
      "repos/acme/app/issues/42/labels/team%3A%20parked",
    ]);
    assert.deepEqual(calls[3].slice(0, 2), ["issue", "view"]);
  });

  it("qa-plan body update command extracted from qa-plan/SKILL.md succeeds via REST PATCH", () => {
    const { logFile, stateFile } = setupFakeGh([]);
    const env = { FAKE_GH_LOG: logFile, FAKE_GH_STATE: stateFile };

    const qaSkill = read(".claude/skills/qa-plan/SKILL.md");
    const cmdMatch =
      /`(gh api -X PATCH repos\/\{owner\}\/\{repo\}\/issues\/<m> -F body=@<plan>)`/.exec(qaSkill);
    assert.ok(cmdMatch, "qa-plan/SKILL.md documents PATCH body update command");

    const planFile = join(scratch, "qa-plan-pr-42.md");
    const planContent = "<!-- qa-plan format=4 subject=#10 pr=42 -->\n# QA Plan\n";
    writeFileSync(planFile, planContent, "utf8");

    const concreteCmd = cmdMatch[1]
      .replace("{owner}/{repo}", "acme/app")
      .replace("<m>", "10")
      .replace("<plan>", `"${planFile.replace(/\\/g, "/")}"`);

    const workingBash = findWorkingBash();
    if (workingBash) {
      const res = runBashScript(workingBash, concreteCmd, env);
      assert.equal(res.status, 0, res.stderr);
    } else {
      const patchRes = runGh(splitShellArgs(concreteCmd).slice(1), env);
      assert.equal(patchRes.status, 0, patchRes.stderr);
    }

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.body, planContent);

    const calls = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).argv);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "api",
      "-X",
      "PATCH",
      "repos/acme/app/issues/10",
      "-F",
      `body=@${planFile.replace(/\\/g, "/")}`,
    ]);
  });
});
