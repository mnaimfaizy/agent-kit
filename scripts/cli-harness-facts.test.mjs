// Contract for `cli/harnesses.json` (ADRs 0028 and 0030): the file every kit
// tag ships is generated from the Harness adapters (cli/src/harness/) and the
// Support Level table beside them, so it must equal them. Its shape can only
// grow: an older CLI reads a newer tag's file, and a newer CLI an older one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { claudeCode } from "../cli/src/harness/claude-code.mjs";
import {
  buildHarnesses,
  readHarnesses,
  SECURITY_STAGES,
  STAGES,
  SUPPORT_LEVELS,
} from "../cli/src/harness/facts.mjs";

const ROOT = join(import.meta.dirname, "..");
const FILE = join(ROOT, "cli", "harnesses.json");
const GENERATOR = join(ROOT, "scripts", "gen_harnesses.mjs");
const shipped = () => JSON.parse(readFileSync(FILE, "utf8"));

const generator = (...args) =>
  spawnSync(process.execPath, [GENERATOR, ...args], { encoding: "utf8" });

describe("cli/harnesses.json equals what the adapters say", () => {
  it("holds exactly what is built from the adapters and the Support Level table", () => {
    assert.deepEqual(
      shipped(),
      buildHarnesses(),
      "cli/harnesses.json is stale: run node scripts/gen_harnesses.mjs",
    );
  });

  it("passes the generator's own --check, which the publish workflow runs too", () => {
    const r = generator("--check");
    assert.equal(r.status, 0, r.stderr);
  });

  it("is what preflight reads", () => {
    assert.deepEqual(readHarnesses(), shipped());
  });

  it("is in the published package", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "cli", "package.json"), "utf8"));
    assert.ok(pkg.files.includes("harnesses.json"), "cli/package.json files must ship it");
  });
});

describe("what it holds for each built-in harness", () => {
  it("lists a harness for each adapter the kit has", () => {
    assert.deepEqual(Object.keys(shipped().harnesses), ["claude-code"]);
  });

  it("names every secret the adapter accepts, preferred first, each with where to get it", () => {
    const { secrets } = shipped().harnesses["claude-code"];
    assert.deepEqual(
      secrets.map((s) => s.name),
      ["claude_code_oauth_token", "anthropic_api_key"],
    );
    const accepted = Object.values(claudeCode().credentials.accepted).map((c) => c.secret);
    assert.deepEqual(secrets.map((s) => s.name).sort(), accepted.sort());
    for (const { name, whereToGet } of secrets) {
      assert.match(whereToGet, /^[^\n]+\.$/, `${name}: one line`);
    }
  });

  it("names its effort values, or says it has no effort setting, and its default model", () => {
    for (const [name, h] of Object.entries(shipped().harnesses)) {
      assert.equal(typeof h.noEffort, "boolean", name);
      assert.equal(h.effortValues.length === 0, h.noEffort, name);
      assert.match(h.defaultModel, /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/, name);
    }
    const claude = shipped().harnesses["claude-code"];
    assert.deepEqual(claude.effortValues, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(claude.defaultModel, "claude-opus-5-5");
  });

  it("holds a Support Level cell, a level and a run link, for every Stage", () => {
    assert.deepEqual(shipped().stages, STAGES);
    assert.deepEqual(SECURITY_STAGES, ["deep-scan", "security-audit"]);
    for (const [name, h] of Object.entries(shipped().harnesses)) {
      assert.deepEqual(Object.keys(h.supportLevels), STAGES, name);
      for (const [stage, cell] of Object.entries(h.supportLevels)) {
        const where = `${name} ${stage}`;
        // null: a Guard probe failed, so the pair has no level (ADR 0028).
        assert.ok(cell.level === null || SUPPORT_LEVELS.includes(cell.level), where);
        // A level above documented cites the run that earned it.
        if (cell.level === "tried" || cell.level === "verified") {
          assert.match(cell.run, /^https:\/\/github\.com\/[^\s]+\/actions\/runs\/\d+/, where);
        } else {
          assert.equal(cell.run, null, where);
        }
      }
    }
  });
});

/**
 * The shape the file has had since it first shipped, as `path: type`. A field
 * may be added to the file (and then here), never renamed or removed, and its
 * type never changes. `*` stands for each harness, Stage or list entry.
 */
const SHAPE = [
  "$comment: string",
  "stages: array",
  "stages.*: string",
  "harnesses: object",
  "harnesses.*.displayName: string",
  "harnesses.*.secrets: array",
  "harnesses.*.secrets.*.name: string",
  "harnesses.*.secrets.*.whereToGet: string",
  "harnesses.*.effortValues: array",
  "harnesses.*.noEffort: boolean",
  "harnesses.*.defaultModel: string",
  "harnesses.*.supportLevels: object",
  "harnesses.*.supportLevels.*.level: string|null",
  "harnesses.*.supportLevels.*.run: string|null",
];

/** Every value at `path` in `value`, and whether each step of the path was there. */
function at(value, path) {
  if (!path.length) return [value];
  const [key, ...rest] = path;
  if (key === "*") return Object.values(value).flatMap((v) => at(v, rest));
  assert.ok(Object.hasOwn(value, key), `${key} is gone`);
  return at(value[key], rest);
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

describe("the file's shape is grow-only", () => {
  it("still has every field it has shipped, with the same type", () => {
    const file = shipped();
    for (const entry of SHAPE) {
      const [path, types] = entry.split(": ");
      for (const value of at(file, path.split("."))) {
        assert.ok(types.split("|").includes(typeOf(value)), `${entry}, got ${typeOf(value)}`);
      }
    }
  });

  it("keeps every harness and Stage it has shipped", () => {
    assert.ok(Object.hasOwn(shipped().harnesses, "claude-code"));
    for (const stage of [
      "deep-scan",
      "security-audit",
      "review",
      "plan",
      "implement",
      "review-response",
    ]) {
      assert.ok(shipped().stages.includes(stage), stage);
    }
  });

  it("has every field of a harness in the docs' table", () => {
    const docs = readFileSync(join(ROOT, "docs", "harnesses.md"), "utf8");
    for (const field of Object.keys(shipped().harnesses["claude-code"])) {
      assert.match(docs, new RegExp(`^\\| \`${field}\` +\\|`, "m"), field);
    }
  });

  it("says so in the docs", () => {
    const docs = readFileSync(join(ROOT, "docs", "harnesses.md"), "utf8");
    assert.match(
      docs,
      /a field may be added, and is never renamed or removed/,
      "docs/harnesses.md states the grow-only rule",
    );
    assert.match(shipped().$comment, /grow-only/);
  });
});
