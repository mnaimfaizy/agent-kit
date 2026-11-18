#!/usr/bin/env node
// Pattern guide skeleton: docs/patterns/sub-agent-sync.md in Agent-kit.
//
// The sub-agent generator's shell: it reads the canonical folder, the model
// policy and each harness's folder, and writes or reports. Every decision is
// in sync-agents-core.mjs. Run it from the repository root.
//
//   <generator command> --check            exit 1 if any copy is missing, stale or extra
//   <generator command> --apply            write every copy, delete extras
//   <generator command> --apply --keep-extra
//
// Copy it into your repository, fill in each TODO(adopt), and delete the
// Pattern guide line above. Exit 0 when in sync (or written), 1 on drift
// under --check, 2 when it could not run.
import fs from "node:fs";
import path from "node:path";

import {
  CANONICAL_DIR,
  CANONICAL_SUFFIX,
  HARNESSES,
  parseCanonical,
  planSync,
} from "./sync-agents-core.mjs";

// TODO(adopt): where the model policy lives.
const MODELS_FILE = "<path to agent-models.json>";

const USAGE = "usage: sync-agents.mjs --check | --apply [--keep-extra]";

function parseArgs(argv) {
  const args = new Set(argv);
  const known = new Set(["--check", "--apply", "--keep-extra"]);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length) throw new Error(`unknown argument ${unknown[0]}\n${USAGE}`);
  if (args.has("--check") === args.has("--apply")) throw new Error(USAGE);
  if (args.has("--keep-extra") && args.has("--check"))
    throw new Error(`--keep-extra needs --apply\n${USAGE}`);
  return { mode: args.has("--apply") ? "apply" : "check", keepExtra: args.has("--keep-extra") };
}

function readFolder(dir, suffix) {
  if (!fs.existsSync(dir)) return {};
  const files = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      files[entry.name] = fs.readFileSync(path.join(dir, entry.name), "utf8");
    }
  }
  return files;
}

function main() {
  const { mode, keepExtra } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(CANONICAL_DIR)) throw new Error(`canonical folder ${CANONICAL_DIR} not found`);
  const canonical = readFolder(CANONICAL_DIR, CANONICAL_SUFFIX);
  const agents = Object.keys(canonical)
    .sort()
    .map((fileName) =>
      parseCanonical(fileName.slice(0, -CANONICAL_SUFFIX.length), canonical[fileName]),
    );
  if (!agents.length) throw new Error(`no *${CANONICAL_SUFFIX} files in ${CANONICAL_DIR}`);
  const models = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
  const existing = Object.fromEntries(
    // Only the extension a harness's copies use is read, so an unrelated file
    // in the folder (a README) is never pruned.
    Object.entries(HARNESSES).map(([harness, config]) => [
      harness,
      readFolder(config.dir, path.extname(config.fileName("x"))),
    ]),
  );
  const actions = planSync(agents, models, existing);

  const changed = actions.filter((action) => action.action !== "unchanged");
  console.log(
    `sub-agent sync (${mode}): ${agents.length} agents, ${Object.keys(HARNESSES).length} harnesses`,
  );

  if (mode === "check") {
    for (const action of changed) console.log(`  ${action.action.padEnd(9)} ${action.path}`);
    if (changed.length) {
      console.log(
        `DRIFT: ${changed.length} file(s). Edit ${CANONICAL_DIR}, then run with --apply.`,
      );
      return 1;
    }
    console.log("IN SYNC");
    return 0;
  }

  let touched = 0;
  let kept = 0;
  for (const action of changed) {
    if (action.action === "extra") {
      console.log(`  ${(keepExtra ? "kept" : "removed").padEnd(9)} ${action.path}`);
      if (keepExtra) {
        kept += 1;
        continue;
      }
      fs.rmSync(action.path);
    } else {
      console.log(`  ${action.action.padEnd(9)} ${action.path}`);
      fs.mkdirSync(path.dirname(action.path), { recursive: true });
      fs.writeFileSync(action.path, action.content, "utf8");
    }
    touched += 1;
  }
  if (touched) console.log(`WROTE: ${touched} file(s). Review the diff.`);
  if (kept) console.log(`KEPT: ${kept} extra file(s). --check still reports them as drift.`);
  if (!touched && !kept) console.log("IN SYNC");
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`sub-agent sync: ${error.message}`);
  process.exitCode = 2;
}
