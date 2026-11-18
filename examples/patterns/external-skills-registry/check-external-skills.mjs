#!/usr/bin/env node
// Pattern guide skeleton: docs/patterns/external-skills-registry.md in Agent-kit.
//
// The external-skills check's shell: it reads the lock file, the approval
// list, the project-scope skills folder and the other docs, and prints what the core
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
const SKILLS_DIR = "<project-scope skills folder>";
// TODO(adopt): every file or folder of docs that might restate the list.
const DOC_ROOTS = ["README.md", "<docs folder>", "<project-scope skills folder>"];
const SKIP_DIRS = new Set([".git", "node_modules"]);

// fs.statSync follows a symlink, so a skill folder an installer links in from
// a shared copy counts as a folder. A broken link counts as nothing.
function statOf(full) {
  try {
    return fs.statSync(full);
  } catch {
    return null;
  }
}

function markdownFiles(root, seen = new Set()) {
  const stat = statOf(root);
  if (!stat) return [];
  if (stat.isFile()) return root.endsWith(".md") ? [root] : [];
  // A linked folder can point back up the tree; read each real folder once.
  const real = fs.realpathSync(root);
  if (seen.has(real)) return [];
  seen.add(real);
  return fs.readdirSync(root).flatMap((name) => {
    const full = path.join(root, name);
    const entry = statOf(full);
    if (entry?.isDirectory()) return SKIP_DIRS.has(name) ? [] : markdownFiles(full, seen);
    return entry?.isFile() && name.endsWith(".md") ? [full] : [];
  });
}

function main() {
  for (const file of [LOCK_FILE, APPROVAL_LIST, SKILLS_DIR]) {
    if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  }
  const lockText = fs.readFileSync(LOCK_FILE, "utf8");
  const listText = fs.readFileSync(APPROVAL_LIST, "utf8");
  const skillDirs = fs
    .readdirSync(SKILLS_DIR)
    .filter((name) => statOf(path.join(SKILLS_DIR, name))?.isDirectory());

  // An external skill's own folder is upstream's prose, not a doc of yours:
  // it may name its own package. The approval list is the one place that may.
  // Compared by real path, so a file reached through a link is still known.
  const upstream = lockedSkills(lockText)
    .map((entry) => path.join(SKILLS_DIR, entry.name))
    .filter((dir) => statOf(dir))
    .map((dir) => fs.realpathSync(dir) + path.sep);
  const approvalList = fs.realpathSync(APPROVAL_LIST);
  const skip = (real) => real === approvalList || upstream.some((dir) => real.startsWith(dir));
  // A doc root that does not exist would make the restatement check read
  // nothing and pass. Nothing read is not a pass.
  const absent = DOC_ROOTS.filter((root) => !fs.existsSync(root));
  if (absent.length) throw new Error(`doc root ${absent[0]} not found; fix DOC_ROOTS`);
  // One set of seen folders across every root, and one read per real file.
  const seen = new Set();
  const read = new Set();
  const docs = {};
  for (const file of DOC_ROOTS.flatMap((root) => markdownFiles(root, seen))) {
    const real = fs.realpathSync(file);
    if (read.has(real) || skip(real)) continue;
    read.add(real);
    docs[file] = fs.readFileSync(file, "utf8");
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
