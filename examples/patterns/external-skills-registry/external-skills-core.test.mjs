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

test("a personal tier at any heading level, with or without the word scope, is refused", () => {
  for (const heading of [
    "## Personal skills (not committed)",
    "### Personal scope",
    "## Global installs",
  ]) {
    const listText = list(
      ["acme/skills@alpha", "acme/skills@beta"],
      `\n${heading}\n\n- \`acme/skills@gamma\``,
    );
    assert.match(check({ listText }).join("\n"), /personal-scope tier/, heading);
  }
});

test("a word in a heading, an entry or a fenced shell comment is not a personal tier", () => {
  const extra = [
    "```sh",
    "# add at project scope, never --global",
    "<installer add command>",
    "```",
    "## Excluded: tried as a global install",
    "- `acme/skills@global-config`: overlaps a rule here.",
    "### Global-config notes",
  ].join("\n");
  assert.deepEqual(check({ listText: list(["acme/skills@alpha", "acme/skills@beta"], extra) }), []);
});

test("a personal tier named by its scope anywhere in the heading is refused", () => {
  const listText = list(["acme/skills@alpha", "acme/skills@beta"], "\n## Optional: user scope\n");
  assert.match(check({ listText }).join("\n"), /personal-scope tier/);
});

test("the approved section ends at a heading of its level, not at a shell comment in a fence", () => {
  const listText = [
    APPROVED_HEADING,
    "- `acme/skills@alpha`",
    "```sh",
    "# refresh every approved skill",
    "<installer update command>",
    "```",
    "- `acme/skills@beta`",
    "### Notes",
    "- `acme/skills@gamma`",
    "## Excluded",
    "- `acme/skills@delta`",
  ].join("\n");
  assert.deepEqual(
    approvedSkills(listText).map((entry) => entry.name),
    ["alpha", "beta", "gamma"],
  );
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

test("a restatement without backticks is caught: an install command, plain text or link text", () => {
  const docs = {
    "a.md": "```sh\n<installer> add acme/skills@alpha\n```",
    "b.md": "We use acme/skills@beta for this.",
    "e.md": "We use acme/skills@beta. And acme/skills@alpha-, too.",
    "c.md": "See [acme/skills@alpha](https://example.com).",
    "d.md": "Not a key: https://host/acme/skills@alpha or bigacme/skills@alphabet.",
  };
  assert.deepEqual(check({ docs }), [
    "a.md:2 restates acme/skills@alpha: link to the approval list instead",
    "b.md:1 restates acme/skills@beta: link to the approval list instead",
    "c.md:1 restates acme/skills@alpha: link to the approval list instead",
    "e.md:1 restates acme/skills@beta: link to the approval list instead",
    "e.md:1 restates acme/skills@alpha: link to the approval list instead",
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
