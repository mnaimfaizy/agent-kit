// Contract for the live suite's workflow scripts (.github/harness-live/) and
// what the suite hands them (cli/src/harness-live/run.mjs): which changes run
// the suite, what a result reads as, and what a failed weekly run puts in an
// issue. The workflow file itself is held by
// harness-live-workflow-contract.test.py. Offline: `gh` and git are faked.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { suiteNeeded } from "../.github/harness-live/changes.mjs";
import { needsSuite, SUITE_PATHS } from "../.github/harness-live/paths.mjs";
import { GUARD_LABEL, reportFailure, TITLE } from "../.github/harness-live/report-failure.mjs";
import { GUARDS } from "../cli/src/harness-live/assess.mjs";
import { report } from "../cli/src/harness-live/run.mjs";
import { SCENARIOS } from "../cli/src/harness-live/suite.mjs";

const ROOT = join(import.meta.dirname, "..");

describe("which changes run the live suite", () => {
  for (const file of [
    "cli/src/harness/claude-code.mjs",
    "cli/src/harness/install-layer.mjs",
    "docker/harness-images/claude-code.Dockerfile",
    "cli/src/deep-scan.mjs",
    "cli/src/deep-scan/lifecycle.mjs",
    "cli/src/deep-scan/docker-driver.mjs",
    "cli/src/deep-scan/relay-script.mjs",
    "cli/src/model-proxy/core.mjs",
    "cli/src/model-proxy/profiles/anthropic.mjs",
    "cli/src/harness-live/assess.mjs",
    ".github/harness-live/paths.mjs",
    ".github/workflows/harness-live.yml",
  ]) {
    it(`runs on a change to ${file}, which exists`, () => {
      assert.ok(existsSync(join(ROOT, file)), file);
      assert.equal(needsSuite(["README.md", file]), true);
    });
  }

  it("does not run on a change to none of them", () => {
    assert.equal(needsSuite([]), false);
    assert.equal(
      needsSuite(["README.md", "docs/security-audit.md", "cli/package.json", "scripts/x.mjs"]),
      false,
    );
    assert.equal(needsSuite([".github/workflows/harness-live.yml.bak"]), false);
  });

  it("names only paths that exist", () => {
    for (const path of SUITE_PATHS) assert.ok(existsSync(join(ROOT, path)), path);
  });

  const git =
    (files, status = 0) =>
    () => ({
      status,
      stdout: files.map((f) => `${f}\0`).join(""),
      stderr: "boom",
    });
  const pr = { GITHUB_EVENT_NAME: "pull_request" };

  it("reads a pull request's changes, and always runs on any other event", () => {
    assert.equal(suiteNeeded({ env: pr, git: git(["README.md"]) }), false);
    assert.equal(suiteNeeded({ env: pr, git: git(["cli/src/exec.mjs"]) }), true);
    for (const event of ["schedule", "workflow_dispatch"]) {
      assert.equal(suiteNeeded({ env: { GITHUB_EVENT_NAME: event }, git: git([]) }), true);
    }
  });

  it("fails, never skips, when the changes cannot be read", () => {
    assert.throws(() => suiteNeeded({ env: pr, git: git([], 128) }), /could not list/);
  });
});

describe("what the suite reports", () => {
  const findings = (bad = {}) =>
    GUARDS.map((guard) => ({ guard, status: bad[guard] ?? "held", reasons: [] }));
  const result = (name, verdict, bad) => ({ name, verdict, findings: findings(bad), exit: 0 });

  it("runs Claude Code as a read-only Stage and as a Deep scan, on each credential kind", () => {
    assert.deepEqual(
      SCENARIOS.map((s) => [s.run, s.credentialKind]),
      [
        ["read-only-stage", "api-key"],
        ["read-only-stage", "subscription"],
        ["deep-scan", "api-key"],
        ["deep-scan", "subscription"],
      ],
    );
  });

  it("passes only when every scenario passed", () => {
    const passed = report([result("a (api-key)", "pass")]);
    assert.deepEqual([passed.exit, passed.outputs], [0, "guard_failed=false\nfailed="]);
    assert.equal(report([]).exit, 1);
    assert.equal(report([result("a", "pass"), result("b", "error")]).exit, 1);
  });

  it("names each Guard not held, by scenario", () => {
    const got = report([
      result("claude-code deep-scan (api-key)", "guard-failed", {
        network: "breached",
        config: "inconclusive",
      }),
      result("x", "guard-failed"),
    ]);
    assert.equal(got.exit, 1);
    assert.equal(
      got.outputs,
      "guard_failed=true\nfailed=claude-code-deep-scan-api-key:config,claude-code-deep-scan-api-key:network,x:isolation",
    );
    assert.match(got.summary, /network \(breached\)/);
  });

  it("does not call another failure a Guard failure", () => {
    const got = report([result("a", "error", { reads: "inconclusive" })]);
    assert.equal(got.outputs, "guard_failed=false\nfailed=");
  });
});

