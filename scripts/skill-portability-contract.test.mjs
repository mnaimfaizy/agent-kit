/**
 * Contract test: every User-scope skill is portable.
 *
 * A User-scope skill (GLOSSARY.md, ADR 0002) works from a user's own skills
 * directory in any repository, so its folder alone must be the whole skill.
 * For every `.claude/skills/<name>/` whose SKILL.md declares
 * `metadata.agent-kit-scope: user`:
 *
 *   - no script imports anything but a Node built-in or a file in the folder;
 *   - no document links outside the folder, or to a file it does not ship;
 *   - copied alone into a directory outside any repository, its links still
 *     resolve and the suites it ships still pass.
 *
 * Repo-scope skills are exempt: they need supporting files in the repository.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Static `import … from`, bare `import "…"`, `export … from`, `import(…)` and `require(…)`.
const IMPORTS = [
  /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
// Inline `[text](target)` and reference definitions `[label]: target`; a footnote `[^1]: …` is not a link.
const LINKS = [
  // A target is `<anything but >>` (spaces allowed) or bare; then an optional #anchor and title.
  /\]\((?:<([^>]*)>|([^)#\s>]+))(?:#[^)\s]*)?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g,
  /^[ \t]{0,3}\[(?!\^)[^\]]+\]:\s*(?:<([^>]*)>|([^\s>#]+))/gm,
];
const SCRIPT = /\.(?:mjs|cjs|js)$/;
// Test data, not part of what the skill links or imports.
const SKIPPED_DIRS = new Set(["fixtures", "node_modules"]);

/** Every file under `dir` (fixtures aside), as `/`-separated paths relative to `dir`. */
function skillFiles(dir, sub = "") {
  return readdirSync(join(dir, sub), { withFileTypes: true }).flatMap((entry) => {
    const path = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : skillFiles(dir, path);
    return entry.isFile() ? [path] : [];
  });
}

/** True when `target`, relative to the file `from` in `dir`, names a file inside `dir`. */
function containsFile(dir, from, target) {
  const path = resolve(dir, dirname(from), target);
  const inside = relative(dir, path);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) && existsSync(path);
}

/** One message per import or link in `dir` that a copy of the folder alone would not carry. */
function portabilityProblems(dir) {
  const builtins = new Set(builtinModules);
  const files = skillFiles(dir).sort((a, b) => a.localeCompare(b));
  const problems = [];
  const outside = (file, verb, target) =>
    problems.push(`${file} ${verb} ${target}, which a copy of this folder does not carry`);
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    if (SCRIPT.test(file))
      for (const [, specifier] of IMPORTS.flatMap((pattern) => [...text.matchAll(pattern)])) {
        const builtin = specifier.startsWith("node:") || builtins.has(specifier.split("/")[0]);
        const local = /^\.\.?\//.test(specifier) && containsFile(dir, file, specifier);
        if (!builtin && !local) outside(file, "imports", specifier);
      }
    if (file.endsWith(".md"))
      for (const [, angled, bare] of LINKS.flatMap((pattern) => [...text.matchAll(pattern)])) {
        const target = (angled ?? bare).split("#")[0];
        if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        if (!containsFile(dir, file, target)) outside(file, "links", target);
      }
  }
  return problems;
}

