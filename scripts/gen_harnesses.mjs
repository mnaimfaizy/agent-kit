#!/usr/bin/env node
/**
 * Write cli/harnesses.json from the Harness adapters and the Support Level
 * table (cli/src/harness/), then format it with prettier (ADRs 0028, 0030).
 *
 * Usage:
 *   node scripts/gen_harnesses.mjs           # write the file
 *   node scripts/gen_harnesses.mjs --check   # exit 1 if it differs; the publish workflow runs this
 *
 * After a change, also run `uv run python scripts/gen_doc_blocks.py`: the docs
 * render the Support Level table from this file.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildHarnesses } from "../cli/src/harness/facts.mjs";

const ROOT = join(import.meta.dirname, "..");
const FILE = join(ROOT, "cli", "harnesses.json");
const FIX = "run node scripts/gen_harnesses.mjs";

const built = buildHarnesses();

if (process.argv.includes("--check")) {
  let shipped;
  try {
    shipped = JSON.parse(readFileSync(FILE, "utf8"));
  } catch (e) {
    console.error(`cli/harnesses.json cannot be read (${e.message}): ${FIX}`);
    process.exit(1);
  }
  if (!isDeepStrictEqual(shipped, built)) {
    console.error(`cli/harnesses.json differs from the Harness adapters: ${FIX}`);
    process.exit(1);
  }
  console.log("cli/harnesses.json matches the Harness adapters");
} else {
  writeFileSync(FILE, `${JSON.stringify(built, null, 2)}\n`);
  const prettier = join(ROOT, "node_modules", "prettier", "bin", "prettier.cjs");
  const r = spawnSync(process.execPath, [prettier, "--write", FILE], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("prettier did not run: npm ci, then run this again");
    process.exit(1);
  }
  console.log("Wrote cli/harnesses.json");
}