describe("a failed weekly run", () => {
  /** `gh`, with the open issues the job token opened; records every call. */
  function fake(open = [], failing) {
    const calls = [];
    const gh = (args, stdin) => {
      calls.push({ args, stdin });
      if (failing && args[1] === failing) return { status: 1, stdout: "", stderr: "no" };
      const stdout = args[1] === "list" ? JSON.stringify(open) : "https://github.com/o/r/issues/7";
      return { status: 0, stdout, stderr: "" };
    };
    return { calls, gh };
  }
  const env = (guard, failed = "a:network") => ({
    RUN_URL: "https://github.com/o/r/actions/runs/1",
    GUARD_FAILED: guard,
    FAILED: failed,
  });
  const flag = (args, name) => args.filter((_, i) => args[i - 1] === name);

  it("opens an issue labelled ready-for-human and guard-failure for a Guard failure", () => {
    const { calls, gh } = fake();
    reportFailure({ env: env("true"), gh });
    assert.deepEqual(calls[0].args.slice(0, 3), ["label", "create", GUARD_LABEL]);
    const create = calls.find((c) => c.args[1] === "create" && c.args[0] === "issue");
    assert.deepEqual(flag(create.args, "--title"), [TITLE]);
    assert.deepEqual(flag(create.args, "--label"), ["ready-for-human", "guard-failure"]);
    assert.match(create.stdin, /actions\/runs\/1/);
    assert.match(create.stdin, /`a:network`/);
    assert.match(create.stdin, /next release is blocked/);
  });

  it("opens one for triage, blocking nothing, for any other failure", () => {
    for (const guard of ["false", "", undefined]) {
      const { calls, gh } = fake();
      reportFailure({ env: env(guard, ""), gh });
      assert.ok(!calls.some((c) => c.args[0] === "label"));
      const create = calls.find((c) => c.args[1] === "create");
      assert.deepEqual(flag(create.args, "--label"), ["needs-triage"]);
      assert.doesNotMatch(create.stdin, /release is blocked/);
    }
  });

  it("adds to the open issue, labelling it before the comment on a Guard failure", () => {
    const { calls, gh } = fake([
      { number: 3, title: "Something else" },
      { number: 7, title: TITLE },
    ]);
    reportFailure({ env: env("true"), gh });
    assert.ok(!calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"));
    const acts = calls.filter((c) => ["edit", "comment"].includes(c.args[1]));
    assert.deepEqual(
      acts.map((c) => c.args.slice(1, 3)),
      [
        ["edit", "7"],
        ["comment", "7"],
      ],
    );
    assert.deepEqual(flag(acts[0].args, "--add-label"), ["ready-for-human", "guard-failure"]);
  });

  it("looks only at issues the job token opened, and fails when gh does", () => {
    const { calls, gh } = fake();
    reportFailure({ env: env("false"), gh });
    const list = calls.find((c) => c.args[1] === "list");
    assert.deepEqual(flag(list.args, "--author"), ["app/github-actions"]);
    assert.throws(() => reportFailure({ env: env("true"), gh: fake([], "create").gh }), /failed/);
  });

  it("puts nothing but a scenario and Guard name from the suite into the issue", () => {
    const { calls, gh } = fake();
    reportFailure({ env: env("true", "@someone ping,a:key,`x`"), gh });
    const create = calls.find((c) => c.args[1] === "create" && c.args[0] === "issue");
    assert.doesNotMatch(create.stdin, /someone/);
    assert.match(create.stdin, /`a:key`/);
  });
});
