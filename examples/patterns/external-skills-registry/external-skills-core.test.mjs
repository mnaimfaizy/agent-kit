// Pattern guide skeleton: docs/patterns/external-skills-registry.md in Agent-kit.
//
// The contract suite for external-skills-core.mjs. A few cases to start from:
// keep one test per rule in docs/patterns/external-skills-registry.md, and add
// one every time the registry drifts in a way the check did not catch.
//
// Run with: node --test <path>/external-skills-core.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  APPROVED_HEADING,
  approvedSkills,
  lockedSkills,
  registryProblems,
} from "./external-skills-core.mjs";

const lock = (...names) =>
  JSON.stringify({
    version: 1,
    skills: Object.fromEntries(names.map((name) => [name, { source: "acme/skills" }])),
  });
const list = (entries, extra = "") =>
  [
    "# Approved external skills",
    "",
    APPROVED_HEADING,
    "",
    ...entries.map((entry) => `- \`${entry}\`: trigger.`),
    "",
    "## Excluded",
    "",
    "- `acme/skills@rejected`: conflicts with a rule.",
    extra,
  ].join("\n");
const check = (overrides = {}) =>
  registryProblems({
    lockText: lock("alpha", "beta"),
    listText: list(["acme/skills@alpha", "acme/skills@beta"]),
    skillDirs: ["alpha", "beta", "our-own-skill"],
    ...overrides,
  });

test("a lock file and an approval list that agree have no problems", () => {
  assert.deepEqual(check(), []);
});

test("only the approved section is read: an excluded entry is not an approval", () => {
  assert.deepEqual(
    approvedSkills(list(["acme/skills@alpha"])).map((entry) => entry.key),
    ["acme/skills@alpha"],
  );
});

test("an approval with no install is a problem", () => {
  assert.deepEqual(check({ lockText: lock("alpha"), skillDirs: ["alpha"] }), [
    "acme/skills@beta is approved but not in the lock file: install it, or remove the approval",
  ]);
});

test("an install with no approval is a problem", () => {
  assert.deepEqual(check({ listText: list(["acme/skills@alpha"]) }), [
    "acme/skills@beta is in the lock file but not approved: approve it, or uninstall it",
  ]);
});

test("the same skill name from another source is not the approved one", () => {
  const problems = check({ listText: list(["acme/skills@alpha", "other/skills@beta"]) });
  assert.deepEqual(problems, [
    "other/skills@beta is approved but not in the lock file: install it, or remove the approval",
    "acme/skills@beta is in the lock file but not approved: approve it, or uninstall it",
  ]);
});

test("a locked skill whose folder is missing is a problem", () => {
  assert.deepEqual(check({ skillDirs: ["alpha"] }), [
    "acme/skills@beta is in the lock file but its folder is missing: reinstall it from the lock",
  ]);
});

test("a personal-scope tier is refused", () => {
  const listText = list(
    ["acme/skills@alpha", "acme/skills@beta"],
    "\n## Personal scope\n\n- `acme/skills@gamma`",
  );
  assert.match(check({ listText }).join("\n"), /personal-scope tier/);
});

test("an entry approved twice is a problem", () => {
  const listText = list(["acme/skills@alpha", "acme/skills@beta", "acme/skills@alpha"]);
  assert.deepEqual(check({ listText }), ["the approval list names acme/skills@alpha twice"]);
});

test("another doc that restates an entry is a problem, and one that links is not", () => {
  const docs = {
    "README.md":
      "Skills from outside: see the [approval list](skills/approved-external-skills.md).",
    "skills/README.md": "Installed:\n- `acme/skills@alpha`\n- `acme/skills@beta`",
    "docs/history.md": "We once tried `acme/skills@rejected`.",
  };
  assert.deepEqual(check({ docs }), [
    "skills/README.md:2 restates acme/skills@alpha: link to the approval list instead",
    "skills/README.md:3 restates acme/skills@beta: link to the approval list instead",
  ]);
});

test("a lock file the check cannot read stops it, rather than passing", () => {
  assert.throws(() => lockedSkills("{"), /not valid JSON/);
  assert.throws(() => lockedSkills('{"version": 1}'), /no skills object/);
  assert.throws(() => lockedSkills('{"skills": {"alpha": {}}}'), /alpha entry has no source/);
});

test("an approval list without the approved section stops the check", () => {
  assert.throws(() => approvedSkills("# Approved\n\n- `acme/skills@alpha`"), /has no "## Approved/);
});

test("the skeleton's example lock file and approval list agree", () => {
  const here = new URL(".", import.meta.url);
  const lockText = fs.readFileSync(new URL("skills-lock.json", here), "utf8");
  const listText = fs.readFileSync(new URL("approved-external-skills.md", here), "utf8");
  assert.deepEqual(
    registryProblems({ lockText, listText, skillDirs: ["api-style", "release-notes"] }),
    [],
  );
});
