#!/usr/bin/env node
// Pattern guide skeleton: docs/patterns/instruction-layout.md in Agent-kit.
//
// The instruction-layout check's shell: it reads the shared file, each harness
// adapter, the skill tree and each harness's skill folder, and prints what the
// core finds. Every decision is in instruction-layout-core.mjs. Run it from the
// repository root, in CI and in a pre-commit hook.
//
//   <check command>
//
// Copy it into your repository, fill in each TODO(adopt), and delete the
// Pattern guide line above. Exit 0 when the layout agrees with itself, 1 when
// it does not, 2 when it could not run.
import fs from "node:fs";
import path from "node:path";

import { layoutProblems } from "./instruction-layout-core.mjs";

// TODO(adopt): the one always-on file, and each harness adapter with the exact
// line that imports it in that harness's syntax. A harness with no import
// syntax gets a short pointer file instead; leave it out of this list.
const SHARED = "AGENTS.md";
const ADAPTERS = [{ path: "CLAUDE.md", importLine: "@AGENTS.md" }];
// TODO(adopt): the one skill tree, and each folder a harness reads that must
// be a link to it.
const SKILL_TREE = "<skill tree, such as .agents/skills>";
const SKILL_LINKS = [".claude/skills"];

function realOrNull(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

function kindOf(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return "missing";
  }
  if (stat.isSymbolicLink()) return "link";
  return stat.isDirectory() ? "directory" : "file";
}

function main() {
  for (const file of [SHARED, SKILL_TREE, ...ADAPTERS.map((adapter) => adapter.path)]) {
    if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  }
  const tree = fs.realpathSync(SKILL_TREE);
  const skills = {};
  for (const name of fs.readdirSync(SKILL_TREE)) {
    const file = path.join(SKILL_TREE, name, "SKILL.md");
    if (fs.existsSync(file)) skills[name] = fs.readFileSync(file, "utf8");
  }
  // A reference document's path is relative to the shared file, as its link is.
  const base = path.dirname(SHARED);
  const problems = layoutProblems({
    sharedFile: { path: SHARED, text: fs.readFileSync(SHARED, "utf8") },
    adapters: ADAPTERS.map((adapter) => ({
      ...adapter,
      text: fs.readFileSync(adapter.path, "utf8"),
    })),
    skills,
    links: SKILL_LINKS.map((link) => {
      const kind = kindOf(link);
      return { path: link, kind, resolves: kind === "link" ? realOrNull(link) : null };
    }),
    tree,
    exists: (file) => fs.existsSync(path.join(base, decodeURIComponent(file))),
  });
  for (const problem of problems) console.log(`  ${problem}`);
  if (problems.length) {
    console.log(`FAIL: ${problems.length} problem(s) in the instruction layout`);
    return 1;
  }
  console.log(
    `PASS: ${ADAPTERS.length} adapter(s), ${Object.keys(skills).length} skill(s), ${SKILL_LINKS.length} link(s)`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`instruction-layout check: ${error.message}`);
  process.exitCode = 2;
}