const scratch = mkdtempSync(join(tmpdir(), "skill-portability-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A scratch skill folder holding `files` (name → contents). */
function fixtureSkill(name, files) {
  const dir = join(scratch, "fixtures", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

test("an import from outside the folder is named", () => {
  const dir = fixtureSkill("bad-import", {
    "SKILL.md": "---\nname: bad-import\n---\n",
    "run.mjs": [
      'import { readFileSync } from "node:fs";',
      'import { join } from "path";',
      'import { helper } from "./helper.mjs";',
      'import { shared } from "../other-skill/shared.mjs";',
      'export { thing } from "some-package";',
      "",
    ].join("\n"),
    "helper.mjs": "export const helper = 1;\n",
  });
  assert.deepEqual(portabilityProblems(dir), [
    "run.mjs imports ../other-skill/shared.mjs, which a copy of this folder does not carry",
    "run.mjs imports some-package, which a copy of this folder does not carry",
  ]);
});

test("a link outside the folder, or to a file it does not ship, is named", () => {
  const dir = fixtureSkill("bad-link", {
    "SKILL.md": [
      "---",
      "name: bad-link",
      "---",
      "See [the format](FORMAT.md#fields), [the web](https://example.com/x.md),",
      "[the sibling](../security-finding-triage/SKILL.md), [the repo](../../../docs/adopt.md)",
      "and [a typo](FROMAT.md). [Titled](../titled.md \"Adopt\") and [titled local](FORMAT.md 'Format').",
      "Spaces: [mine](<../my notes.md>), [kept](<FORMAT.md#fields>) and [theirs][t].",
      "",
      "[t]: <../their notes.md>",
      "",
    ].join("\n"),
    "FORMAT.md": "# Format\n",
  });
  assert.deepEqual(portabilityProblems(dir), [
    "SKILL.md links ../security-finding-triage/SKILL.md, which a copy of this folder does not carry",
    "SKILL.md links ../../../docs/adopt.md, which a copy of this folder does not carry",
    "SKILL.md links FROMAT.md, which a copy of this folder does not carry",
    "SKILL.md links ../titled.md, which a copy of this folder does not carry",
    "SKILL.md links ../my notes.md, which a copy of this folder does not carry",
    "SKILL.md links ../their notes.md, which a copy of this folder does not carry",
  ]);
});

test("dynamic imports, require, subfolder documents and reference links are checked too", () => {
  const dir = fixtureSkill("subtle", {
    "SKILL.md":
      "---\nname: subtle\n---\nSee [the guide][guide].\n\n[guide]: ../../docs/guide.md\n[local]: notes/NOTES.md\n",
    "notes/NOTES.md": "Back to [the skill](../SKILL.md) and [the repo](../../../README.md).\n",
    "fixtures/case.md": "A test fixture may [point anywhere](../../../elsewhere.md).\n",
    "load.mjs": [
      'const { a } = await import("./notes/a.mjs");',
      'const { b } = await import("../other/b.mjs");',
      'const c = require("left-pad");',
      "",
    ].join("\n"),
    "notes/a.mjs": "export const a = 1;\n",
  });
  assert.deepEqual(portabilityProblems(dir), [
    "load.mjs imports ../other/b.mjs, which a copy of this folder does not carry",
    "load.mjs imports left-pad, which a copy of this folder does not carry",
    "notes/NOTES.md links ../../../README.md, which a copy of this folder does not carry",
    "SKILL.md links ../../docs/guide.md, which a copy of this folder does not carry",
  ]);
});

test("a footnote definition is not a link", () => {
  const dir = fixtureSkill("footnote", {
    "SKILL.md":
      "---\nname: footnote\n---\nPinned to the release.[^1]\n\n[^1]: See the upstream changelog.\n",
  });
  assert.deepEqual(portabilityProblems(dir), []);
});

test("a skill folder with no SKILL.md declares no scope, without stopping the suite", () => {
  const dir = fixtureSkill("no-skill-md", { "README.md": "Not a skill yet.\n" });
  assert.equal(declaredScope(join(dir, "SKILL.md")), NO_SKILL_MD);
});

test("a quoted or flow-style scope declaration is read", () => {
  const quoted = fixtureSkill("quoted", {
    "SKILL.md": '---\nname: q\nmetadata:\n  agent-kit-scope: "user"\n---\n',
  });
  const flow = fixtureSkill("flow", {
    "SKILL.md": "---\nname: f\nmetadata: { agent-kit-scope: repo }\n---\n",
  });
  assert.equal(declaredScope(join(quoted, "SKILL.md")), "user");
  assert.equal(declaredScope(join(flow, "SKILL.md")), "repo");
});

const NO_SKILL_MD = "(no SKILL.md)";

/** `metadata.agent-kit-scope` from a SKILL.md's frontmatter, null when it declares none, or NO_SKILL_MD. */
function declaredScope(skillMd) {
  if (!existsSync(skillMd)) return NO_SKILL_MD;
  const text = readFileSync(skillMd, "utf8").replace(/^﻿/, "");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[1] ?? "";
  // Block (`metadata:\n  agent-kit-scope: user`) or flow (`metadata: { agent-kit-scope: user }`),
  // quoted or not: skills-list-contract.test.py reads the same field as YAML.
  return /\bagent-kit-scope[ \t]*:[ \t]*["']?([A-Za-z0-9_-]+)/.exec(frontmatter)?.[1] ?? null;
}

const SKILLS = join(ROOT, ".claude", "skills");
const skills = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({ name: entry.name, dir: join(SKILLS, entry.name) }))
  .map((skill) => ({ ...skill, scope: declaredScope(join(skill.dir, "SKILL.md")) }));
const userScope = skills.filter((skill) => skill.scope === "user");

test("the User-scope skills are found, and Repo-scope skills are exempt", () => {
  // skills-list-contract.test.py makes every skill declare user or repo.
  assert.ok(userScope.length > 0, "no skill declares agent-kit-scope: user");
  for (const skill of skills)
    assert.ok(
      ["user", "repo"].includes(skill.scope),
      skill.scope === NO_SKILL_MD
        ? `.claude/skills/${skill.name}/ has no SKILL.md`
        : `${skill.name}: agent-kit-scope is ${skill.scope}, expected user or repo`,
    );
  assert.ok(
    !userScope.some((skill) => skill.name === "security-audit"),
    "security-audit is Repo-scope (it needs a Threat pack in the repository)",
  );
});

for (const skill of userScope) {
  test(`${skill.name} imports and links nothing outside its folder`, () => {
    assert.deepEqual(portabilityProblems(skill.dir), []);
  });
}

/**
 * Copy `dir` alone into a skills directory outside every repository, as a
 * User-scope install does, and return what breaks there: links or imports the
 * copy does not carry, and the suites the folder ships failing in the copy.
 */
function outsideRepoProblems(dir) {
  const name = basename(dir);
  const copy = join(mkdtempSync(join(scratch, "home-")), "skills", name);
  mkdirSync(dirname(copy), { recursive: true });
  cpSync(dir, copy, { recursive: true });
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: copy, encoding: "utf8" });
  if (git.status === 0)
    return [
      `${name}: the temporary directory ${copy} is inside a repository, so nothing was checked`,
    ];
  const problems = portabilityProblems(copy).map((problem) => `${name}: ${problem}`);
  const suites = readdirSync(copy).filter((file) => file.endsWith(".test.mjs"));
  if (suites.length > 0) {
    const run = spawnSync(process.execPath, ["--test", ...suites], {
      cwd: copy,
      encoding: "utf8",
      // Under a test runner, an inherited NODE_TEST_CONTEXT makes the child report to
      // its parent and exit 0 even when its tests fail.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    if (run.status !== 0)
      problems.push(
        `${name}: its suites fail when copied outside any repository:\n${(run.stdout + run.stderr).slice(-2000)}`,
      );
  }
  return problems;
}

test("a skill whose suite needs a surrounding repository fails outside one", () => {
  const dir = fixtureSkill("needs-repo", {
    "SKILL.md": "---\nname: needs-repo\n---\n",
    "where.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { spawnSync } from "node:child_process";',
      'import { test } from "node:test";',
      'test("runs inside a git repository", () => {',
      '  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dirname });',
      "  assert.equal(git.status, 0);",
      "});",
      "",
    ].join("\n"),
  });
  const problems = outsideRepoProblems(dir);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /^needs-repo: its suites fail when copied outside any repository/);
});

for (const skill of userScope) {
  test(`${skill.name} works copied alone outside any repository`, () => {
    assert.deepEqual(outsideRepoProblems(skill.dir), []);
  });
}
