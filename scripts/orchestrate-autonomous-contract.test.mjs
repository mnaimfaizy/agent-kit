/**
 * Contract test: an autonomous `orchestrate` run (issue #274, ADR 0008) is
 * written into the skill where a run reads it. The skill is prose, and no code
 * parses an invocation, so these tests pin the sentences a run relies on: the
 * `autonomous` invocation forms and the rule that rejects every other mix, the
 * Decision authority line, the fixed split, the Ruling Ledger's file, the
 * board's states, the Ruling form a brief carries, the report's
 * commit-to-Ruling map, the integration-branch case, how each harness can
 * notify the human, and the ADR's status. What a sentence means is for review;
 * these only keep it from being dropped.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const SKILL_DIR = ".claude/skills/orchestrate";
const SKILL = read(`${SKILL_DIR}/SKILL.md`);
const RUN = read(`${SKILL_DIR}/RUN.md`);
const BRIEF = read(`${SKILL_DIR}/BRIEF.md`);
const SPEC = read(`${SKILL_DIR}/SPEC.md`);
const HARNESSES = read(`${SKILL_DIR}/HARNESSES.md`);
const DOCS = read("docs/orchestrate.md");

/** The text of a `## ` or `### ` section, from its heading to the next of the same depth or higher. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const depth = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${depth}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

describe("SKILL.md: invocations", () => {
  const invocations = section(SKILL, "## Invocations");

  it("names `go autonomous` for issues, and `autonomous` for a spec", () => {
    assert.match(invocations, /`\/orchestrate #12 #34 go autonomous`/);
    assert.match(invocations, /`\/orchestrate --spec 50 \[go\] \[autonomous\]`/);
  });

  it("says the word only fills in the Decision authority line", () => {
    assert.match(invocations, /Decision authority/);
  });

  it("keeps the rule that stops any other argument or mix, and names `autonomous` in it", () => {
    assert.match(invocations, /stops the run before anything is read/);
    const rule = invocations.split("\n").find((l) => l.includes("stops the run before anything"));
    assert.match(rule, /`autonomous`/);
  });

  it("puts `autonomous` in the argument hint", () => {
    const hint = /^argument-hint: "(.+)"$/m.exec(SKILL)[1];
    assert.match(hint, /#<n> \[#<n>…\] \[go\] \[autonomous\]/);
    assert.match(hint, /--spec <n> \[go\] \[autonomous\]/);
  });
});

describe("SKILL.md: rules and steps", () => {
  it("gives the 'every question goes to the human whole' rule its autonomous mode", () => {
    const rule = SKILL.split("\n").find((l) =>
      l.startsWith("- **Every question goes to the human whole.**"),
    );
    assert.ok(rule, "the rule is there");
    assert.match(rule, /autonomous run/);
    assert.match(rule, /Ruling/);
  });

  it("has a section for autonomous runs with the fixed split and the evidence bar", () => {
    const auto = section(SKILL, "## Autonomous runs");
    for (const phrase of [
      "within its issue's goal",
      "stalled or crashed",
      "merge order",
      "QA FAIL",
      "delivery of a QA Plan",
      "widening a scope fence",
      "waiving a manual scenario",
      "analysis Delegation's options",
      "Authority",
      "`waiting`",
      "cannot be undone by a later commit",
      "`R<n>`",
      "needs re-review",
    ])
      assert.ok(auto.includes(phrase), `Autonomous runs says "${phrase}"`);
  });

  it("step 4 shows the Decision authority line, and waits below `verified`", () => {
    const step = section(SKILL, "### 4. Show the Dispatch Plan");
    assert.match(step, /\*\*Decision authority\*\*/);
    assert.match(step, /`go autonomous`/);
  });

  for (const [heading, phrase] of [
    ["### 6. Run the loop", "Ruling"],
    ["### 7. Verify each report", "Ruling"],
    ["### 9. QA each finished head", "Ruling"],
    ["### 10. Close out", "Ruling Review"],
  ])
    it(`${heading.slice(4)} says how it changes in an autonomous run`, () => {
      assert.ok(section(SKILL, heading).includes(phrase));
    });

  it("close-out lists Delegations awaiting Ruling Review and takes per-Ruling answers", () => {
    const step = section(SKILL, "### 10. Close out");
    assert.match(step, /`awaiting Ruling Review`/);
    assert.match(step, /upheld: R1 R2; overturned: R3 → option 2/);
    assert.match(step, /uphold all/);
  });
});

