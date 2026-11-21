// PROTOTYPE, throwaway (#394). Builds the Run Record dashboard as ONE self-contained page.
//
//   node docs/prototypes/run-record-dashboard/build.mjs               -> dashboard.html (safe: Run Records only)
//   node docs/prototypes/run-record-dashboard/build.mjs --local-logs  -> dashboard.local.html (gitignored)
//
// --local-logs also inlines each real run's prose Activity Log from <repo>/tmp/orchestrate/<run>/activity.md.
// That is the "local generated page" delivery: prose stays on this machine; an uploaded record never carries it.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const local = process.argv.includes("--local-logs");
const recDir = join(here, "..", "run-record-fields", "records");
const records = readdirSync(recDir).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(join(recDir, f), "utf8")));

const logs = {};
if (local) {
  // The run folders live in the main checkout (tmp/ is gitignored), not in this worktree.
  const common = resolve(execSync("git rev-parse --git-common-dir", { cwd: here }).toString().trim(), "..");
  for (const r of records) {
    const p = join(common, "tmp", "orchestrate", r.run.id, "activity.md");
    if (existsSync(p)) logs[r.run.id] = readFileSync(p, "utf8");
  }
}
const read = (f) => readFileSync(join(here, "src", f), "utf8");
const safe = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
const html = read("shell.html")
  .replace("/*CSS*/", () => read("styles.css"))
  .replace("/*RECORDS*/", () => safe(records))
  .replace("/*LOGS*/", () => safe(logs))
  .replace("/*SYNTH*/", () => read("synth.js"))
  .replace("/*APP*/", () => read("app.js"));
const out = local ? "dashboard.local.html" : "dashboard.html";
writeFileSync(join(here, out), html);
console.log(`${out}: ${records.length} real Run Records, ${Object.keys(logs).length} local Activity Logs`);
