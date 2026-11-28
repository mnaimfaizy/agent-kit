// Contract for the harness preflight rules the Launcher reads from
// `cli/harnesses.json` (ADRs 0027 and 0028): which effort a Stage runs with,
// and whether its Support Level lets it run. The facts passed in stand for
// harnesses and levels the shipped file does not hold yet.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effortFor, readHarnesses, supportFor } from "../cli/src/harness/facts.mjs";

const NO_EFFORT = { displayName: "Some CLI", effortValues: [], noEffort: true };
const CLAUDE = readHarnesses().harnesses["claude-code"];

describe("the effort a Stage runs with", () => {
  it("passes an accepted effort through, own or inherited, and none as none", () => {
    for (const inherited of [false, true]) {
      assert.deepEqual(effortFor(CLAUDE, { effort: "high", inherited }), { effort: "high" });
      assert.deepEqual(effortFor(CLAUDE, { effort: "", inherited }), { effort: "" });
    }
  });

  it("fails the Stage's own effort the harness does not accept, naming the accepted ones", () => {
    const r = effortFor(CLAUDE, { effort: "minimal", inherited: false });
    assert.match(r.refused, /Claude Code accepts low, medium, high, xhigh or max/);
    assert.ok(!r.refused.includes("minimal"), "the value is not echoed");
  });

  it("fails the Stage's own effort on a harness with no effort setting", () => {
    const r = effortFor(NO_EFFORT, { effort: "high", inherited: false });
    assert.match(r.refused, /Some CLI has no effort setting/);
  });

  it("drops an inherited AGENT_KIT_EFFORT the harness does not accept, with a log line", () => {
    for (const harness of [CLAUDE, NO_EFFORT]) {
      const r = effortFor(harness, { effort: "minimal", inherited: true });
      assert.equal(r.effort, "");
      assert.match(r.log, /AGENT_KIT_EFFORT/);
      assert.ok(!r.log.includes("minimal"), "the value is not echoed");
    }
  });
});

describe("whether a Stage may run at its pair's Support Level", () => {
  const harness = (level, run = null) => ({
    displayName: "Some CLI",
    supportLevels: Object.fromEntries(
      ["deep-scan", "security-audit", "plan"].map((stage) => [stage, { level, run }]),
    ),
  });

  it("refuses a security Stage below tried without the Proving run flag", () => {
    for (const stage of ["deep-scan", "security-audit"]) {
      const r = supportFor(harness("documented"), { stage, provingRun: false });
      assert.match(r.refused, /documented/);
      assert.match(r.refused, /below tried/);
    }
  });

  it("runs it with the flag, and says it is a Proving run", () => {
    const r = supportFor(harness("documented"), { stage: "deep-scan", provingRun: true });
    assert.equal(r.refused, undefined);
    assert.equal(r.level, "documented");
    assert.match(r.summary, /Support Level: documented; Proving run: yes/);
  });

  it("runs a security Stage at tried or verified without the flag", () => {
    for (const level of ["tried", "verified"]) {
      const r = supportFor(harness(level, "https://x"), { stage: "deep-scan", provingRun: false });
      assert.equal(r.refused, undefined, level);
      assert.match(r.summary, new RegExp(`Support Level: ${level}; Proving run: no`));
      assert.equal(r.warning, undefined, level);
    }
  });

  it("runs another Stage at documented, with a warning", () => {
    const r = supportFor(harness("documented"), { stage: "plan", provingRun: false });
    assert.equal(r.refused, undefined);
    assert.match(r.warning, /documented/);
  });

  it("refuses a pair with no level, with or without the flag: a Guard probe failed", () => {
    for (const stage of ["deep-scan", "plan"]) {
      for (const provingRun of [false, true]) {
        const r = supportFor(harness(null), { stage, provingRun });
        assert.match(r.refused, /no Support Level/);
      }
    }
  });
});
