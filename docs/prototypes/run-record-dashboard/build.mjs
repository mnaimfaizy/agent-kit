// PROTOTYPE, throwaway (#394). Inlines the Run Records into one double-clickable page.
// Run: node docs/prototypes/run-record-dashboard/build.mjs   then open dashboard.html
// This is also variant "local generated page" for the delivery question.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "run-record-fields", "records");
const records = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
const tpl = readFileSync(join(here, "template.html"), "utf8");
const json = JSON.stringify(records).replace(/</g, "\\u003c");
writeFileSync(join(here, "dashboard.html"), tpl.replace("/*RECORDS*/[]", json));
console.log(`dashboard.html written with ${records.length} Run Records`);
