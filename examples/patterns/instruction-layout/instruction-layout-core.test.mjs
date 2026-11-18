// Pattern guide skeleton: docs/patterns/instruction-layout.md in Agent-kit.
//
// The contract suite for instruction-layout-core.mjs. A few cases to start
// from: keep one test per rule in docs/patterns/instruction-layout.md, and add
// one every time the layout drifts in a way the check did not catch.
//
// Run with: node --test <path>/instruction-layout-core.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  MIN_WORDS,
  REFERENCES_HEADING,
  SKILLS_HEADING,
  chosenSkills,
  layoutProblems,
  sentences,
} from "./instruction-layout-core.mjs";

const RULE = "A refused tool call is the human's decision, so stop and ask before going on.";
const STEP = "Stage each file by name and never stage the whole working tree at once.";

const shared = (extra = "") =>
  [
    "# Agent guide",
    "",
    REFERENCES_HEADING,
    "",
    "- [Command reference](docs/commands.md): a task names a check you have not run.",
    "",
    "## Rules",
    "",
    `- ${RULE}`,
    "",
    SKILLS_HEADING,
    "",
    "- When committing: `.agents/skills/commit/SKILL.md`",
    "- When opening a pull request: `.agents/skills/pull-request/SKILL.md`",
    extra,
  ].join("\n");
const adapter = (extra = "") =>
  ["@AGENTS.md", "", "# Claude Code", "", "- A hook only this harness runs.", extra].join("\n");
const skills = {
  commit: `---\nname: commit\n---\n\n1. ${STEP}\n`,
  "pull-request": "# Pull request\n",
};
const tree = "/repo/.agents/skills";
const good = {
  sharedFile: { path: "AGENTS.md", text: shared() },
  adapters: [{ path: "CLAUDE.md", text: adapter(), importLine: "@AGENTS.md" }],
  skills,
  links: [{ path: ".claude/skills", kind: "link", resolves: tree }],
  tree,
  exists: (file) => file === "docs/commands.md",
};
const problems = (overrides) => layoutProblems({ ...good, ...overrides });
const one = (overrides, pattern) => {
  const found = problems(overrides);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], pattern);
};

test("a layout that agrees with itself has no problems", () => {
  assert.deepEqual(problems({}), []);
});

test("an adapter that does not import the shared file fails", () => {
  const text = adapter().replace("@AGENTS.md", "See AGENTS.md.");
  one({ adapters: [{ ...good.adapters[0], text }] }, /does not import AGENTS\.md/);
});

test("an import line inside a code fence is not an import", () => {
  const text = adapter().replace("@AGENTS.md", "```text\n@AGENTS.md\n```");
  one({ adapters: [{ ...good.adapters[0], text }] }, /does not import/);
});

test("an adapter that restates a shared sentence fails, however it is marked up", () => {
  const restated =
    "- A **refused** tool call is the [human's](x.md) decision, so stop\n  and ask before going on";
  one(
    { adapters: [{ ...good.adapters[0], text: adapter(restated) }] },
    /CLAUDE\.md restates AGENTS\.md/,
  );
});

test("a sentence that ends a list item is compared on its own", () => {
  const restated = `- Harness note. ${RULE}\n- Another harness note that follows it in the list.`;
  one(
    { adapters: [{ ...good.adapters[0], text: adapter(restated) }] },
    /restates AGENTS\.md: "a refused tool call/,
  );
});

test("a short sentence repeated by accident is not a restatement", () => {
  assert.ok(MIN_WORDS > 3);
  const text = adapter("\nRun the tests.\n");
  const sharedText = shared("\nRun the tests.\n");
  assert.deepEqual(
    problems({
      sharedFile: { path: "AGENTS.md", text: sharedText },
      adapters: [{ ...good.adapters[0], text }],
    }),
    [],
  );
});

test("a sentence in an HTML comment or a code fence is not compared", () => {
  const text = adapter(`\n<!-- ${RULE} -->\n\n\`\`\`text\n${RULE}\n\`\`\`\n`);
  assert.deepEqual(problems({ adapters: [{ ...good.adapters[0], text }] }), []);
});

test("the shared file must have its skills section", () => {
  const text = shared().replace(SKILLS_HEADING, "## Workflows");
  one({ sharedFile: { path: "AGENTS.md", text } }, /has no '## Skills' section/);
});

test("a chooser that names a skill the tree does not hold fails", () => {
  const text = shared("- When releasing: `.agents/skills/release/SKILL.md`");
  one({ sharedFile: { path: "AGENTS.md", text } }, /chooses skill 'release'/);
});

test("a chooser that names no skill fails", () => {
  const text = shared("- When releasing: run the release script, then tag it.");
  one({ sharedFile: { path: "AGENTS.md", text } }, /chooser names no/);
});

