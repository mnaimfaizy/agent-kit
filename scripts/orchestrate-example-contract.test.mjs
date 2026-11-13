/**
 * Contract test: `examples/orchestrate.config.yml`, the config a repository
 * copies to start using `orchestrate`, passes the skill's own check
 * (`config.mjs check`) with nothing left to ask, shows every key the reader
 * accepts, and carries a comment on every key. A key added to `config.mjs`
 * fails here until the example (and docs/orchestrate.md) show it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as config from "../.claude/skills/orchestrate/config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const EXAMPLE = read("examples/orchestrate.config.yml");
const FILE = "orchestrate.config.yml";

/**
 * A repository holding the example as its config. The documents it names
 * (`read_first`, the `triage_labels` document) are there, as they must be in
 * a repository that copies it.
 */
function check() {
  const { config: parsed } = config.parseConfig(FILE, EXAMPLE);
  const present = new Set([...(parsed.read_first ?? []), parsed.triage_labels]);
  const { code, out } = config.main(["check"], {
    read: (path) => (path === FILE ? EXAMPLE : null),
    exists: (path) => present.has(path),
  });
  return { code, result: JSON.parse(out) };
}

/** Every key path in a parsed config, list indexes dropped: `routes.commit`. */
function keyPaths(value, prefix = "") {
  if (Array.isArray(value) || value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...keyPaths(child, path)];
  });
}

describe("examples/orchestrate.config.yml", () => {
  it("passes `config.mjs check` with no problems and nothing left to ask", () => {
    const { code, result } = check();
    assert.equal(code, 0, JSON.stringify(result.problems));
    assert.equal(result.path, FILE);
    assert.deepEqual(result.problems, []);
    assert.equal(result.readiness.ready, true);
    assert.deepEqual(result.readiness.needs, []);
  });

  it("reports the documents it names as problems when a repository lacks them", () => {
    const { code, out } = config.main(["check"], {
      read: (path) => (path === FILE ? EXAMPLE : null),
      exists: () => false,
    });
    assert.equal(code, 1);
    assert.match(JSON.parse(out).problems.join("\n"), /read_first\[0\]/);
  });

  it("shows every key config.mjs accepts", () => {
    const { config: parsed } = config.parseConfig(FILE, EXAMPLE);
    const shown = new Set(keyPaths(parsed));
    const sub = (section, keys) => keys.map((k) => `${section}.${k}`);
    const accepted = [
      ...Object.keys(config.SECTIONS),
      ...sub("routes", config.ROUTE_KEYS),
      ...sub("skills", config.SKILL_KEYS),
      ...sub("models", config.MODEL_KEYS),
      ...sub("limits", config.LIMIT_KEYS),
      ...sub("decisions", config.DECISION_KEYS),
      ...sub("ready_to_merge", config.READY_KEYS),
      ...sub("spec", config.SPEC_KEYS),
    ];
    assert.deepEqual(
      accepted.filter((key) => !shown.has(key)),
      [],
      "keys config.mjs accepts that the example does not show",
    );
  });

  it("has a comment on every key", () => {
    const bare = EXAMPLE.split("\n")
      .map((line, n) => ({ line, n: n + 1 }))
      .filter(({ line }) => /^\s*[a-z_]+:/.test(line) && !/ # /.test(line));
    assert.deepEqual(
      bare.map(({ n, line }) => `${n}: ${line}`),
      [],
      "key lines with no trailing comment",
    );
  });

  it("holds no sign-in value and no hosted address", () => {
    const values = JSON.stringify(config.parseConfig(FILE, EXAMPLE).config);
    assert.doesNotMatch(values, /password|token|secret/i);
    assert.doesNotMatch(values, /https?:\/\//);
  });
});
