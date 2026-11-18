#!/usr/bin/env node
// Pattern guide skeleton: docs/patterns/external-skills-registry.md in Agent-kit.
//
// The external-skills check's shell: it reads the lock file, the approval
// list, the project skills folder and the other docs, and prints what the core
// finds. Every decision is in external-skills-core.mjs. Run it from the
// repository root, in CI and in a pre-commit hook.
//
//   <check command>
//
// Copy it into your repository, fill in each TODO(adopt), and delete the
// Pattern guide line above. Exit 0 when the registry agrees with itself, 1
// when it does not, 2 when it could not run.
import fs from "node:fs";
import path from "node:path";

import { lockedSkills, registryProblems } from "./external-skills-core.mjs";

// TODO(adopt): the file your installer writes, the approval list, and the
// folder project-scope skills are installed into.
const LOCK_FILE = "<path to skills-lock.json>";
const APPROVAL_LIST = "<path to approved-external-skills.md>";
const SKILLS_DIR = "<project skills folder>";
// TODO(adopt): every file or folder of docs that might restate the list.
const DOC_ROOTS = ["README.md", "<docs folder>", "<project skills folder>"];
const SKIP_DIRS = new Set([".git", "node_modules"]);

function markdownFiles(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.statSync(root).isFile()) return root.endsWith(".md") ? [root] : [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : markdownFiles(full);
    return entry.isFile() && entry.name.endsWith(".md") ? [full] : [];
  });
}

function main() {
  for (const file of [LOCK_FILE, APPROVAL_LIST, SKILLS_DIR]) {
    if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  }
  const lockText = fs.readFileSync(LOCK_FILE, "utf8");
  const listText = fs.readFileSync(APPROVAL_LIST, "utf8");
  const skillDirs = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  // An external skill's own folder is upstream's prose, not a doc of yours:
  // it may name its own package. The approval list is the one place that may.
  const upstream = lockedSkills(lockText).map(
    (entry) => path.resolve(SKILLS_DIR, entry.name) + path.sep,
  );
  const skip = (file) =>
    path.resolve(file) === path.resolve(APPROVAL_LIST) ||
    upstream.some((dir) => path.resolve(file).startsWith(dir));
  // A doc root that does not exist would make the restatement check read
  // nothing and pass. Nothing read is not a pass.
  const absent = DOC_ROOTS.filter((root) => !fs.existsSync(root));
  if (absent.length) throw new Error(`doc root ${absent[0]} not found; fix DOC_ROOTS`);
  const docs = {};
  for (const file of new Set(DOC_ROOTS.flatMap(markdownFiles))) {
    if (!skip(file)) docs[file] = fs.readFileSync(file, "utf8");
  }

  const problems = registryProblems({ lockText, listText, skillDirs, docs });
  for (const problem of problems) console.log(`  ${problem}`);
  if (problems.length) {
    console.log(`FAIL: ${problems.length} problem(s) in the external-skills registry`);
    return 1;
  }
  console.log(`PASS: ${skillDirs.length} skill folders, ${Object.keys(docs).length} docs read`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`external-skills check: ${error.message}`);
  process.exitCode = 2;
}
