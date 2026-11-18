/**
 * Contract test: `orchestrate` re-checks every Ready to Merge row against the
 * default branch as it now is (issue #288), before the row is listed and
 * whenever the human comes back to the run. The skill is prose, so these tests
 * pin the sentences a run relies on: when the check runs, what it reads and
 * what each outcome does, the re-gate on the merge result, the Decision
 * Request's two options and who may rule, the board's Default branch line,
 * the states, the glossary clause, the one-at-a-time merge order, and the
 * design note on why no heartbeat is armed for it. What a sentence means is
 * for review; these only keep it from being dropped.
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
const RUN = read(`${SKILL_DIR}/RUN.md`);
const SPEC = read(`${SKILL_DIR}/SPEC.md`);
const DESIGN = read(`${SKILL_DIR}/DESIGN.md`);
const GLOSSARY = read("GLOSSARY.md");
const CHANGELOG = read("CHANGELOG.md");
const DOCS = read("docs/orchestrate.md");
const CONFIG = read(`${SKILL_DIR}/CONFIG.md`);

/** The text of a `## `, `### ` or `#### ` section, from its heading to the next of the same depth or higher. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const depth = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${depth}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

/** One line of a Markdown table, by the backticked name in its first cell. */
function row(table, name) {
  const line = table.split("\n").find((l) => l.startsWith(`| \`${name}\``));
  assert.ok(line, `row ${name} exists`);
  return line;
}

const DEFAULT_BRANCH_CHECK = section(SKILL, "#### The default-branch check");
const STEP8 = section(SKILL, "### 8. Find conflicts between finished branches");
const STEP9 = section(SKILL, "### 9. QA each finished head");
const STEP10 = section(SKILL, "### 10. Close out");
const READY_CLAUSE =
  "merges cleanly into the default branch as it now is, and is not behind it where the repository requires branches to be up to date, unless the human chose to merge it as it is";