describe("RUN.md", () => {
  it("names the Ruling Ledger's file in the layout", () => {
    assert.match(section(RUN, "## Layout"), /^ {2}rulings\.md {2,}the Ruling Ledger/m);
  });

  it("has the board states `awaiting Ruling Review`", () => {
    assert.match(section(RUN, "## States"), /^\| `awaiting Ruling Review` +\|/m);
  });

  it("describes the ledger, its verdicts and `needs re-review`", () => {
    const ledger = section(RUN, "## Ruling Ledger");
    for (const verdict of ["`unreviewed`", "`upheld`", "`overturned`", "`needs re-review`"])
      assert.ok(ledger.includes(verdict), `ledger verdict ${verdict}`);
    assert.match(ledger, /\*\*Cites:\*\*/);
  });

  it("prints the ledger on `--status`, and opens `--resume` with the Rulings awaiting review", () => {
    assert.match(section(RUN, "## Status"), /Ruling Ledger/);
    assert.match(section(RUN, "## Resume"), /awaiting review/);
  });

  it("lists every Ruling with its verdict in the Run Summary", () => {
    assert.match(section(RUN, "## Run Summary"), /each Ruling with its verdict/);
  });
});

describe("BRIEF.md", () => {
  const contract = section(BRIEF, "## The Brief Contract");

  it("keeps the Brief Contract at eight items", () => {
    const items = contract.match(/^\d+\. \*\*/gm);
    assert.equal(items.length, 8);
  });

  it("item 7 says an answer may arrive as a Ruling, recorded labelled", () => {
    const item = contract.split("\n").find((l) => l.startsWith("7. "));
    assert.match(item, /`R<n>`/);
    assert.match(item, /Chief of Staff ruling, not yet reviewed/);
  });

  it("item 8 adds the commit-to-Ruling map", () => {
    const item = contract.split("\n").find((l) => l.startsWith("8. "));
    assert.match(item, /commit-to-Ruling map/);
  });

  it("gives the form a Ruling takes when sent to a Delegation", () => {
    const form = section(BRIEF, "## Ruling");
    assert.match(form, /### Ruling: R<n>, <one-line question>/);
    assert.match(form, /Chief of Staff ruling, not yet reviewed/);
    assert.match(form, /upheld|overturned/);
  });

  it("the report form carries a Rulings line", () => {
    assert.match(section(BRIEF, "## Report"), /^\*\*Rulings:\*\* /m);
  });
});

describe("SPEC.md", () => {
  it("holds the integration branch's pull request for the Ruling Review, with a fix Delegation for a landed ticket", () => {
    const landing = section(SPEC, "### On an integration branch");
    assert.match(landing, /Ruling Review/);
    assert.match(landing, /`d<n>-fix<k>`/);
  });
});

describe("harnesses", () => {
  it("HARNESSES.md says how a run notifies the human of a queued question", () => {
    assert.match(section(HARNESSES, "## Notifying the human"), /queued/);
    assert.match(section(HARNESSES, "### A harness file"), /`- \*\*Notify:\*\*`/);
  });

  for (const file of readdirSync(join(root, SKILL_DIR, "harnesses")).filter((f) =>
    f.endsWith(".md"),
  ))
    it(`${file} has a Notify line`, () => {
      assert.match(read(`${SKILL_DIR}/harnesses/${file}`), /^- \*\*Notify:\*\* \S/m);
    });
});

describe("docs and records", () => {
  it("docs/orchestrate.md documents autonomous runs", () => {
    const auto = section(DOCS, "## Autonomous runs");
    for (const phrase of ["`go autonomous`", "Ruling Ledger", "Ruling Review", "uphold all"])
      assert.ok(auto.includes(phrase), `docs say "${phrase}"`);
  });

  it("ADR 0008 is accepted", () => {
    assert.match(
      read("docs/adr/0008-orchestrate-may-rule-under-review.md"),
      /^---\nstatus: accepted\n---/,
    );
  });
});
