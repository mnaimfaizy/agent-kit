/**
 * Contract test: the QA examples a Consumer copies, `examples/qa.config.yml`
 * and the sample Hazard pack in `examples/qa-hazards/`, read with no problems
 * through the skills' own reader, `adapter.mjs`, and `qa.config.yml` shows
 * every key that reader accepts. A key added to `adapter.mjs` fails here until
 * the example (and docs/qa.md) show it.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as planAdapter from "../.claude/skills/qa-plan/adapter.mjs";
import * as runAdapter from "../.claude/skills/manual-qa/adapter.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const CONFIG = read("examples/qa.config.yml");
const PACKS = readdirSync(join(root, "examples/qa-hazards")).filter((f) => f.endsWith(".md"));

/** A repository holding the example config, with its Hazard pack where `hazards` names it. */
function exampleRepo(adapter) {
  const { config } = adapter.parseConfig("qa.config.yml", CONFIG);
  const files = new Map([["qa.config.yml", CONFIG]]);
  for (const { pack } of config.hazards)
    files.set(pack, read(`examples/qa-hazards/${pack.split("/").pop()}`));
  return (path) => files.get(path) ?? null;
}

function run(adapter, argv, stdin = "") {
  const { code, out } = adapter.main(argv, { read: exampleRepo(adapter), stdin: () => stdin });
  return { code, result: JSON.parse(out) };
}

/** Every key path in a parsed config, list indexes dropped: `plan.suites.name`. */
function keyPaths(value, prefix = "") {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, prefix));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...keyPaths(child, path)];
  });
}

describe("examples/qa.config.yml", () => {
  it("passes `check --for plan` with nothing left to ask", () => {
    const { code, result } = run(planAdapter, ["check", "--for", "plan"]);
    assert.equal(code, 0, JSON.stringify(result.problems));
    assert.equal(result.path, "qa.config.yml");
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.readiness.needs, []);
  });

  it("passes `check --for run` with nothing left to ask", () => {
    const { code, result } = run(runAdapter, ["check", "--for", "run"]);
    assert.equal(code, 0, JSON.stringify(result.problems));
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.readiness.needs, []);
    assert.equal(result.readiness.run.target, "stack");
  });

  it("shows every key adapter.mjs accepts, in both sections", () => {
    const { config } = planAdapter.parseConfig("qa.config.yml", CONFIG);
    const shown = new Set(keyPaths(config));
    const accepted = [
      ...planAdapter.TOP_KEYS,
      ...planAdapter.PLAN_KEYS.map((k) => `plan.${k}`),
      ...planAdapter.SUITE_KEYS.map((k) => `plan.suites.${k}`),
      ...planAdapter.PUBLISH_KEYS.map((k) => `plan.publish.${k}`),
      ...planAdapter.HAZARD_KEYS.map((k) => `hazards.${k}`),
      ...planAdapter.RUN_KEYS.map((k) => `run.${k}`),
      ...planAdapter.STACK_KEYS.map((k) => `run.stack.${k}`),
      ...planAdapter.ACCOUNT_KEYS.map((k) => `run.accounts.${k}`),
      ...planAdapter.ROLE_KEYS.map((k) => `run.accounts.roles.${k}`),
      ...planAdapter.EVIDENCE_KEYS.map((k) => `run.evidence.${k}`),
    ];
    assert.deepEqual(
      accepted.filter((key) => !shown.has(key)),
      [],
      "keys adapter.mjs accepts that the example does not show",
    );
  });

  it("names the sample Hazard pack, so a copy of both works together", () => {
    const { config } = planAdapter.parseConfig("qa.config.yml", CONFIG);
    assert.deepEqual(
      config.hazards.map(({ pack }) => pack.split("/").pop()),
      PACKS,
    );
  });

  it("holds no sign-in value and no hosted address", () => {
    const values = JSON.stringify(planAdapter.parseConfig("qa.config.yml", CONFIG).config);
    assert.doesNotMatch(values, /password|token|secret/i);
    assert.doesNotMatch(values, /https?:\/\//);
  });
});

describe("examples/qa-hazards", () => {
  it("has one sample pack", () => assert.equal(PACKS.length, 1));

  for (const pack of PACKS) {
    it(`${pack} reads with no problems, with both sections and its when: globs`, () => {
      const parsed = planAdapter.parseHazardPack(read(`examples/qa-hazards/${pack}`));
      assert.deepEqual(parsed.problems, []);
      assert.ok(parsed.when.length > 0);
      assert.notEqual(parsed.ruleOutFirst, "");
      assert.notEqual(parsed.captureRules, "");
    });
  }

  it("matches changed paths through `hazards`, and only through its globs", () => {
    const changed = ["backend/auth/tokens.py", "frontend/src/pages/LoginPage.tsx", "README.md"];
    const { code, result } = run(planAdapter, ["hazards"], changed.join("\n"));
    assert.equal(code, 0, JSON.stringify(result.problems));
    assert.equal(result.packs.length, 1);
    assert.deepEqual(result.packs[0].matched, changed.slice(0, 2));

    const none = run(planAdapter, ["hazards"], "README.md\ndocs/qa.md\n");
    assert.equal(none.code, 0);
    assert.deepEqual(none.result.packs, []);
  });
});