describe("SKILL.md: when the default-branch check runs", () => {
  it("step 10 runs it on each Ready to Merge row before the list is printed", () => {
    const before = STEP10.slice(0, STEP10.indexOf("Then print the Ready to Merge list"));
    assert.match(before, /\[default-branch check\]\(#the-default-branch-check\)/);
  });

  it('runs on `--status`, `--resume` and "merged <pr>", with no heartbeat armed for it', () => {
    assert.match(DEFAULT_BRANCH_CHECK, /`--status`/);
    assert.match(DEFAULT_BRANCH_CHECK, /`--resume`/);
    assert.match(DEFAULT_BRANCH_CHECK, /"merged <pr>"/);
    assert.match(DEFAULT_BRANCH_CHECK, /No heartbeat is armed for it/);
  });

  it("step 8 and step 9 list no row the check has not passed", () => {
    for (const [name, step] of [
      ["step 8", STEP8],
      ["step 9", STEP9],
    ])
      assert.match(
        step,
        /only once it has passed the \[default-branch check\]\(#the-default-branch-check\)/,
        `${name} defers Ready to Merge to the check`,
      );
  });

  it("step 8 writes the board's Default branch line once, and later only the check moves it", () => {
    assert.match(STEP8, /`Default branch` line reads `none yet`, write it/);
    assert.match(STEP8, /only the default-branch check rewrites it/);
    assert.match(
      STEP8,
      /naming as passed, each with its head, only a verified branch whose head already contains that tip \(`git merge-base --is-ancestor <tip> <head>`\)/,
    );
    assert.ok(
      !STEP8.includes("naming as passed every verified branch that merged cleanly into it"),
      "step 8 names no branch whose merge result was never re-gated",
    );
  });

  it('"merged <pr>" confirms the merge, marks the row and checks the rest before naming the next', () => {
    assert.match(
      STEP10,
      /When the human says "merged <pr>", check that the pull request is merged[^\n]*mark its row `merged`, and run the default-branch check on each row still Ready to Merge before naming the next one/,
    );
  });

  it("the integration-branch run checks the `<integration>` row, not landed tickets", () => {
    assert.match(DEFAULT_BRANCH_CHECK, /`<integration>` row/);
    assert.match(section(SPEC, "### On an integration branch"), /default-branch check/);
  });
});

describe("SKILL.md: what the check reads and what each outcome does", () => {
  it("reads `mergeStateStatus`, test-merges against the current tip, and reads the checks", () => {
    assert.match(DEFAULT_BRANCH_CHECK, /`mergeStateStatus`/);
    assert.match(DEFAULT_BRANCH_CHECK, /`git merge-tree --write-tree <tip> <head>`/);
    assert.match(DEFAULT_BRANCH_CHECK, /`gh pr checks <pr>`/);
  });

  it('a failing check sends the row back to step 7; a pending one keeps it off the list as "checks running"', () => {
    assert.match(
      DEFAULT_BRANCH_CHECK,
      /failing check[^.]*back to step 7[^\n]*it is `reported` again/,
    );
    assert.match(
      DEFAULT_BRANCH_CHECK,
      /pending keeps the row off the list, set back to `reported` and shown as "checks running"/,
    );
  });

  it("a `BEHIND` row or a failed re-gate is a Decision Request, and the row is `waiting`", () => {
    assert.match(
      DEFAULT_BRANCH_CHECK,
      /A row that is `BEHIND`, or whose re-gate fails, is a Decision Request, and the row is `waiting`/,
    );
  });

  it("re-gates the merge result in a detached worktree whenever the tip moved, strict rule or not", () => {
    assert.match(DEFAULT_BRANCH_CHECK, /moved since the board's `Default branch` line/);
  });

  it("re-gates a row the Default branch line does not name as passed, so a row taken off the list is re-gated when it comes back", () => {
    assert.match(
      DEFAULT_BRANCH_CHECK,
      /or when the line does not name the row, at its current head, as passed at that tip/,
    );
    assert.match(
      DEFAULT_BRANCH_CHECK,
      /naming as passed only the rows that passed this check, each with the head it passed at/,
    );
    assert.match(DEFAULT_BRANCH_CHECK, /`git commit-tree <tree> -p <tip> -p <head>`/);
    assert.match(DEFAULT_BRANCH_CHECK, /detached worktree/);
    assert.match(DEFAULT_BRANCH_CHECK, /strict rule or not/);
  });

  it("writes the Default branch line at each check", () => {
    assert.match(DEFAULT_BRANCH_CHECK, /rewrite the board's `Default branch` line/);
  });
});

describe("SKILL.md: the Decision Request for a row behind or failing its re-gate", () => {
  it("offers merge as it is with the admin bypass, or the Delegation merges the default branch in", () => {
    assert.match(DEFAULT_BRANCH_CHECK, /\*\*Merge it as it is\*\*[^\n]*admin bypass/);
    assert.match(DEFAULT_BRANCH_CHECK, /\*\*The Delegation merges the default branch in\*\*/);
    assert.match(DEFAULT_BRANCH_CHECK, /new head[^\n]*step 7[^\n]*`void`/);
  });

  it("recommends (i) only when the re-gate passed, and gives a conflict no second question", () => {
    assert.match(
      DEFAULT_BRANCH_CHECK,
      /Recommend 1 when the re-gate passed \(or did not need to run\); otherwise 2/,
    );
    assert.match(DEFAULT_BRANCH_CHECK, /That is the row's one question from this check/);
  });

  it("in an autonomous run, only option 2 can be a Ruling; option 1 stays the human's", () => {
    assert.match(
      DEFAULT_BRANCH_CHECK,
      /autonomous run, option 2 may be a Ruling, when the re-gate failed/,
    );
    assert.match(DEFAULT_BRANCH_CHECK, /option 1 is always the human's/);
    const auto = section(SKILL, "## Autonomous runs");
    assert.match(
      auto,
      /merging the default branch into a row's branch \(step 10\), when its re-gate on the merge result failed;/,
    );
    assert.match(auto, /merging a row as it is with the admin bypass/);
  });
});

describe("SKILL.md: the merge order", () => {
  it('says merge one at a time and say "merged <pr>" after each, whenever more than one row is listed', () => {
    assert.match(STEP10, /merge one at a time, and say "merged <pr>" after each/);
    assert.match(STEP10, /When the list has more than one row[^\n]*merge one at a time/);
    assert.ok(
      !STEP10.includes("When any row was `BEHIND` at a check in this run"),
      "the instruction does not wait for a row to be `BEHIND` first",
    );
  });
});

describe("RUN.md", () => {
  // The board's example opens with a `# Run` heading inside its fence, which ends `section`.
  const board = RUN.slice(RUN.indexOf("\n## Board\n"), RUN.indexOf("\n## States\n"));
  const states = section(RUN, "## States");

  it("the board form has the Default branch line straight under Heartbeat", () => {
    assert.match(
      board,
      /^Heartbeat: .+\n\nDefault branch: <name> at <SHA>, checked <time>; passed: <Delegation>@<head>, …, or none\.$/m,
    );
    assert.match(board, /^The `Default branch` line/m);
  });

  it("`ready to merge` carries the clause, and a `BEHIND` row is `waiting`", () => {
    assert.ok(
      row(states, "ready to merge").includes(READY_CLAUSE),
      "ready to merge has the clause",
    );
    assert.match(row(states, "waiting"), /`BEHIND`/);
  });

  it("`--resume` runs the check before it lists a row", () => {
    assert.match(section(RUN, "## Resume"), /default-branch check/);
  });

  it("`--status` runs the check and changes nothing but the board's check result", () => {
    const status = section(RUN, "## Status");
    assert.match(status, /default-branch check/);
    assert.match(
      status,
      /changes nothing else: it sets no row's state, messages no Delegation, voids no QA, re-arms nothing, and raises no Decision Request/,
    );
    assert.match(status, /`--resume` step 4 runs the check on it again and acts on what it finds/);
    assert.ok(
      !status.includes("set back to `reported`"),
      "`--status` leaves each row's state alone",
    );
    assert.match(DEFAULT_BRANCH_CHECK, /On `--status`, the check acts on nothing/);
    assert.ok(
      !status.includes("It reads nothing else and changes nothing."),
      "the old rule is gone",
    );
  });
});

describe("the glossary and DESIGN.md", () => {
  it("GLOSSARY's **Ready to Merge** has the clause", () => {
    const entry = GLOSSARY.split("\n**Ready to Merge**:\n")[1].split("\n")[0];
    assert.ok(entry.includes(READY_CLAUSE), entry);
  });

  it("DESIGN.md says why the check runs on the human's return, not on a heartbeat", () => {
    const why = section(DESIGN, "## The default branch, checked on the human's return");
    assert.match(why, /heartbeat/);
    assert.match(why, /`mergeStateStatus`/);
  });
});

describe("docs/orchestrate.md and CONFIG.md", () => {
  it("the guide's `--status` row says it runs the check and writes only its result", () => {
    const line = DOCS.split("\n").find((l) => l.startsWith("| `/orchestrate --status [<run>]`"));
    assert.ok(line, "the `--status` row exists");
    assert.match(line, /default-branch check/);
    assert.match(line, /only the board's `Default branch` line/);
    assert.ok(!line.includes("changes nothing."), "the old read-only rule is gone");
  });

  it("the guide's close-out and run-state sections name the check and the one-at-a-time order", () => {
    assert.match(DOCS, /merge one at a time, and say "merged <pr>" after each/);
    const runState = DOCS.split("\n").find((l) => l.startsWith("`--status` prints the board"));
    assert.ok(runState, "the run-state `--status` line exists");
    assert.match(runState, /default-branch check/);
  });

  it("the guide's Ready to Merge sentence and CONFIG.md's carry the clause", () => {
    assert.ok(DOCS.includes(READY_CLAUSE), "docs/orchestrate.md has the clause");
    assert.match(
      section(CONFIG, "### `ready_to_merge`"),
      /merges cleanly into the default branch as it now is/,
    );
    assert.ok(
      !CONFIG.includes("beyond green CI and a clean merge."),
      "the config table names the default branch too",
    );
  });
});

describe("CHANGELOG.md", () => {
  it("has an [Unreleased] line for the change", () => {
    const unreleased = CHANGELOG.split("\n## [Unreleased]\n")[1].split("\n## [")[0];
    assert.match(unreleased, /\[#288\]/);
  });
});
