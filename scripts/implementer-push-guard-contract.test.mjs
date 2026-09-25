// Contract for the implementer's pre-push PreToolUse hook. The implementer
// pushes and opens its draft PR inside the agent step, and a same-repository
// PR runs the branch's own workflow files with repository secrets. A check
// after the agent step is too late, so the push itself is refused when the
// branch changes a workflow or a local action.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decidePush, pushRef } from "../.github/agent-runtime/guard-implementer-push.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");

const WRAPPER = "/home/runner/work/_actions/anthropics/claude-code-action/abc/scripts/git-push.sh";
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

describe("implementer push guard contract", () => {
  it("ignores everything but a push through the action's wrapper", () => {
    const never = () => assert.fail("must not diff for a non-push call");
    for (const payload of [
      bash("git status"),
      bash("git commit -m 'edit .github/workflows/ci.yml'"),
      { tool_name: "Write", tool_input: { file_path: ".github/workflows/x.yml" } },
      {},
      null,
    ]) {
      assert.equal(decidePush(payload, never), null, JSON.stringify(payload));
    }
  });

  it("reads the ref from a standalone push and refuses a chained one", () => {
    assert.equal(pushRef(`${WRAPPER} origin HEAD`), "HEAD");
    assert.equal(pushRef(`  ${WRAPPER} origin claude/issue-7-x  `), "claude/issue-7-x");
    // A commit chained before the push lands after this hook has already run,
    // so the diff would miss it.
    for (const command of [
      `git commit -am x && ${WRAPPER} origin HEAD`,
      `git add . ; ${WRAPPER} origin HEAD`,
      `x;${WRAPPER} origin HEAD`,
      `FOO=1 ${WRAPPER} origin HEAD`,
      `${WRAPPER} origin HEAD | cat`,
      `${WRAPPER} origin HEAD\ngit status`,
      `(${WRAPPER} origin HEAD)`,
      `${WRAPPER} origin $(git branch --show-current)`,
      `${WRAPPER} origin`,
    ]) {
      assert.equal(pushRef(command), null, command);
      assert.match(decidePush(bash(command), () => []) ?? "", /on its own/, command);
    }
  });

  it("refuses a push whose branch changes a workflow or a local action", () => {
    for (const files of [
      [".github/workflows/ci.yml"],
      ["src/a.ts", ".github/workflows/new.yaml"],
      [".github/actions/setup/action.yml"],
    ]) {
      assert.match(
        decidePush(bash(`${WRAPPER} origin HEAD`), () => files) ?? "",
        /\.github\/(workflows|actions)/,
        files.join(","),
      );
    }
  });

  it("allows a push that changes neither", () => {
    const files = [
      "src/a.ts",
      ".github/CODEOWNERS",
      "docs/workflows.md",
      ".github/workflows-archive/x.yml",
    ];
    assert.equal(
      decidePush(bash(`${WRAPPER} origin HEAD`), () => files),
      null,
    );
  });

  it("fails closed when the branch's changes cannot be listed", () => {
    const reason = decidePush(bash(`${WRAPPER} origin HEAD`), () => null);
    assert.match(reason ?? "", /could not list/);
  });

  it("is registered for Bash beside the read-confinement hook, and staged", () => {
    const settings = JSON.parse(readRepo(".github/agent-runtime/implementer.settings.json"));
    const groups = settings.hooks?.PreToolUse ?? [];
    const byMatcher = Object.fromEntries(
      groups.map((g) => [g.matcher, g.hooks.map((h) => h.command)]),
    );
    assert.deepEqual(Object.keys(byMatcher).sort(), ["Bash", "Read|Grep|Glob"]);
    assert.deepEqual(byMatcher.Bash, [
      'node "$RUNNER_TEMP/read-confinement/guard-implementer-push.mjs"',
    ]);
    assert.deepEqual(byMatcher["Read|Grep|Glob"], [
      'node "$RUNNER_TEMP/read-confinement/confine-reads-to-workspace.mjs"',
    ]);

    const implement = readRepo(".github/workflows/agent-implement-reusable.yml");
    assert.ok(
      implement.includes(
        "settings: ${{ runner.temp }}/read-confinement/implementer.settings.json\n",
      ),
      "the implementer must load the staged implementer settings",
    );
    for (const file of [
      "guard-implementer-push.mjs",
      "implementer.settings.json",
      "push-guard-base",
    ]) {
      assert.ok(implement.includes(file), `staging must include ${file}`);
    }
  });

  it("denies the implementer file edits under workflows and local actions", () => {
    const implement = readRepo(".github/workflows/agent-implement-reusable.yml");
    const denied = implement.split('--disallowedTools "')[1].split('"')[0].split(",");
    for (const rule of ["Edit(./.github/workflows/**)", "Edit(./.github/actions/**)"]) {
      assert.ok(denied.includes(rule), `${rule} not denied`);
    }
  });
});
