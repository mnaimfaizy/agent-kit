/**
 * Contract test: an `orchestrate` Team Run (spec #314, issue #316, ADR 0014
 * and ADR 0015) is written into the skill where a run reads it. The skill is
 * prose, and no code parses an invocation, so these tests pin the sentences a
 * run relies on: the `--team` invocation and its argument rule, the argument
 * hint, the line that loads TEAM.md for `--team` only, and what a Team Run's
 * Dispatch Plan must say. What a sentence means is for review; these only keep
 * it from being dropped.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const SKILL_DIR = ".claude/skills/orchestrate";
const SKILL = read(`${SKILL_DIR}/SKILL.md`);
const TEAM = read(`${SKILL_DIR}/TEAM.md`);

/** The text of a `## ` or `### ` section, from its heading to the next of the same depth or higher. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const depth = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${depth}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

describe("SKILL.md: the `--team` argument", () => {
  const invocations = section(SKILL, "## Invocations");

  it("names the Team Run invocation, beside `go` and `autonomous`", () => {
    assert.match(invocations, /`\/orchestrate --spec 50 --team \[go\] \[autonomous\]`/);
  });

  it("takes `--team` only with `--spec <n>`, at most once, in the rule that stops any other mix", () => {
    const rule = invocations.split("\n").find((l) => l.includes("stops the run before anything"));
    assert.ok(rule, "the rule is there");
    assert.match(rule, /`--team` is taken only with `--spec <n>`, once/);
    assert.match(rule, /twice/);
    assert.match(rule, /`autonomous`/);
  });

  it("puts `--team` in the argument hint, only after `--spec <n>`", () => {
    const hint = /^argument-hint: "(.+)"$/m.exec(SKILL)[1];
    assert.match(hint, /--spec <n> --team \[go\] \[autonomous\]/);
    assert.match(hint, /--spec <n> \[go\] \[autonomous\]/);
    for (const form of hint.split(" | "))
      if (form.includes("--team")) assert.match(form, /^--spec <n> --team /, form);
    assert.equal(hint.match(/--team/g).length, 1, "`--team` appears in one form only");
  });

  it("loads TEAM.md for `--team` only", () => {
    const lines = SKILL.split("\n").filter((l) => l.includes("TEAM.md"));
    assert.ok(lines.length > 0, "SKILL.md names TEAM.md");
    for (const line of lines) assert.match(line, /--team/, line);
    assert.ok(
      lines.some((l) => /Load \[TEAM\.md\]\(TEAM\.md\) for `--spec <n> --team`/.test(l)),
      "a load line for --team",
    );
  });
});

describe("TEAM.md: the Dispatch Plan of a Team Run", () => {
  const plan = section(TEAM, "## The Dispatch Plan");

  it("builds only the tickets whose single assignee is this teammate", () => {
    assert.match(TEAM, /only this teammate/);
    assert.match(plan, /only this teammate's tickets/);
  });

  it('lists every other ticket under "Teammates\' tickets (not run here)", with its state', () => {
    assert.match(plan, /\*\*Teammates' tickets \(not run here\)\*\*/);
    assert.match(plan, /state/);
  });

  it('runs `unassigned` and "needs one assignee" tickets by nobody', () => {
    assert.match(plan, /`unassigned`/);
    assert.match(plan, /needs one assignee/i);
    assert.match(TEAM, /nobody runs it/);
  });

  it("points a plan with no tickets to `--status`", () => {
    assert.match(section(TEAM, "### No tickets of your own"), /`--status`/);
  });

  it("forces the landing per-ticket and states the override", () => {
    assert.match(plan, /\*\*Landing:\*\* per-ticket/);
    assert.match(plan, /`spec\.landing: <value>` is overridden/);
  });

  it("makes the Decision authority, `go` or `go autonomous`, this teammate's own", () => {
    assert.match(plan, /`go` or `go autonomous`/);
    assert.match(plan, /per teammate/);
  });

  it("lists the Shared Board routine write, with the public-repository line", () => {
    assert.match(plan, /"Shared Board: row comment and state labels on my assigned tickets"/);
    assert.match(
      plan,
      /This repository is \*\*public\*\*: row comments and state labels are readable by anyone\./,
    );
  });

  it("asks once to create the missing state labels, as a write as the human", () => {
    const missing = section(TEAM, "### Missing state labels");
    assert.match(missing, /one ask/);
    assert.match(missing, /write as the human/);
    assert.match(missing, /never routine/);
  });
});

describe("TEAM.md: the tracker", () => {
  it("asks the human when the pinned tracker and the remote disagree, or when none is known", () => {
    const find = section(TEAM, "## Find the tracker");
    assert.match(find, /disagree/);
    assert.match(find, /Decision Request/);
    assert.match(find, /trackers\/TRACKERS\.md/);
  });
});
