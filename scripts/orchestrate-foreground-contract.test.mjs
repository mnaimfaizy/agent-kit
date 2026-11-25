/**
 * Contract test: a Delegation runs its re-gate and review sub-agents in the
 * foreground, and a `Final: no, waiting on <background work>` turn-end needs no
 * `notify_when_idle` re-arm (the spec #413 run's retrospective). Every
 * Delegation there ran its two review sub-agents, and often the node suite, in
 * the background, then ended its turn three or four times; each turn-end woke
 * the Chief of Staff, whose re-armed subscription on the now-idle session
 * fired at once, so duplicate notices piled up. The skill is prose, so these
 * tests pin the sentences: the building and QA briefs' foreground rule, and the
 * harness file's no-re-arm rule marked as seen in that run.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const SKILL_DIR = ".claude/skills/orchestrate";
const BRIEF = read(`${SKILL_DIR}/BRIEF.md`);
const DESKTOP = read(`${SKILL_DIR}/harnesses/claude-code-desktop.md`);

const FOREGROUND = /in the foreground, waiting for each in the same turn/;

describe("BRIEF.md: foreground work", () => {
  it("tells a building brief to run the re-gate and the review sub-agents in the foreground", () => {
    const item = BRIEF.split("\n").find((l) => l.startsWith("8. **Report and log files.**"));
    assert.match(item, /re-gate/);
    assert.match(item, /review sub-agents/);
    assert.match(item, FOREGROUND);
    assert.match(item, /only then (writes|write) (its|the) report/);
  });

  it("tells a QA brief the same", () => {
    const item = BRIEF.split("\n").find((l) => l.startsWith("8. **Report and log files.** As in"));
    assert.match(item, FOREGROUND);
    assert.match(item, /only then (writes|write) (its|the) (QA )?report/);
  });
});

describe("harnesses/claude-code-desktop.md: no re-arm on a waiting turn-end", () => {
  it("says a `Final: no, waiting on <background work>` turn-end needs no `notify_when_idle` re-arm", () => {
    assert.match(DESKTOP, /`Final: no, waiting on <background work>`/);
    assert.match(DESKTOP, /needs no `notify_when_idle` re-arm/);
  });

  it("gives the reason: the next turn-end wakes the Chief of Staff, and the heartbeat covers a stall", () => {
    const line = DESKTOP.split("\n").find((l) => l.includes("needs no `notify_when_idle` re-arm"));
    assert.match(line, /next turn-end wakes the Chief of Staff/);
    assert.match(line, /heartbeat covers a stall/);
  });

  it("records it as seen in the spec-413 run, and names that run in the facts line", () => {
    const line = DESKTOP.split("\n").find((l) => l.includes("needs no `notify_when_idle` re-arm"));
    assert.match(line, /\(seen in the spec-413 run\)/);
    assert.match(DESKTOP, /Each fact marked "\(seen in the spec-413 run\)"/);
  });
});
