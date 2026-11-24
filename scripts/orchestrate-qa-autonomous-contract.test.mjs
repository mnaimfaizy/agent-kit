/**
 * Contract test: in a `go autonomous` orchestrate run, QA runs from the brief,
 * and in every run the QA readiness question is asked once, in the Dispatch
 * Plan (issue #289; ADR 0013, superseded by the
 * autonomous-QA handover ADR). The skill is prose, so these tests pin the
 * sentences a run relies on: the readiness question and its file, the rule
 * that keeps it out of every QA brief and every Ruling, the base-branch reuse
 * rule, the exact typed command with `--answers` in a plain `go` run, the
 * brief route for a `stack` target and the typed fallback for a `url` one,
 * the split and the Decision authority line, DESIGN.md, HARNESSES.md, each
 * harness file's QA start, the ADR and the changelog. What a sentence means is
 * for review; these only keep it from being dropped.
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
const BRIEF = read(`${SKILL_DIR}/BRIEF.md`);
const RUN = read(`${SKILL_DIR}/RUN.md`);
const DESIGN = read(`${SKILL_DIR}/DESIGN.md`);
const HARNESSES = read(`${SKILL_DIR}/HARNESSES.md`);

/** The text of a `## ` or `### ` section, from its heading to the next of the same depth or higher. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const depth = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${depth}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

/** The bullet in `text` that starts with `start`, with its indented lines. */
function bullet(text, start) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(start));
  assert.ok(at >= 0, `a bullet starting ${start}`);
  const out = [lines[at]];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s+\S/.test(line) && line !== "") break;
    out.push(line);
  }
  return out.join("\n");
}

const STEP4 = section(SKILL, "### 4. Show the Dispatch Plan");
const STEP9 = section(SKILL, "### 9. QA each finished head");
const AUTONOMOUS = section(SKILL, "## Autonomous runs");
const QA_BRIEF = section(BRIEF, "## The QA brief");
const STEP10 = section(SKILL, "### 10. Close out");

describe("readiness, once, in the Dispatch Plan", () => {
  const readiness = bullet(STEP4, "- **QA readiness, asked once.**");

  it("asks once, beside the go, with 'this run only' or 'save a config'", () => {
    assert.match(readiness, /check --for plan/);
    assert.match(readiness, /`readiness\.needs`/);
    assert.match(readiness, /once/);
    assert.match(readiness, /this run only/);
    assert.match(readiness, /save a config/);
  });

  it("writes the answers to the run folder as qa-readiness.json, and logs them", () => {
    assert.match(readiness, /`qa-readiness\.json`/);
    assert.match(readiness, /`--answers`/);
    assert.match(readiness, /log/);
  });

  it("is never asked again by a QA brief, never a mid-run Decision Request, never a Ruling", () => {
    assert.match(readiness, /No QA brief asks it again/);
    assert.match(readiness, /never a mid-run Decision Request or a Ruling/);
    assert.match(AUTONOMOUS, /QA readiness answers/);
  });

  it("reuses the answers only for a pull request with the same base branch", () => {
    assert.match(readiness, /base branch/);
    assert.match(readiness, /another base gets no answers file/);
    assert.match(readiness, /`qa-readiness-<base>\.json`/);
  });

  it("RUN.md's Layout lists qa-readiness.json, and the board records it", () => {
    const layout = section(RUN, "## Layout");
    assert.match(layout, /qa-readiness\.json/);
    assert.match(layout, /qa-readiness-<base>\.json/);
    // The board's template is a fenced block whose `# Run` line ends a section early.
    assert.match(RUN, /^QA readiness: </m);
  });
});

