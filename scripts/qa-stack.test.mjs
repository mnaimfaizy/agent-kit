// The QA Stack for Agent-kit's own manual QA (qa.config.yml `run.stack`): the orchestrate
// skill's pages, built from the record fixtures and served by `records.mjs serve`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = join(import.meta.dirname, "qa-stack.mjs");
const ROOT = join(import.meta.dirname, "..");

const freePort = () =>
  new Promise((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("up, seed and down start the board and dashboard on 127.0.0.1, then leave nothing", async (t) => {
  const dir = join(mkdtempSync(join(tmpdir(), "qa-stack-")), "stack");
  const port = await freePort();
  const env = { ...process.env, QA_STACK_DIR: dir, QA_STACK_PORT: String(port) };
  const run = (step) =>
    execFileSync(process.execPath, [SCRIPT, step], { cwd: ROOT, env, encoding: "utf8" });
  t.after(() => {
    try {
      run("down");
    } catch {}
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  const up = run("up");
  assert.match(up, new RegExp(`http://127\\.0\\.0\\.1:${port}/`));
  const pid = Number(readFileSync(join(dir, "serve.pid"), "utf8"));
  assert.ok(alive(pid), "the server is running after up");

  assert.match(run("migrate"), /nothing to migrate/);
  run("seed");
  run("seed"); // idempotent

  const board = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(board.status, 200);
  const boardHtml = await board.text();
  assert.match(boardHtml, /Run 2026-11-19-spec-344/);
  assert.doesNotMatch(
    boardHtml,
    /class="banner stale-warning"/,
    "a fresh heartbeat keeps the reopened board live",
  );

  const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard`);
  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, /2026-11-17-spec-253/);
  assert.match(dashboardHtml, /2026-11-19-spec-344/);

  assert.match(run("print"), /^viewer\b.*no sign-in/m);

  run("down");
  assert.ok(!alive(pid), "down stops the server it started");
  assert.ok(!existsSync(dir), "down removes the stack folder");
  run("down"); // a second down is harmless
});

test("QA_STACK_SINK_REPO sets a github Sink in the scratch config only", async (t) => {
  const dir = join(mkdtempSync(join(tmpdir(), "qa-stack-")), "stack");
  const port = await freePort();
  const env = {
    ...process.env,
    QA_STACK_DIR: dir,
    QA_STACK_PORT: String(port),
    QA_STACK_SINK_REPO: "someone/run-records-qa",
  };
  const run = (step) =>
    execFileSync(process.execPath, [SCRIPT, step], { cwd: ROOT, env, encoding: "utf8" });
  t.after(() => {
    try {
      run("down");
    } catch {}
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });
  run("up");
  assert.match(
    readFileSync(join(dir, "orchestrate.config.yml"), "utf8"),
    /records:\n  upload: offer\n  sink:\n    type: github\n    repo: someone\/run-records-qa\n/,
  );
  assert.throws(
    () =>
      execFileSync(process.execPath, [SCRIPT, "up"], {
        env: { ...env, QA_STACK_SINK_REPO: "not a repo" },
        stdio: "pipe",
      }),
    (error) => error.status === 2,
  );
});

test("refuses an unknown step with the usage line", () => {
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, "restart"], { encoding: "utf8", stdio: "pipe" }),
    (error) =>
      error.status === 2 && /usage: node scripts\/qa-stack\.mjs/.test(String(error.stderr)),
  );
});