test("numbered steps under the skills heading fail", () => {
  const text = shared("\n1. Stage the files.\n2. Run the hooks.");
  const found = problems({ sharedFile: { path: "AGENTS.md", text } });
  assert.ok(
    found.some((p) => /holds numbered steps/.test(p)),
    found.join("\n"),
  );
});

test("a nested list under a chooser fails", () => {
  const text = shared().replace(
    "`.agents/skills/commit/SKILL.md`",
    "`.agents/skills/commit/SKILL.md`\n  - stage by name",
  );
  const found = problems({ sharedFile: { path: "AGENTS.md", text } });
  assert.ok(
    found.some((p) => /holds a nested list/.test(p)),
    found.join("\n"),
  );
});

test("a loose item's indented second paragraph belongs to its item", () => {
  const chooser = "- When committing: `.agents/skills/commit/SKILL.md`";
  const reference =
    "- [Command reference](docs/commands.md): a task names a check you have not run.";
  const text = shared()
    .replace(chooser, `${chooser}\n\n  Use this for every commit in this repository.`)
    .replace(reference, `${reference}\n\n  It lists every check in one table.`);
  assert.deepEqual(problems({ sharedFile: { path: "AGENTS.md", text } }), []);
});

test("an unindented paragraph after a list is not read into its last item", () => {
  const text = shared("\nThese lines say which skill to load, nothing more.");
  assert.deepEqual(problems({ sharedFile: { path: "AGENTS.md", text } }), []);
});

test("a section after the skills section is not read as choosers", () => {
  const text = shared("\n## Do not\n\n- Do not run the deploy script by hand from a laptop.");
  assert.deepEqual(problems({ sharedFile: { path: "AGENTS.md", text } }), []);
});

test("the shared file restating a skill's step fails", () => {
  const text = shared(`\n## Commits\n\n${STEP}`);
  one({ sharedFile: { path: "AGENTS.md", text } }, /restates skill 'commit'/);
});

test("a skill's frontmatter is not compared", () => {
  const description = "Use when committing a change in this repository and only then";
  const withFrontmatter = { ...skills, commit: `---\ndescription: ${description}\n---\n\nBody.\n` };
  const text = shared(`\n## Commits\n\n${description}.`);
  assert.deepEqual(
    problems({ sharedFile: { path: "AGENTS.md", text }, skills: withFrontmatter }),
    [],
  );
});

test("a reference document with no trigger fails", () => {
  const text = shared().replace(": a task names a check you have not run.", "");
  one({ sharedFile: { path: "AGENTS.md", text } }, /'Command reference' has no trigger/);
});

test("a reference document whose file is missing fails", () => {
  one({ exists: () => false }, /points at docs\/commands\.md, which does not exist/);
});

test("a reference that is not a link fails", () => {
  const text = shared().replace("[Command reference](docs/commands.md)", "The command reference");
  one({ sharedFile: { path: "AGENTS.md", text } }, /does not start with a link/);
});

test("a harness skill folder that is a copy, a file, missing or misdirected fails", () => {
  for (const [link, pattern] of [
    [{ kind: "directory", resolves: null }, /is a folder, not a link/],
    [{ kind: "file", resolves: null }, /is a file, not a link/],
    [{ kind: "missing", resolves: null }, /is missing/],
    [{ kind: "link", resolves: null }, /leads nowhere/],
    [{ kind: "link", resolves: "/repo/old-skills" }, /leads to \/repo\/old-skills/],
  ]) {
    one({ links: [{ path: ".claude/skills", ...link }] }, pattern);
  }
});

test("chosenSkills reads placeholder names too", () => {
  assert.deepEqual(chosenSkills("When committing: `<skill-tree>/<commit-skill>/SKILL.md`"), [
    "<commit-skill>",
  ]);
});

test("sentences splits on sentence ends and drops final punctuation", () => {
  const found = sentences(
    "One two three four five six seven eight. Nine ten eleven twelve thirteen fourteen fifteen sixteen!",
  );
  assert.deepEqual(
    [...found],
    [
      "one two three four five six seven eight",
      "nine ten eleven twelve thirteen fourteen fifteen sixteen",
    ],
  );
});

test("the skeleton's own templates pass the check", () => {
  const read = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");
  const sharedText = read("./AGENTS.md.template");
  const choices = sharedText.split("\n").flatMap((line) => chosenSkills(line));
  assert.ok(choices.length >= 2, "the template should show at least two choosers");
  const templateSkills = Object.fromEntries(choices.map((name) => [name, ""]));
  // The skeleton's own skill is in the tree an adopter copies it into.
  templateSkills["<placing-instructions>"] = read("./SKILL.md");
  assert.deepEqual(
    layoutProblems({
      sharedFile: { path: "AGENTS.md", text: sharedText },
      adapters: [
        { path: "CLAUDE.md", text: read("./CLAUDE.md.template"), importLine: "@AGENTS.md" },
      ],
      skills: templateSkills,
      links: [{ path: ".claude/skills", kind: "link", resolves: tree }],
      tree,
      exists: () => true,
    }),
    [],
  );
});
