#!/usr/bin/env node
// The QA Stack for Agent-kit's own manual QA: qa.config.yml's `run.stack` commands.
// This repository's tooling, not part of the kit: it is not in
// scripts/release-snapshot-manifest.txt or kit-owned-paths.txt.
//
// It serves the orchestrate skill's pages from the record fixtures, on 127.0.0.1 only:
// the live board of a reopened run at `/` and the past-runs dashboard at `/dashboard`.
// Everything lives in one scratch folder, `tmp/qa/stack` under the folder it runs in
// (QA_STACK_DIR overrides it), with its own orchestrate.config.yml, so the dashboard
// never reads this checkout's real run folders. The port is 4791 (QA_STACK_PORT).
//
// QA_STACK_SINK_REPO=<owner>/<name> sets a `github` Sink in that scratch config only, so
// the upload and the dashboard's sink read can be tried against a throwaway private
// repository, never this repository's real Sink. Without it, nothing leaves the machine.
//
//   up       make the scratch folder, copy the fixtures, start `records.mjs serve`
//   migrate  nothing: there is no database
//   seed     derive the fixtures' Run Records, and reopen one run with a fresh heartbeat
//   down     stop the server up started (its own pid only), remove the scratch folder
//   print    the one role, `viewer`: the pages have no sign-in
import { spawn, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const USAGE = "usage: node scripts/qa-stack.mjs <up|migrate|seed|down|print>\n";
const here = process.cwd();
const repo = resolve(import.meta.dirname, "..");
const skill = join(repo, ".claude", "skills", "orchestrate");
const records = join(skill, "records.mjs");
const fixtures = join(skill, "fixtures", "records");
const dir = resolve(here, process.env.QA_STACK_DIR ?? join("tmp", "qa", "stack"));
const port = Number(process.env.QA_STACK_PORT ?? 4791);
const runs = join(dir, "runs");
const FIXTURES = ["2026-11-17-spec-253", "2026-11-19-spec-344"];
const LIVE = "2026-11-19-spec-344";
const pidFile = join(dir, "serve.pid");
const address = `http://127.0.0.1:${port}/`;
const sinkRepo = process.env.QA_STACK_SINK_REPO ?? "";
if (sinkRepo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sinkRepo)) {
  process.stderr.write("QA_STACK_SINK_REPO: expected <owner>/<name>\n");
  process.exit(2);
}
const config = `run_dir: runs\n${
  sinkRepo ? `records:\n  upload: offer\n  sink:\n    type: github\n    repo: ${sinkRepo}\n` : ""
}`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const node = (args) =>
  execFileSync(process.execPath, [records, ...args], { cwd: dir, encoding: "utf8" });

async function answers() {
  try {
    return (await fetch(address, { method: "HEAD" })).ok;
  } catch {
    return false;
  }
}

async function up() {
  if (existsSync(pidFile) && alive(Number(readFileSync(pidFile, "utf8"))))
    return void process.stdout.write(`already up: ${address}\n`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(dir, "orchestrate.config.yml"), config);
  for (const name of FIXTURES) cpSync(join(fixtures, name), join(runs, name), { recursive: true });

  const log = openSync(join(dir, "serve.log"), "a");
  const child = spawn(
    process.execPath,
    [records, "serve", join(runs, LIVE), "--port", String(port), "--heartbeat", "10"],
    { cwd: dir, detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  for (let n = 0; n < 100; n += 1) {
    if (await answers())
      return void process.stdout.write(
        `QA Stack up: ${address} (dashboard at ${address}dashboard)\n`,
      );
    if (!alive(child.pid)) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  process.stderr.write(`the server did not start: see ${join(dir, "serve.log")}\n`);
  process.exit(1);
}

function seed() {
  if (!existsSync(runs)) {
    process.stderr.write("no stack: run `node scripts/qa-stack.mjs up` first\n");
    process.exit(1);
  }
  // Each fixture as shipped, so seeding twice leaves the same records.
  for (const name of FIXTURES) {
    rmSync(join(runs, name), { recursive: true, force: true });
    cpSync(join(fixtures, name), join(runs, name), { recursive: true });
    rmSync(join(runs, "records", `${name}.json`), { force: true });
    node(["derive", join(runs, name)]);
  }
  // The live board's run, reopened: no run-closed, and a heartbeat now, so it reads as live.
  const events = join(runs, LIVE, "events.jsonl");
  const open = readFileSync(events, "utf8")
    .split("\n")
    .filter((line) => line && JSON.parse(line).kind !== "run-closed");
  writeFileSync(events, `${open.join("\n")}\n`);
  node(["event", "--file", events, "--kind", "heartbeat", "--actor", "chief-of-staff"]);
  process.stdout.write(
    `seeded: ${FIXTURES.length} Run Records; ${LIVE} reopened with a fresh heartbeat\n`,
  );
}

function down() {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (pid && alive(pid)) process.kill(pid, "SIGTERM");
  }
  rmSync(dir, { recursive: true, force: true });
  process.stdout.write("QA Stack down\n");
}

const step = process.argv[2];
if (step === "up") await up();
else if (step === "migrate")
  process.stdout.write("nothing to migrate: the pages read files, there is no database\n");
else if (step === "seed") seed();
else if (step === "down") down();
else if (step === "print")
  process.stdout.write("viewer: no sign-in; opens the board and the dashboard pages\n");
else {
  process.stderr.write(USAGE);
  process.exit(2);
}