describe("the QA brief", () => {
  it("copies the run's answers file into working_dir first", () => {
    assert.match(QA_BRIEF, /copy the run's answers file/);
    assert.match(QA_BRIEF, /`<working_dir>\/qa-readiness\.json`/);
  });

  it("gives a pull request with another base no answers file", () => {
    assert.match(QA_BRIEF, /another base branch/);
  });

  it("names both routes: typed, and from the brief", () => {
    assert.match(QA_BRIEF, /\*\*The typed route\.\*\*/);
    assert.match(QA_BRIEF, /\*\*The brief route\.\*\*/);
  });

  it("on the typed route, gives the exact command with --answers", () => {
    assert.match(QA_BRIEF, /`\/qa-plan <n> \[--answers <working_dir>\/qa-readiness\.json\]`/);
  });

  it("on the brief route, carries each skill's SKILL.md and folder from the same install as its scripts", () => {
    assert.match(QA_BRIEF, /`<qa-plan>\/SKILL\.md`/);
    assert.match(QA_BRIEF, /`<manual-qa>\/SKILL\.md`/);
    assert.match(QA_BRIEF, /same install as its helper scripts/);
    assert.match(QA_BRIEF, /Run from an autonomous brief/);
  });

  it("uploads nothing on the brief route, and queues an unapproved post", () => {
    assert.match(QA_BRIEF, /uploads nothing/);
    assert.match(QA_BRIEF, /queued write/);
  });
});

describe("SKILL.md: how each QA skill starts", () => {
  const starts = bullet(STEP4, "- **How each QA skill starts.**");

  it("in a plain go run, the human is told the exact command, with --answers", () => {
    assert.match(starts, /exact command/);
    assert.match(starts, /--answers/);
  });

  it("in a go autonomous run on a stack target, QA runs from the brief with no command typed", () => {
    assert.match(starts, /`target: stack`/);
    assert.match(starts, /from the brief/);
    assert.match(starts, /no command/i);
  });

  it("in a go autonomous run on a url target, QA runs from the brief too, with the hosts typed in the Dispatch Plan (#421)", () => {
    assert.match(starts, /`target: url`/);
    assert.match(starts, /typed in the Dispatch Plan/);
    assert.doesNotMatch(starts, /`target: url`: the typed route/);
    assert.doesNotMatch(starts, /so that QA Delegation is `waiting`/);
  });

  it("step 9 gives the exact command on the typed route, and nothing to send on the brief route", () => {
    assert.match(STEP9, /--answers/);
    assert.match(STEP9, /brief route/);
  });

  it("step 9 handles a send-back Ruling from qa-plan's test question, and a regression at compose", () => {
    assert.match(STEP9, /Add the test/);
    assert.match(STEP9, /`void`/);
    assert.match(STEP9, /regression/);
  });
});

describe("the autonomous split and the Decision authority line", () => {
  it("hands over QA from the brief, all or nothing", () => {
    assert.match(AUTONOMOUS, /\*\*QA runs from the brief\.\*\*/);
    assert.match(AUTONOMOUS, /all or nothing/);
  });

  it("rules on the subject issue, an unknown row and a suggested test, under the evidence bar", () => {
    const rules = AUTONOMOUS.split("\n").find((l) =>
      l.startsWith("- **The Chief of Staff rules on:**"),
    );
    assert.match(rules, /subject issue/);
    assert.match(rules, /`unknown`/);
    assert.match(rules, /test/);
  });

  it("keeps the readiness answers, and the typing of each hosted host, with the human (#421)", () => {
    const keeps = AUTONOMOUS.split("\n").find((l) => l.startsWith("- **The human keeps:**"));
    assert.match(keeps, /QA readiness answers/);
    assert.match(keeps, /`url`/);
    assert.match(keeps, /typed in the Dispatch Plan/);
    assert.doesNotMatch(keeps, /host and role test values/);
  });

  it("the Decision authority line says QA runs from the brief", () => {
    const line = STEP4.split("\n").find((l) =>
      l.startsWith("Last, the **Decision authority** line"),
    );
    assert.match(line, /from the brief/);
  });
});

describe("DESIGN.md and HARNESSES.md", () => {
  it("DESIGN.md says the skills are invoked only by a person outside an autonomous run", () => {
    assert.match(
      DESIGN,
      /Outside an autonomous run, those skills are invoked only by a person, and stay so/,
    );
    assert.match(DESIGN, /Run from an autonomous brief/);
  });

  it("HARNESSES.md says both routes, and keeps the browser and working-copy reasons for no sub-agent", () => {
    const choosing = section(HARNESSES, "## Choosing an Executor");
    const rule = choosing
      .split("\n")
      .find((l) => l.startsWith("A QA Delegation is never a sub-agent"));
    assert.match(rule, /working copy and a browser of its own/);
    assert.match(choosing, /`go autonomous`/);
    assert.match(choosing, /typed/);
  });

  it("each harness file's QA start says both routes", () => {
    const dir = `${SKILL_DIR}/harnesses`;
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith(".md"))) {
      const text = read(`${dir}/${file}`);
      const line = text.split("\n").find((l) => l.startsWith("- A QA Delegation:"));
      assert.ok(line, `${file} has a QA start`);
      assert.match(line, /with `go`, that is the typed route/i, `${file}: the typed route with go`);
      assert.match(line, /with `go autonomous`/i, `${file}: the brief route with go autonomous`);
    }
  });
});

