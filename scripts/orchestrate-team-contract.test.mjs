/**
 * Contract test: an `orchestrate` Team Run (spec #314, issues #316 to #318,
 * ADR 0014 and ADR 0015) is written into the skill where a run reads it. The skill is
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
const TRACKERS = read(`${SKILL_DIR}/TRACKERS.md`);

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
    assert.match(find, /\[TRACKERS\.md\]\(TRACKERS\.md\)/);
  });
});

/** The first fenced block of a given language in a text, without its fences. */
function fenced(text, lang) {
  const m = new RegExp("^```" + lang + "\\n([\\s\\S]*?)^```$", "m").exec(text);
  assert.ok(m, `a \`\`\`${lang} block`);
  return m[1];
}

/** What every published row must hold to, wherever a row is shown. */
function assertPublishable(row, where) {
  for (const line of row.split("\n"))
    assert.ok(!line.trimStart().startsWith("/"), `${where}: no line starts with "/": ${line}`);
  for (const field of ["Handle", "Executor", "Model", "Wave"])
    assert.doesNotMatch(row, new RegExp(`\\b${field}\\b`, "i"), `${where}: no ${field}`);
}

describe("TEAM.md: the Shared Board row", () => {
  const board = section(TEAM, "## The Shared Board");
  const row = section(TEAM, "### The row");
  const template = fenced(row, "markdown");

  it("is written as the status card, with every part the spec names", () => {
    for (const part of [
      "<!-- orchestrate:shared-board-row ticket=<n> run=<run> author=@<login> -->",
      "<headline>",
      "<fine state>",
      "Waiting on @<login>:",
      "Assignee",
      "Branch",
      "Pull request",
      "Parked on",
      "Decision authority",
      "Rulings: <N> awaiting @<login>'s review",
      "Conflicts with",
      "Recent activity",
      "Updated",
      "Maintained by orchestrate",
      "Edits here are overwritten.",
    ])
      assert.ok(template.includes(part), `the row holds ${part}`);
  });

  it("shows the Rulings line only while N is not zero, and keeps `recent_activity` milestones", () => {
    assert.match(row, /only while <N> is not zero/);
    assert.match(row, /`team\.recent_activity`/);
  });

  it("never carries the Handle, Executor kind, Model or Wave, and no line of it starts with `/`", () => {
    assertPublishable(template, "TEAM.md's row");
    assert.match(board, /never the Handle, the Executor kind, the Model or the Wave/);
    assert.match(board, /no line starts with `\/`/i);
  });

  it("writes every free-text piece for publication, never copied from a brief, log or evidence file", () => {
    assert.match(board, /written for publication/);
    assert.match(board, /never copied from a brief, a report, a log or an evidence file/);
  });

  it("no longer says this version writes no row", () => {
    assert.doesNotMatch(TEAM, /does not give the row's form yet/);
  });
});

describe("TEAM.md: when a row and its state label are written", () => {
  const states = section(TEAM, "### States and labels");
  const when = section(TEAM, "### When a row is written");
  const COARSE = ["planned", "parked", "running", "waiting", "ready to merge", "merged"];
  /** Every state RUN.md's States table names. */
  const RUN_STATES = [
    ...section(read(`${SKILL_DIR}/RUN.md`), "## States").matchAll(/^\| `([a-z][a-zA-Z ]*)` +\|/gm),
  ].map((m) => m[1]);
  /** TEAM.md's mapping: fine state → its cells. */
  const mapping = new Map(
    [...states.matchAll(/^\| `([a-z][a-zA-Z ]*)` +\| ([^|]+?) +\| ([^|]+?) +\|$/gm)].map((m) => [
      m[1],
      { coarse: m[2], headline: m[3] },
    ]),
  );

  it("maps every state a run's board can hold, and only those", () => {
    assert.ok(RUN_STATES.length >= 18, "RUN.md's states are read");
    assert.deepEqual(
      RUN_STATES.filter((s) => !mapping.has(s)),
      [],
      "RUN.md states with no mapping",
    );
    assert.deepEqual(
      [...mapping.keys()].filter((s) => !RUN_STATES.includes(s)),
      [],
      "mapped states RUN.md does not have",
    );
  });

  it("maps each state onto one of the six coarse states, or says why it has none", () => {
    for (const [fine, { coarse }] of mapping)
      assert.ok(
        COARSE.some((c) => coarse === `\`${c}\``) || /^none/.test(coarse),
        `${fine} → ${coarse}`,
      );
    for (const c of COARSE)
      assert.ok(
        [...mapping.values()].some((v) => v.coarse === `\`${c}\``),
        `some state is ${c}`,
      );
  });

  it("parks a ticket blocked by a teammate's ticket, and waits on the human", () => {
    assert.equal(mapping.get("parked").coarse, "`parked`");
    assert.equal(mapping.get("waiting").coarse, "`waiting`");
    assert.equal(mapping.get("ready to merge").coarse, "`ready to merge`");
  });

  it("writes only on a change, only this teammate's own tickets, under the routine write approved at go", () => {
    assert.match(when, /only when/);
    assert.match(when, /nothing changed, nothing is written/i);
    assert.match(when, /only on this teammate's own tickets/);
    assert.match(when, /"Shared Board: row comment and state labels on my assigned tickets"/);
  });

  it("changes the label only when the coarse state does, and keeps the row as the record when it is dropped", () => {
    assert.match(states, /only when the coarse state changes/);
    assert.match(states, /`set-state`/);
    assert.match(states, /the row comment stays the record/);
  });
});

describe("TEAM.md: blocking, conflicts and Rulings across teammates", () => {
  it("reads blocking from the tracker, and clears a teammate's blocker only when its pull request is merged", () => {
    const blocking = section(TEAM, "### Blocking across teammates");
    assert.match(blocking, /`blockers` operation/);
    assert.match(blocking, /tracker's own blocking links/);
    assert.match(blocking, /only when its pull request is merged/);
    assert.match(blocking, /`parked`/);
    assert.match(blocking, /\*\*Parked on\*\*/);
  });

  it("rules only on its own branches, and shows a conflict with a teammate's branch on the row: first merged wins", () => {
    const conflicts = section(TEAM, "## Conflicts with a teammate's branch");
    assert.match(conflicts, /rules only on its own branches/);
    assert.match(conflicts, /first merged wins/i);
    assert.match(conflicts, /`pull-head`/);
    assert.match(conflicts, /\*\*Conflicts with\*\*/);
  });

  it("names whose Chief of Staff made a Ruling, in the line recorded where `decisions.to` says", () => {
    const rulings = section(TEAM, "## Rulings in a Team Run");
    const line = "R<n> (@<login>'s Chief of Staff ruling, not yet reviewed)";
    assert.ok(rulings.includes(line), "TEAM.md gives the line");
    assert.match(rulings, /`decisions\.to`/);
    assert.ok(
      section(read(`${SKILL_DIR}/BRIEF.md`), "## Ruling").includes(line),
      "BRIEF.md's Ruling form gives it",
    );
  });
});

describe("TEAM.md: what stays local", () => {
  it("keeps the run folder's contents off the Shared Board", () => {
    const local = section(TEAM, "## What stays local");
    for (const kept of [
      "briefs",
      "reports",
      "full Decision Requests and their answers",
      "Ruling Ledger",
      "evidence",
      "Activity Log",
      "QA Plans and QA Reports",
    ])
      assert.ok(local.includes(kept), `${kept} stays local`);
    assert.match(local, /publishes only the row and the state label/);
  });
});

describe("docs/orchestrate.md: the Shared Board", () => {
  const DOC = read("docs/orchestrate.md");
  const team = section(DOC, "## Team Run");

  it("shows an example row that holds to the row's rules", () => {
    const example = fenced(section(team, "### The Shared Board"), "markdown");
    assertPublishable(example, "the docs' example row");
    assert.match(
      example,
      /^<!-- orchestrate:shared-board-row ticket=\d+ run=\S+ author=@\S+ -->$/m,
    );
    assert.match(
      example,
      /Maintained by orchestrate for @\S+'s Team Run\. Edits here are overwritten\./,
    );
    assert.match(example, /\*\*Recent activity\*\*/);
  });

  it("no longer says this version writes no row or label", () => {
    assert.doesNotMatch(team, /writes no row or label yet/);
  });
});

describe("TEAM.md: ownership of a row", () => {
  const owner = section(TEAM, "## Ownership");

  it("re-reads the ticket's assignee just before every row or label write, and writes only while this teammate is its single assignee", () => {
    const who = section(owner, "### Who writes");
    assert.match(who, /just before every `write-row` and every `set-state`/i);
    assert.match(who, /`spec-tickets`/);
    assert.match(who, /single assignee is this teammate/);
    assert.match(section(TEAM, "### When a row is written"), /\[Who writes\]\(#who-writes\)/);
    assert.match(
      TRACKERS.split("\n").find((l) => l.startsWith("| `spec-tickets`")),
      /just before every row or label write/,
    );
  });
  it("raises a Decision Request to the old owner when a running or parked ticket is assigned away: hand off, or ask for it back; nothing is stopped unasked", () => {
    const re = section(owner, "### Reassignment");
    assert.match(re, /running or parked/);
    assert.match(re, /Decision Request/);
    assert.match(re, /1\. \*\*Hand it off\*\*/);
    assert.match(re, /2\. \*\*Ask for it back\*\*/);
    assert.match(re, /never stopped unasked/);
    assert.match(re, /never a Ruling/);
  });

  it("hands off in order: the branch is pushed, one final row line is written, and the local row becomes `dropped`", () => {
    const off = section(owner, "### Handing a ticket off");
    const steps = [...off.matchAll(/^(\d)\. (.+)$/gm)].map((m) => [m[1], m[2]]);
    assert.deepEqual(
      steps.map((s) => s[0]),
      ["1", "2", "3"],
      "three numbered steps",
    );
    assert.match(steps[0][1], /pushes its branch/);
    assert.match(steps[1][1], /handed off to @<new> at `<branch>@<head>`/);
    assert.match(steps[1][1], /one final row write/);
    assert.match(steps[2][1], /row on the local board becomes `dropped`/);
    assert.match(off, /The state label is left as it is/);
    assert.match(off, /`handed off to @<new>, not started`/);
    assert.match(
      section(TEAM, "### Milestones"),
      /`` handed off to @<login> at `<branch>@<head>` ``, or `handed off to @<login>, not started`/,
    );
  });
  it("has the new assignee's run start a new Delegation from the handed-off branch, as a crashed one's is picked up, and write a new row comment", () => {
    const pick = section(owner, "### Picking up a handed-off ticket");
    assert.match(pick, /new Delegation from that branch/);
    assert.match(pick, /as a crashed Delegation's branch is picked up/);
    assert.match(pick, /\[SKILL\.md\]\(SKILL\.md#/);
    assert.match(pick, /\*\*new\*\* row comment/);
    assert.match(pick, /never edits/);
    assert.match(pick, /a row comment by another author has as its newest milestone/);
  });

  it("has readers take the current assignee's row comment, or with none, the newest one shown as stale", () => {
    const which = section(owner, "### Which comment is the row");
    assert.match(which, /written by the ticket's current assignee/);
    assert.match(which, /newest/);
    assert.match(which, /stale/);
  });
  it("never overwrites a row of the same author carrying another run id, and asks: resume that run, or take the row over", () => {
    const two = section(owner, "### Two runs of one teammate");
    assert.match(two, /another run id/);
    assert.match(two, /never overwritten/);
    assert.match(two, /Decision Request/);
    assert.match(two, /1\. \*\*Resume that run\*\*/);
    assert.match(two, /2\. \*\*Take the row over\*\*/);
    assert.match(two, /whether or not this run has its own row there too/);
    assert.match(two, /never a Ruling/);
    assert.match(
      section(TEAM, "### When a row is written"),
      /\[Two runs of one teammate\]\(#two-runs-of-one-teammate\)/,
    );
  });

  it("overwrites a person's edit on the next write, re-creates a deleted row, and restores a removed label on the next state change", () => {
    const edits = section(owner, "### A person's edits");
    assert.match(edits, /overwritten on the next write/);
    assert.match(edits, /re-created/);
    assert.match(edits, /restored on the next state change/);
  });
});

const RUN = read(`${SKILL_DIR}/RUN.md`);

describe("SKILL.md: the observer form `--status --spec <n>`", () => {
  const invocations = section(SKILL, "## Invocations");

  it("names `--status --spec <n>` as an invocation that reads the tracker alone", () => {
    const line = invocations
      .split("\n")
      .find((l) => l.includes("`/orchestrate --status --spec 50`"));
    assert.ok(line, "the invocation is listed");
    assert.match(line, /tracker/);
    assert.match(line, /\[RUN\.md\]\(RUN\.md#/);
  });

  it("takes `--status --spec <n>` with nothing else, in the rule that stops any other mix", () => {
    const rule = invocations.split("\n").find((l) => l.includes("stops the run before anything"));
    assert.match(rule, /`--status --spec <n>` takes exactly one issue number and nothing else/);
  });

  it("puts `--status --spec <n>` in the argument hint, as a form of its own", () => {
    const hint = /^argument-hint: "(.+)"$/m.exec(SKILL)[1];
    assert.ok(hint.split(" | ").includes("--status --spec <n>"), hint);
  });

  it("loads TEAM.md for `--status` of a Team Run and for `--status --spec <n>`, and says it adds the Shared Board's writes after go", () => {
    const load = SKILL.split("\n").find((l) =>
      /Load \[TEAM\.md\]\(TEAM\.md\) for `--spec <n> --team`/.test(l),
    );
    assert.match(load, /`--status --spec <n>`/);
    assert.match(load, /`--status`/);
    assert.match(load, /Shared Board's writes after "go"/);
    const team = invocations.split("\n").find((l) => l.includes("`/orchestrate --spec 50 --team"));
    assert.match(team, /Shared Board's writes after "go"/);
  });
});

describe("RUN.md: `--status` of a Team Run", () => {
  const status = section(RUN, "## Status");
  const team = section(RUN, "### In a Team Run");

  it("prints the whole spec as a blocking tree in merge order, ending with Next moves", () => {
    assert.match(team, /blocking tree/);
    assert.match(team, /merge order/);
    assert.match(team, /"Next moves"/);
    const example = fenced(team, "text");
    const lines = example.trimEnd().split("\n");
    assert.match(lines[lines.length - 1], /^Next moves: /, "the example ends with Next moves");
  });

  it("shows each teammate's last write and each row's age since its last change", () => {
    assert.match(team, /last write/);
    assert.match(team, /age since its last change/);
    assert.match(fenced(team, "text"), /last write/);
  });

  it("prints this teammate's own rows in full, as today, and teammates' rows as their status card shows them", () => {
    assert.match(team, /own rows in full/);
    assert.match(team, /open Decision Request in full/);
    assert.match(team, /Ruling Ledger/);
    assert.match(team, /as (its|their) status card shows (it|them)/);
  });

  it("lists `unassigned` and needs-one-assignee tickets, and hand-offs in progress", () => {
    assert.match(team, /`unassigned`/);
    assert.match(team, /needs one assignee/);
    assert.match(team, /hand-off(s)? in progress/i);
  });

  it("writes nothing, and never says whether a teammate's run is alive", () => {
    assert.match(team, /writes nothing/);
    for (const thing of ["row", "label", "board", "file"])
      assert.match(team, new RegExp(`no ${thing}`));
    assert.match(team, /alive or dead/);
    assert.doesNotMatch(fenced(team, "text"), /\b(alive|dead|inactive|idle)\b/i);
  });

  it("is part of the Status section, beside the observer form", () => {
    assert.ok(status.includes("### In a Team Run"));
    assert.ok(status.includes("### `--status --spec <n>`"));
  });
});

describe("RUN.md: the observer form `--status --spec <n>`", () => {
  const observer = section(RUN, "### `--status --spec <n>`");
  /** The operation ids TRACKERS.md lists, each with its Kind. */
  const kinds = new Map(
    [...TRACKERS.matchAll(/^\| `([a-z][a-z-]*)` +\| ([^|]+?) +\|/gm)].map((m) => [m[1], m[2]]),
  );

  it("reads only the tracker and needs no local run", () => {
    assert.match(observer, /reads only the tracker/);
    assert.match(observer, /no run folder/);
    assert.match(observer, /writes nothing/);
  });

  it("names only tracker operations that are reads", () => {
    const named = [...observer.matchAll(/`([a-z][a-z-]*)` operation/g)].map((m) => m[1]);
    assert.ok(named.length >= 3, "it names the operations it reads");
    for (const id of named) assert.equal(kinds.get(id), "read", `\`${id}\` is a read`);
    for (const id of ["spec-tickets", "row", "blockers"]) assert.ok(named.includes(id), id);
  });

  it("prints the same tree and Next moves as a Team Run's `--status`", () => {
    assert.match(observer, /\[In a Team Run\]\(#in-a-team-run\)/);
    assert.match(observer, /Next moves/);
  });
});

describe("TEAM.md: a Team Run off GitHub", () => {
  it("is loaded for `--status` of a Team Run and for `--status --spec <n>`", () => {
    const opening = TEAM.split("\n\n")[1];
    assert.match(opening, /`--status --spec <n>`/);
    assert.match(opening, /`--status`/);
  });

  it("reads the spec and its tickets through `spec-tickets` on another tracker, in the Tickets shape when it lists any", () => {
    const whose = section(TEAM, "## Whose tickets");
    assert.match(whose, /other than GitHub/);
    assert.match(whose, /`spec-tickets`/);
    assert.match(whose, /Tickets shape when `spec-tickets` lists any/);
  });

  it("writes a merge request as `!<iid>` on GitLab where the row says `#<pr>`", () => {
    assert.match(section(TEAM, "### The row"), /`!<iid>`.*`#<pr>`|`#<pr>`.*`!<iid>`/);
  });
});

describe("docs/orchestrate.md: watching a Team Run, and reassignment", () => {
  const DOC = read("docs/orchestrate.md");

  it("lists `--status --spec <n>` with the invocations", () => {
    assert.match(section(DOC, "## Invocations"), /\| `\/orchestrate --status --spec 50` +\|/);
  });

  it("shows both forms of `--status` in a Team Run", () => {
    const watch = section(section(DOC, "## Team Run"), "### Watching a Team Run");
    assert.match(watch, /`\/orchestrate --status`/);
    assert.match(watch, /`\/orchestrate --status --spec <n>`/);
    assert.match(fenced(watch, "text"), /^Next moves: /m);
    assert.match(watch, /writes nothing/);
  });
});
