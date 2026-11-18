/**
 * Contract test: in a `go autonomous` orchestrate run, QA runs from the brief,
 * and in every run the QA readiness question is asked once, in the Dispatch
 * Plan (issue #289, ADR 0013). The skill is prose, so these tests pin the
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

  it("in a go autonomous run on a url target, the QA Delegation takes the typed route and waits; the run goes on", () => {
    assert.match(starts, /`target: url`/);
    assert.match(starts, /typed route/);
    assert.match(starts, /`waiting`/);
    assert.match(starts, /the run goes on/);
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

  it("keeps the readiness answers and a hosted target's host and role values with the human", () => {
    const keeps = AUTONOMOUS.split("\n").find((l) => l.startsWith("- **The human keeps:**"));
    assert.match(keeps, /QA readiness answers/);
    assert.match(keeps, /`url`/);
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

describe("the ADR and the changelog", () => {
  const adrs = readdirSync(join(root, "docs/adr")).filter((f) => f.startsWith("0013-"));

  it("ADR 0013 says the QA skills run from the brief, with its why and considered options", () => {
    assert.equal(adrs.length, 1);
    const adr = read(`docs/adr/${adrs[0]}`);
    assert.match(adr, /^# In an autonomous orchestrate run, the QA skills run from the brief$/m);
    assert.match(adr, /## Considered options/i);
    assert.match(adr, /model-invocable/);
    assert.match(adr, /keep the human typing/i);
    assert.match(adr, /hosted/);
  });

  it("CHANGELOG.md's Unreleased section has the line", () => {
    const changelog = read("CHANGELOG.md");
    const unreleased = changelog.slice(
      changelog.indexOf("## [Unreleased]"),
      changelog.indexOf("\n## [", changelog.indexOf("## [Unreleased]") + 5),
    );
    assert.match(unreleased, /#289/);
  });
});