describe("review fixes on PR #297", () => {
  const harnessDir = `${SKILL_DIR}/harnesses`;
  const harnessFiles = readdirSync(join(root, harnessDir)).filter((f) => f.endsWith(".md"));
  const typedSources = [
    [`${SKILL_DIR}/SKILL.md`, SKILL],
    [`${SKILL_DIR}/BRIEF.md`, BRIEF],
    [`${SKILL_DIR}/HARNESSES.md`, HARNESSES],
    ["docs/orchestrate.md", read("docs/orchestrate.md")],
    ...harnessFiles.map((f) => [`${harnessDir}/${f}`, read(`${harnessDir}/${f}`)]),
  ];

  it("every typed qa-plan command carries `--answers` only as an optional part", () => {
    for (const [file, text] of typedSources)
      for (const line of text.split("\n")) {
        // A check-before-use question and a record of an earlier run quote no command to send.
        if (line.startsWith("- Whether") || line.includes("In the first run")) continue;
        if (!/[/$]qa-plan <n>|run it for #<n>/.test(line)) continue;
        assert.match(line, /\[--answers [^\]]+\]/, `${file}: ${line.slice(0, 80)}`);
        assert.doesNotMatch(line, /qa-plan <n> --answers/, `${file}: --answers without brackets`);
      }
  });

  it("step 4 says when `--answers` is sent: only with an answers file for the pull request's base", () => {
    assert.match(STEP4, /only when the run has an answers file for its pull request's base/);
  });

  it("the base the answers hold for comes from the merged config, the config's own base_ref included", () => {
    const readiness = bullet(STEP4, "- **QA readiness, asked once.**");
    assert.match(readiness, /`effective\.plan\.base_ref`/);
  });

  it("BRIEF.md phase 3 stops on any Decision Request the skill's run section raises", () => {
    const phase3 = QA_BRIEF.split("\n").find((l) => l.trimStart().startsWith("3. **Run it**"));
    assert.match(phase3, /any Decision Request/);
    assert.match(phase3, /Run from an autonomous brief/);
  });

  it("each harness file's QA limit that has the human type the commands names the typed route", () => {
    for (const file of harnessFiles) {
      const limits = section(read(`${harnessDir}/${file}`), "## Limits");
      for (const line of limits.split("\n"))
        if (/human types|types the two/.test(line))
          assert.match(line, /typed route/, `${file}: ${line.slice(0, 80)}`);
    }
  });

  it("docs/orchestrate.md's run-folder layout lists the readiness files", () => {
    const docs = read("docs/orchestrate.md");
    assert.match(docs, /^ {2}qa-readiness\.json /m);
    assert.match(docs, /^ {2}qa-readiness-<base>\.json /m);
  });

  it("docs/orchestrate.md's harness table says typing the QA commands is the typed route only", () => {
    const docs = read("docs/orchestrate.md");
    for (const line of docs.split("\n").filter((l) => /type the QA commands/.test(l)))
      assert.match(line, /typed route/, line.slice(0, 80));
  });

  it("the changelog line ends with its Consumer action", () => {
    const line = read("CHANGELOG.md")
      .split("\n")
      .find((l) => l.includes("[#289]"));
    assert.match(line, /\*\*Consumer action:\*\* none\.$/);
  });
});

describe("approving QA in the Dispatch Plan (#419)", () => {
  const yes = bullet(STEP4, "- **The QA yes.**");
  const qaLine = STEP4.split("\n").find((l) => l.startsWith("Under it, the **QA** line"));

  it("is a yes of its own, asked only when the config proposes QA rows, and not implied by go autonomous", () => {
    assert.match(yes, /separate yes/);
    assert.match(yes, /only when the config proposes QA rows/);
    assert.match(yes, /asks nothing/);
    assert.match(yes, /not implied by `autonomous`/);
  });

  it("lets the human strike rows, as in 'QA all but #258'", () => {
    assert.match(yes, /QA all but #258/);
    assert.match(yes, /strike/);
  });

  it("'no' (or a struck row) means no QA: Ready to Merge without it, the board and close-out say so, no readiness question", () => {
    assert.match(yes, /"no", or a struck row, means no QA/);
    assert.match(yes, /Ready to Merge without it/);
    assert.match(yes, /QA declined in the Dispatch Plan/);
    assert.match(yes, /board/);
    assert.match(yes, /close-out/);
    assert.match(yes, /no readiness question/);
  });

  it("covers re-QA on a new head, and leaves a plain go run on the typed route", () => {
    assert.match(yes, /`-qa2`/);
    assert.match(yes, /`-qa3`/);
    assert.match(yes, /plain `go`/);
    assert.match(yes, /typed route/);
  });

  it("the QA line sits under the Decision authority line: asked now, ruled on, held for close-out", () => {
    assert.ok(
      STEP4.indexOf("Under it, the **QA** line") >
        STEP4.indexOf("Last, the **Decision authority** line"),
    );
    assert.match(qaLine, /asked now/);
    assert.match(qaLine, /the Chief of Staff rules on/);
    assert.match(qaLine, /held for close-out/);
  });

  it("the QA Rulings join the autonomous half only when QA is approved", () => {
    const line = STEP4.split("\n").find((l) =>
      l.startsWith("Last, the **Decision authority** line"),
    );
    assert.match(line, /only when QA is approved/);
    assert.match(AUTONOMOUS, /only when QA is approved/);
  });

  it("RUN.md's board records the QA line, and what declined QA looks like", () => {
    assert.match(RUN, /^QA: </m);
    assert.match(RUN, /QA declined in the Dispatch Plan/);
  });
});

describe("the run's needs, asked up front (#419)", () => {
  const needs = bullet(STEP4, "- **QA run needs, asked up front.**");

  it("runs manual-qa's check --for run with no plan, beside the readiness check, in one message", () => {
    assert.match(needs, /check --for run/);
    assert.match(needs, /no plan/);
    assert.match(needs, /same message/);
    assert.match(needs, /`readiness\.needs`/);
  });

  it("writes the answers to qa-run.json, and checks them with --answers, --answers-base and --base", () => {
    assert.match(needs, /`qa-run\.json`/);
    assert.match(needs, /--answers/);
    assert.match(needs, /--answers-base/);
    assert.match(needs, /--base/);
  });

  it("one 'this run only, or save a config' choice covers both answers files", () => {
    assert.match(needs, /one choice covers both/);
    assert.match(needs, /this run only/);
    assert.match(needs, /save a config/);
  });

  it("checks that working_dir is ignored, asking once", () => {
    assert.match(needs, /`working_dir`/);
    assert.match(needs, /git check-ignore/);
    assert.match(needs, /once/);
  });

  it("asks the optional local address, run.stack.address, and checks it with host", () => {
    assert.match(needs, /`run\.stack\.address`/);
    assert.match(needs, /optional/);
    assert.match(needs, /adapter\.mjs" host/);
    assert.match(needs, /`local`/);
  });

  it("never asks it again in a QA brief, as a Decision Request or as a Ruling", () => {
    assert.match(needs, /No QA brief asks it again/);
    assert.match(needs, /never a mid-run Decision Request or a Ruling/);
  });

  it("RUN.md's Layout lists qa-run.json", () => {
    assert.match(section(RUN, "## Layout"), /qa-run\.json/);
  });

  it("the QA brief names qa-run.json, copied with qa-readiness.json, and passes it to manual-qa by --answers", () => {
    assert.match(QA_BRIEF, /`<working_dir>\/qa-run\.json`/);
    assert.match(QA_BRIEF, /manual-qa/);
    const phase3 = QA_BRIEF.split("\n").find((l) => l.trimStart().startsWith("3. **Run it**"));
    assert.match(phase3, /--answers <working_dir>\/qa-run\.json/);
  });

  it("how each QA skill starts: from the brief only on approved QA, on a stack target", () => {
    const starts = bullet(STEP4, "- **How each QA skill starts.**");
    assert.match(starts, /QA is approved/);
  });
});

describe("nothing asked mid-run once QA is approved (#419)", () => {
  const approved = section(SKILL, "#### Approved QA: Rulings, holds and Review boxes");
  const rules = AUTONOMOUS.split("\n").find((l) =>
    l.startsWith("- **The Chief of Staff rules on:**"),
  );
  const nothing = bullet(AUTONOMOUS, "**Nothing is asked mid-run once QA is approved.**");

  it("no QA Decision Request sets a Delegation `waiting` on the human mid-run", () => {
    assert.match(nothing, /never sets itself `waiting` on the human/);
    assert.match(approved, /never `waiting` on the human/);
  });

  it("each question goes one of three ways: asked up front, ruled, or held", () => {
    assert.match(nothing, /asked once in the Dispatch Plan/i);
    assert.match(nothing, /ruled by the Chief of Staff/i);
    assert.match(nothing, /held for close-out/i);
  });

  it("rules on plan delivery, the subject issue, unknown rows, the add-the-test send-back, run.surface and a FAIL", () => {
    for (const re of [
      /delivery of a QA Plan/,
      /subject issue/,
      /`unknown`/,
      /add the test|Add the test/i,
      /`run\.surface`/,
      /send(?:ing)? (?:it )?back|send it back/i,
      /re-?run|run QA again/i,
    ])
      assert.match(`${rules}\n${approved}`, re);
  });

  it("holds judgment boxes, scenarios left for a person, after-merge scenarios, late needs, an unignored working_dir, a missing address, accepting a FAIL and waiving a scenario", () => {
    for (const re of [
      /judgment boxes|needs judgment/,
      /scenarios left for a person/,
      /after[- ]merge/,
      /pass, waive, or run after merge/,
      /only appear after compose|appear only after compose/,
      /`working_dir` not ignored/,
      /missing address/,
      /accepting a FAIL/,
      /waiving a scenario/,
      /anything the evidence does not settle/,
    ])
      assert.match(nothing, re);
  });

  it("the unignored working_dir: the session writes nothing, stops, and its row is held", () => {
    assert.match(approved, /writes nothing and stops/);
  });

  it("the evidence bar holds the Rulings; the human's QA answers are not Rulings", () => {
    assert.match(nothing, /not Rulings/);
  });
});

describe("Review boxes: quoted, ruled, never ticked by an agent (#419)", () => {
  const approved = section(SKILL, "#### Approved QA: Rulings, holds and Review boxes");
  const boxes = bullet(approved, "- **Review boxes.**");

  it("the QA session quotes each open box's file at the pinned head, saves the quote, and marks it literal or judgment", () => {
    assert.match(boxes, /quotes each open box's file at the pinned head/);
    assert.match(boxes, /`review-quotes\.md`/);
    assert.match(boxes, /"literal, quoted"/);
    assert.match(boxes, /"needs judgment"/);
  });

  it("the Chief of Staff re-reads the source at that SHA, and rules holds or does not hold", () => {
    assert.match(boxes, /re-reads the source at that SHA/);
    assert.match(boxes, /"holds"/);
    assert.match(boxes, /"does not hold"/);
    assert.match(boxes, /never the only evidence/);
  });

  it("'holds' is shown as (checked under R<n>), and its Ruling reaches the pull request body", () => {
    assert.match(boxes, /\(checked under R<n>\)/);
    assert.match(boxes, /pull request/);
  });

  it("'does not hold' is a FAIL, sent back; a judgment box is held", () => {
    assert.match(boxes, /FAIL/);
    assert.match(boxes, /sent back/);
    assert.match(boxes, /held for close-out/);
  });

  it("no agent ever ticks a box, even under a 'holds' Ruling", () => {
    assert.match(boxes, /No agent ever ticks a box/);
    assert.match(boxes, /even under a "holds" Ruling/);
  });

  it("the QA brief and its report carry the quotes and the held items", () => {
    assert.match(QA_BRIEF, /`review-quotes\.md`/);
    assert.match(BRIEF, /\*\*Held for close-out:\*\*/);
  });
});

describe("QA held for you: after the Ruling Review, outside the Ledger (#419)", () => {
  const held = bullet(STEP10, "**QA held for you.**");

  it("is listed right after the Ruling Review", () => {
    assert.ok(
      STEP10.indexOf("**QA held for you.**") > STEP10.indexOf("the Ruling Review comes first"),
    );
    assert.match(held, /right after the Ruling Review/);
  });

  it("lists each held item with its row, evidence and options, in one sitting", () => {
    assert.match(held, /row/);
    assert.match(held, /evidence/);
    assert.match(held, /options/);
  });

  it("is outside the Ruling Ledger, since held items are not Rulings", () => {
    assert.match(held, /outside the Ruling Ledger/);
    assert.match(held, /not Rulings/);
    assert.match(held, /`qa-held\.md`/);
  });

  it("a row is Ready to Merge once its held items are answered", () => {
    assert.match(held, /Ready to Merge once/);
    assert.match(held, /answered/);
  });

  it("the close-out says QA declined in the Dispatch Plan, for each such row", () => {
    assert.match(STEP10, /QA declined in the Dispatch Plan/);
  });

  it("RUN.md has the state, the held file and the review quotes", () => {
    assert.match(RUN, /held QA items still unanswered in `qa-held\.md`/);
    assert.match(section(RUN, "## Layout"), /qa-held\.md/);
    assert.match(section(RUN, "## Layout"), /review-quotes\.md/);
  });
});

describe("DESIGN.md, HARNESSES.md, docs and the glossary say it (#419)", () => {
  it("DESIGN.md gives the reasons: a separate yes, nothing asked mid-run, held items outside the Ledger, no ticks", () => {
    const why = section(DESIGN, "## QA asks nothing mid-run");
    assert.match(why, /separate yes/);
    assert.match(why, /never `waiting`|never waits/);
    assert.match(why, /outside the Ruling Ledger/);
    assert.match(why, /never ticked by an agent|No agent ever ticks/);
    assert.match(why, /ADR 0032/);
  });

  it("DESIGN.md's QA section no longer says the human types the hosted commands only; the stack route is from the brief on approved QA", () => {
    assert.match(DESIGN, /approved QA/);
  });

  it("HARNESSES.md says the stack route needs the QA yes, and plain go stays typed", () => {
    const choosing = section(HARNESSES, "## Choosing an Executor");
    assert.match(choosing, /QA yes/);
    assert.match(choosing, /With `go`:\*\* typed/);
    assert.doesNotMatch(choosing, /for a `url` target in any run/);
  });

  it("docs/orchestrate.md says QA is a separate yes, nothing is asked mid-run, and the held list", () => {
    const docs = read("docs/orchestrate.md");
    const para = docs.split("\n").find((l) => l.startsWith("**QA runs from the brief.**"));
    assert.match(para, /separate yes/);
    assert.match(para, /QA held for you/);
    assert.match(para, /QA declined in the Dispatch Plan/);
    assert.match(para, /Review box/);
    assert.match(docs, /^ {2}qa-run\.json /m);
    assert.match(docs, /^ {2}qa-held\.md /m);
  });

  it("GLOSSARY.md defines QA held for you, right after Ruling Review", () => {
    const g = read("GLOSSARY.md");
    assert.ok(g.indexOf("**QA held for you**:") > g.indexOf("**Ruling Review**:"));
    assert.ok(g.indexOf("**QA held for you**:") < g.indexOf("**Dispatch Plan**:"));
  });
});

describe("parked QA sessions on the desktop harness (#422)", () => {
  const DESKTOP = read(`${SKILL_DIR}/harnesses/claude-code-desktop.md`);
  const parked = bullet(DESKTOP, "- Parked QA sessions:");
  const reQa = bullet(DESKTOP, "- Re-QA in a parked session:");
  const unusable = bullet(DESKTOP, "- An unusable parked session:");

  it("with QA approved, starts one Live Session per QA row on the go turn, which the human's words authorize", () => {
    assert.match(parked, /approved/);
    assert.match(parked, /`go` turn/);
    assert.match(parked, /human's words/);
    assert.match(parked, /one Live Session per QA row/);
    assert.match(parked, /own worktree/);
    assert.match(parked, /without `<head>`/);
    assert.match(parked, /idle/);
    assert.match(parked, /messag\w* the head/);
  });

  it("the Executors line says a QA Live Session is parked at go", () => {
    const line = DESKTOP.split("\n").find((l) => l.startsWith("- **Executors:**"));
    assert.match(line, /QA, a Live Session, parked/);
  });

  it("re-QA is a new QA Delegation that runs in the same session, which throws away its old state and re-pins", () => {
    assert.match(reQa, /`d<issue>-qa2`/);
    assert.match(reQa, /same session/);
    assert.match(reQa, /throws away its old state/);
    assert.match(reQa, /re-pins/);
    assert.match(reQa, /QA Plan and QA Report/);
    assert.match(reQa, /copied to the run folder/);
  });

  it("an archived, crashed or dropped parked session holds its row for close-out, and no card is started mid-run", () => {
    assert.match(unusable, /archived, crashed or dropped/);
    assert.match(unusable, /holds its row for close-out/);
    assert.match(unusable, /no card is ever started mid-run/);
  });

  it("the QA Stack stays held by one session at a time", () => {
    assert.match(parked, /QA Stack/);
    assert.match(parked, /one session at a time/);
  });

  it("check before use adds how long an idle parked session stays usable, and re-pinning a voided session", () => {
    const check = section(DESKTOP, "## Check before use");
    assert.match(check, /how long an idle parked QA session stays usable/i);
    assert.match(check, /re-pin\w* a voided/i);
  });

  it("the QA brief works without <head> until the head is messaged: phase 1 waits for the message, then pins", () => {
    assert.match(QA_BRIEF, /parked/i);
    assert.match(QA_BRIEF, /without `<head>`/);
    assert.match(QA_BRIEF, /waits for the head message|wait for the head message/i);
    assert.match(QA_BRIEF, /then pins/i);
  });

  it("the QA brief's re-QA message re-pins a session that has run before", () => {
    assert.match(QA_BRIEF, /throws? away its old state/i);
  });

  it("step 4 names the headless opt-in with its three costs", () => {
    const optIn = bullet(STEP4, "- **The headless opt-in.**");
    assert.match(optIn, /`executors\.qa: claude-code-cli`/);
    assert.match(optIn, /cannot watch/);
    assert.match(optIn, /no built-in browser/);
    assert.match(optIn, /`--permission-mode auto`/);
  });

  it("step 5 starts parked QA sessions at go, and step 9 messages the head to a parked session", () => {
    const step5 = section(SKILL, "### 5. Dispatch a wave");
    assert.match(step5, /parked QA/i);
    assert.match(step5, /`go` turn/);
    assert.match(STEP9, /parked/i);
    assert.match(STEP9, /message\w* it the head/i);
  });

  it("step 9: a re-QA on a parked session is a message, never a card", () => {
    assert.match(STEP9, /same session/);
    assert.match(STEP9, /never a card/);
  });

  it("RUN.md's `parked` state covers a started QA session waiting for its head", () => {
    assert.match(RUN, /started QA session[^|]*waiting for its head/i);
  });

  it("HARNESSES.md says a parked start is a desktop-harness fact", () => {
    assert.match(HARNESSES, /parked/i);
  });

  it("DESIGN.md gives the reason: the go turn is the human's words, a card needs a click", () => {
    const qa = section(DESIGN, "## QA asks nothing mid-run");
    assert.match(qa, /parked/i);
    assert.match(qa, /card/);
  });

  it("docs/orchestrate.md says QA sessions start parked on Claude Code desktop", () => {
    const docs = read("docs/orchestrate.md");
    assert.match(docs, /parked/i);
    assert.match(docs, /`executors\.qa: claude-code-cli`/);
  });
});

describe("the ADR and the changelog", () => {
  const adrs = readdirSync(join(root, "docs/adr"));
  const old = adrs.filter((f) => f.startsWith("0013-"));
  const handover = adrs.filter((f) => f.includes("autonomous-qa-handover"));

  it("ADR 0013 is marked superseded by the handover ADR, and the handover ADR supersedes it", () => {
    assert.equal(old.length, 1);
    assert.equal(handover.length, 1);
    const number = handover[0].slice(0, 4);
    const adr = read(`docs/adr/${old[0]}`);
    assert.match(adr, new RegExp(`^status: superseded by ADR-${number}$`, "m"));
    const next = read(`docs/adr/${handover[0]}`);
    assert.match(next, /^supersedes: ADR-0013$/m);
  });

  it("the handover ADR pins the decision, with its why and considered options", () => {
    const adr = read(`docs/adr/${handover[0]}`);
    assert.match(adr, /^# .*QA/m);
    assert.match(adr, /## Considered Options/);
    assert.match(adr, /model-invocable/);
    assert.match(adr, /implied by `go autonomous`/i);
    assert.match(adr, /mid-run/i);
    assert.match(adr, /hosted/i);
    assert.match(adr, /no config key confirms a hosted address/i);
    assert.match(adr, /sub-agent/i);
    assert.match(adr, /scheduled task/i);
    assert.match(adr, /never ticked by an agent/i);
    assert.match(adr, /parked/i);
  });

  it("the summary-post ADR exists, with its considered options", () => {
    const summary = adrs.filter((f) => f.includes("qa-report-summary"));
    assert.equal(summary.length, 1);
    const adr = read(`docs/adr/${summary[0]}`);
    assert.match(adr, /## Considered Options/);
    assert.match(adr, /full report/i);
    assert.match(adr, /variant B/i);
    assert.match(adr, /variant C/i);
  });

  it("CHANGELOG.md has the line, in [Unreleased] or the release that shipped it", () => {
    assert.match(read("CHANGELOG.md"), /^- .*\[#289\]/m);
  });
});

describe("orchestrate reads the QA summary (#420)", () => {
  const verify = bullet(STEP9, "3. **Verify its report**");
  const places = bullet(STEP4, "- **QA Places, shown and changeable.**");
  const uploads = bullet(STEP4, "- **QA uploads, off unless approved.**");
  const writes = bullet(STEP4, "- **The QA writes.**");
  const DOCS = read("docs/orchestrate.md");

  it("step 9 checks a QA claim by parsing the posted header with report.mjs summary", () => {
    assert.match(verify, /report\.mjs" summary/);
    assert.match(verify, /strict header/);
    assert.match(verify, /result=passed\|failed/);
    assert.match(verify, /no manual QA needed/);
  });

  it("a header whose commit is not the verified head, or that does not parse, counts as no report", () => {
    assert.match(verify, /commit[^.]*is not `<head>`/);
    assert.match(verify, /does not parse/);
    assert.match(verify, /counts as no report/);
  });

  it("the header's counts must equal the report's items left for a person and deferred", () => {
    assert.match(verify, /left-for-person/);
    assert.match(verify, /deferred/);
  });

  it("a claim never rests on the QA session's own words: the Chief of Staff reads the posted comment", () => {
    assert.match(verify, /reads the posted comment itself/);
  });

  it("the Dispatch Plan shows the Places the run will use, and the human changes them for the run or saves them", () => {
    assert.match(places, /report\.places/);
    assert.match(places, /report\.holds/);
    assert.match(places, /this run only/);
    assert.match(places, /save/);
    assert.match(places, /`local`/);
    assert.match(places, /`none`/);
  });

  it("says plainly that only check --for plan reads a run-only Places change", () => {
    assert.match(places, /adapter\.mjs plan/);
    assert.match(places, /commit it to the config/);
    assert.match(places, /composing the QA Plan only/);
    assert.match(places, /source of truth/);
    assert.match(QA_BRIEF, /composing the plan only/);
  });

  it("the QA brief carries the run's Places", () => {
    assert.match(QA_BRIEF, /\*\*The Places:\*\*/);
    assert.match(QA_BRIEF, /report\.places/);
    assert.match(QA_BRIEF, /report\.holds/);
  });

  it("uploads stay off unless 'upload eligible QA Artifacts to <tag>' is approved once, with the public-repo warning shown", () => {
    assert.match(uploads, /upload eligible QA Artifacts to `<tag>`/);
    assert.match(uploads, /off/);
    assert.match(uploads, /once/);
    assert.match(uploads, /gh repo view --json visibility/);
    assert.match(uploads, /anyone who can see this repository can download a release asset/);
  });

  it("with the yes, the QA session uploads what report.mjs evidence accepts, with no per-file question, never a failed run's media", () => {
    assert.match(uploads, /report\.mjs" evidence/);
    assert.match(uploads, /no per-file question/);
    assert.match(uploads, /never a failed run's/);
    assert.match(uploads, /eligibility refusals/);
  });

  it("The QA writes bullet no longer says a brief-route QA uploads nothing whatever is approved", () => {
    assert.doesNotMatch(writes, /uploads nothing/);
    assert.match(writes, /the one opt-in above, or nothing/);
  });

  it("the QA brief says whether uploads are approved, and uploads only then", () => {
    assert.match(QA_BRIEF, /\*\*Uploads:\*\*/);
    assert.match(QA_BRIEF, /upload eligible QA Artifacts to/);
    assert.match(QA_BRIEF, /uploads nothing unless/);
  });

  it("the QA brief never makes or asks about the stale edit, and logs the skip", () => {
    assert.match(QA_BRIEF, /stale edit/);
    assert.match(QA_BRIEF, /logs that it was skipped/);
  });

  it("the close-out lists a stale comment that stayed because posting was not approved", () => {
    assert.match(STEP10, /\*\*Stale QA comments\.\*\*/);
    assert.match(STEP10, /posting was not approved/);
    assert.match(STEP10, /older head/);
  });

  it("DESIGN.md and docs/orchestrate.md give the reasons", () => {
    assert.match(DESIGN, /by its header/);
    assert.match(DESIGN, /one opt-in/);
    assert.match(DOCS, /header/);
    assert.match(DOCS, /upload eligible QA Artifacts/);
    assert.match(DOCS, /stale/);
  });
});

describe("hosted targets typed in the Dispatch Plan (#421)", () => {
  const hosts = bullet(STEP4, "- **QA hosts, typed in the Dispatch Plan.**");

  it("collects each typed host, or each run.hosts candidate confirmed by typing it, in the reply to the plan", () => {
    assert.match(hosts, /`run\.hosts`/);
    assert.match(hosts, /candidates?/);
    assert.match(hosts, /typing/);
    assert.match(hosts, /reply to the Dispatch Plan|their reply/);
  });

  it("runs host --target url --confirmed with the typed host, and shows each verdict; only `hosted` goes ahead", () => {
    assert.match(hosts, /adapter\.mjs" host .*--target url --confirmed/);
    assert.match(hosts, /verdict/);
    assert.match(hosts, /only `hosted` goes ahead/);
  });

  it("holds a `stop` or unconfirmed entry before go, and only its scenarios", () => {
    assert.match(hosts, /`stop`/);
    assert.match(hosts, /unconfirmed/);
    assert.match(hosts, /held before "go"|held before the "go"/);
    assert.match(hosts, /only (?:its|the) scenarios/);
  });

  it("asks the seeder question per environment: yes lets the QA session run accounts.print, no holds the scenarios that sign in there", () => {
    assert.match(hosts, /did the environment's owner run this repo's seeder there\?/);
    assert.match(hosts, /`readiness\.environments`|each environment/);
    assert.match(hosts, /`accounts\.print` itself/);
    assert.match(hosts, /"no"[^.]*held/);
    assert.match(hosts, /never collects? role values|no role value is collected/);
  });

  it("never writes a host to the config, and a QA session never gets it any other way than its brief", () => {
    assert.match(hosts, /never written to (?:a|the) config/);
    assert.match(hosts, /only through its brief/);
  });

  it("is asked in the same message as the QA yes, never mid-run, never a Ruling", () => {
    assert.match(hosts, /never a mid-run Decision Request or a Ruling/);
  });

  it("step 9 holds a refused, missing or unconfirmed host's scenarios and never falls back to the typed route", () => {
    assert.match(STEP9, /refused|unconfirmed/);
    assert.match(STEP9, /never (?:falls back to|moves it to) the typed route|no typed route/);
  });

  it("the close-out deletes the hosts file and lists no host as saved", () => {
    assert.match(STEP10, /`qa-hosts\.json`/);
    assert.match(STEP10, /delete/i);
  });

  it("the Decision authority line says a url target runs from the brief too", () => {
    const line = STEP4.split("\n").find((l) => l.startsWith("Last, the **Decision authority** line"));
    assert.doesNotMatch(line, /a `url` target stays on the typed route/);
    assert.match(line, /`url`/);
  });
});

describe("the QA brief carries each host with its provenance (#421)", () => {
  it("names each host, its provenance line and the verdict", () => {
    assert.match(QA_BRIEF, /typed by the human in this run's Dispatch Plan, verdict hosted/);
    assert.match(QA_BRIEF, /`qa-hosts\.json`/);
  });

  it("says the host is never written to the config and the brief is the only route", () => {
    assert.match(QA_BRIEF, /never written to (?:a|the) config/);
  });

  it("a url target is on the brief route, and a refusal holds its scenarios", () => {
    assert.doesNotMatch(QA_BRIEF, /and for a `target: url` plan in any run/);
    assert.match(QA_BRIEF, /held, never typed|never moved to the typed route/);
  });

  it("the brief is deleted of its host at close-out: the run folder no longer holds it", () => {
    assert.match(QA_BRIEF, /deleted at close-out|close-out deletes/);
  });
});

describe("RUN.md keeps the host, and close-out deletes it (#421)", () => {
  it("the layout lists qa-hosts.json as approved-QA only, never in a config, deleted at close-out", () => {
    const line = RUN.split("\n").find((l) => /^\s*qa-hosts\.json/.test(l));
    assert.ok(line, "qa-hosts.json is in the layout");
    assert.match(line, /deleted at close-out/);
    assert.match(line, /never written to a config|never in a config/);
  });
});

describe("every harness file's check-before-use names the relayed host (#421)", () => {
  it("lists whether a QA session accepts a host relayed through its brief", () => {
    const dir = `${SKILL_DIR}/harnesses`;
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith(".md"))) {
      const text = read(`${dir}/${file}`);
      const check = section(text, "## Check before use");
      assert.match(
        check,
        /whether a QA session accepts a host relayed through its brief/i,
        `${file}: the host item`,
      );
    }
  });

  it("no harness file keeps a url target on the typed route", () => {
    const dir = `${SKILL_DIR}/harnesses`;
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith(".md"))) {
      const text = read(`${dir}/${file}`);
      assert.doesNotMatch(text, /with `go`, or a `url` target/, file);
      assert.doesNotMatch(text, /A `url` target stays on the typed route/, file);
    }
  });
});

describe("DESIGN.md, docs and the glossary give the typed-host flow (#421)", () => {
  it("DESIGN.md gives the reason: the person gives the host, not where they type it", () => {
    const why = section(DESIGN, "## QA asks nothing mid-run");
    assert.match(why, /typed in the Dispatch Plan/);
    assert.match(why, /seeder/);
    assert.match(why, /held, never typed|never falls back/);
  });

  it("docs/orchestrate.md says a url target runs from the brief, with hosts typed in the plan", () => {
    const doc = read("docs/orchestrate.md");
    assert.match(doc, /typed in the Dispatch Plan/);
    assert.doesNotMatch(doc, /a hosted \(`url`\) QA target's host and role values/);
    assert.doesNotMatch(doc, /on the typed route \(with `go`, or a `url` target\)/);
  });

  it("GLOSSARY.md defines the spec's new terms", () => {
    const g = read("GLOSSARY.md");
    for (const term of ["Parked QA session", "Host candidate", "Service", "Place"]) {
      assert.match(g, new RegExp(`^\\*\\*${term}\\*\\*:`, "m"), `${term} is defined`);
    }
  });

  it("CHANGELOG.md has one entry for spec #413, naming each ticket and both ADRs", () => {
    const log = read("CHANGELOG.md");
    const unreleased = log.slice(log.indexOf("## [Unreleased]"), log.indexOf("\n## [1."));
    const entry = unreleased.split("\n").find((l) => l.includes("/issues/413"));
    assert.ok(entry, "an entry links #413");
    for (const n of [415, 416, 417, 418, 419, 420, 421, 422]) {
      assert.ok(entry.includes(`/issues/${n}`), `#${n} is linked`);
    }
    assert.match(entry, /ADR 0032/);
    assert.match(entry, /ADR 0033/);
    assert.match(entry, /\*\*Consumer action:\*\*/);
    assert.match(entry, /`qa-plan` and `manual-qa` together/);
    assert.match(entry, /`report\.places`/);
    assert.match(entry, /`run\.hosts`/);
    assert.match(entry, /`run\.stack\.address`/);
    assert.match(entry, /composing the QA Plan only/);
  });
});
