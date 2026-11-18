#!/usr/bin/env node
// Pattern guide skeleton: docs/patterns/sub-agent-sync.md in Agent-kit.
//
// The periodic model audit's shell: it fetches each harness's published model
// list and asks the core whether every pinned name is still on it. Run it on a
// schedule (weekly is plenty), not on every pull request: a vendor retiring a
// model is not something a pull request did. Run the generator's --check
// first, so the pins it audits are the pins the copies carry.
//
//   <audit command>
//
// Copy it into your repository, fill in each TODO(adopt), and delete the
// Pattern guide line above. Exit 0 when every pin was found, 1 when one was
// not, 2 when a catalog could not be read (NOT RUN, never a pass).
import fs from "node:fs";

import { auditPins } from "./sync-agents-core.mjs";

// TODO(adopt): where the model policy lives. Its `catalogs` key maps each
// harness to the URL of the page or file that lists the model names it accepts.
const MODELS_FILE = "<path to agent-models.json>";

async function readCatalog(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function main() {
  const models = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
  const catalogs = {};
  for (const [harness, url] of Object.entries(models.catalogs ?? {})) {
    catalogs[harness] = await readCatalog(url);
  }
  const { missing, notRun } = auditPins(models, catalogs);
  for (const line of missing) console.log(`MISSING  ${line}`);
  for (const line of notRun) console.log(`NOT RUN  ${line}`);
  if (missing.length) {
    console.log(
      "FAIL: change the pin in the model policy, run the generator with --apply, and review.",
    );
    return 1;
  }
  if (notRun.length) return 2;
  console.log("PASS: every pinned model is listed");
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`model audit: ${error.message}`);
    process.exitCode = 2;
  },
);
