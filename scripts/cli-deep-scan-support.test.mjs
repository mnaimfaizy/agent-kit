// Contract for `agent-kit deep-scan` (cli/): the Support Level preflight and
// the Proving run flag (ADR 0028). Every pair starts at `documented`, so a
// Deep scan is refused before anything runs unless it is a Proving run.
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../cli/src/cli.mjs";
import { readHarnesses } from "../cli/src/harness/facts.mjs";
import {
  VALID,
  tmp,
  nextId,
  REAL_KEY,
  run,
  recipeRepo,
  verifyRepo,
  verifyHost,
  verifyArgs,
} from "./cli-deep-scan-fixtures.mjs";

const CELL = readHarnesses().harnesses["claude-code"].supportLevels["deep-scan"];
const REFUSED =
  /^REFUSED {2}Claude Code on the deep-scan Stage is at Support Level documented, below tried/m;
const SUMMARY = /^Harness: claude-code; Support Level: documented; Proving run: yes$/m;
const inCI = (extra = {}) => ({
  PATH: "/usr/bin",
  ANTHROPIC_API_KEY: REAL_KEY,
  GITHUB_ACTIONS: "true",
  ...extra,
});

describe("a Deep scan on a pair below tried", () => {
  it("starts at documented, which is why these cases hold", () => {
    assert.equal(CELL.level, "documented");
  });

  it("is refused before anything runs without --proving-run, pointing at the docs", async () => {
    const res = await run(recipeRepo(VALID), [], { provingRun: false });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, REFUSED);
    assert.match(res.err, /only as a Proving run \(--proving-run\)/);
    assert.match(res.err, /docs\/harnesses\.md#proving-runs/);
    assert.deepEqual(res.calls, [], "no git and no runtime command");
  });

  it("is refused in GitHub Actions too, and writes no run summary", async () => {
    const summary = join(tmp, `summary-${nextId()}`);
    const res = await run(recipeRepo(VALID), [], {
      provingRun: false,
      env: inCI({ GITHUB_STEP_SUMMARY: summary }),
    });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, REFUSED);
    assert.throws(() => readFileSync(summary), /ENOENT/);
  });

  it("refuses a Verification run as well", async () => {
    const res = await run(verifyRepo(), verifyArgs(), { host: verifyHost(), provingRun: false });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, REFUSED);
    assert.deepEqual(res.calls, []);
  });

  it("runs with --proving-run, and the run is marked as one", async () => {
    const res = await run(recipeRepo(VALID), ["--proving-run"], { provingRun: false });
    assert.equal(res.code, 0, res.text);
    assert.match(res.out, SUMMARY);
    assert.match(res.err, /Claude Code on the deep-scan Stage is at Support Level documented/);
  });

  it("writes harness, level and Proving run to the run summary, and nothing else", async () => {
    const summary = join(tmp, `summary-${nextId()}`);
    const res = await run(recipeRepo(VALID), [], { env: inCI({ GITHUB_STEP_SUMMARY: summary }) });
    assert.equal(res.code, 0, res.text);
    assert.equal(
      readFileSync(summary, "utf8"),
      "Harness: `claude-code` · Support Level: `documented` · Proving run: yes\n",
    );
  });

  it("relaxes nothing else: another preflight refusal still holds", async () => {
    const res = await run(recipeRepo(VALID), [], {
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: REAL_KEY, GH_TOKEN: "x" },
    });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /GH_TOKEN is set/);
  });

  it("has the flag in deep-scan's help and the CLI README", async () => {
    const help = [];
    await main(["--help"], { cwd: tmp, stdout: (s) => help.push(s), stderr: () => {} });
    assert.match(help.join("\n"), /--proving-run +Run on a harness whose Support Level/);
    const readme = readFileSync(join(import.meta.dirname, "..", "cli", "README.md"), "utf8");
    assert.ok(readme.includes("--proving-run"));
  });

  it("is a flag of deep-scan alone", async () => {
    const err = [];
    const code = await main(["doctor", "--proving-run"], {
      cwd: tmp,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /doctor does not take --proving-run/);
  });
});
