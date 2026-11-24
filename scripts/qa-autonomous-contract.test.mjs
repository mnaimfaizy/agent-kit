/**
 * Contract test: each QA skill owns the mapping that lets an autonomous
 * orchestrate run follow it from a brief (issue #289; ADR 0013, superseded by the autonomous-QA
 * handover ADR). `qa-plan` and
 * `manual-qa` each carry a "Run from an autonomous brief" section with one row
 * per workflow step that waits on the person, saying what replaces the wait.
 *
 * A step waits on the person when its text asks them something, waits, acts
 * only on their yes, or lets them choose. The detector below finds those
 * phrases, so a step that gains one fails here until the section lists it.
 * What a row says is for review; this keeps a step from being left out.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const HEADING = "## Run from an autonomous brief";

/** Phrases that mean a step waits on the person. */
const WAITS =
  /\b(?:ask|asks)\s+(?:the|them|for|whether|which|before|about|that)\b|\bis asked\b|\bwaits?\b|\bon (?:a|their) yes\b|\bonly if they agree\b|\bthey choose\b/i;

/** The text of a `## ` section, from its heading to the next `## `. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Each `### <n>. <title>` step under `## Workflow`, with its text. */
function workflowSteps(text) {
  const steps = new Map();
  const parts = section(text, "## Workflow").split(/^### /m).slice(1);
  for (const part of parts) {
    const match = /^(\d+)\. /.exec(part);
    if (match) steps.set(Number(match[1]), part);
  }
  return steps;
}

/** The steps whose text waits on the person. */
function waitingSteps(text) {
  return [...workflowSteps(text)].filter(([, body]) => WAITS.test(body)).map(([n]) => n);
}

/** The step numbers the run section's table lists, in its first column. */
function listedSteps(text) {
  return section(text, HEADING)
    .split("\n")
    .map((line) => /^\|\s*(\d+)\s*\|/.exec(line))
    .filter(Boolean)
    .map((match) => Number(match[1]));
}

for (const skill of ["qa-plan", "manual-qa"]) {
  const SKILL = read(`.claude/skills/${skill}/SKILL.md`);

  describe(`${skill}: Run from an autonomous brief`, () => {
    it("has the section, before the workflow, so a brief's reader meets it first", () => {
      const at = SKILL.indexOf(`\n${HEADING}\n`);
      assert.ok(at >= 0, "the section exists");
      assert.ok(at < SKILL.indexOf("\n## Workflow\n"), "it comes before ## Workflow");
    });

    it("applies only when an orchestrate brief runs the skill, and keeps it user-invoked", () => {
      const text = section(SKILL, HEADING);
      assert.match(text, /orchestrate/);
      assert.match(text, /`go autonomous`/);
      assert.match(text, /invoked by a person/);
      assert.match(SKILL, /^disable-model-invocation: true$/m);
    });

    it("lists every workflow step that waits on the person", () => {
      const listed = new Set(listedSteps(SKILL));
      const missing = waitingSteps(SKILL).filter((n) => !listed.has(n));
      assert.deepEqual(missing, [], `steps that wait on the person but are not listed`);
    });

    it("lists only steps the workflow has", () => {
      const steps = workflowSteps(SKILL);
      for (const n of listedSteps(SKILL)) assert.ok(steps.has(n), `step ${n} exists`);
    });

    it("would fail if the skill gained a step that waits on the person", () => {
      const grown = SKILL.replace(
        "\n## Workflow\n",
        "\n## Workflow\n\n### 99. A new step\n\nAsk the person which one to use.\n",
      );
      assert.ok(waitingSteps(grown).includes(99));
      assert.ok(!listedSteps(grown).includes(99));
    });
  });
}

describe("qa-plan: what replaces each wait", () => {
  const SKILL = read(".claude/skills/qa-plan/SKILL.md");
  const text = section(SKILL, HEADING);
  const row = (n) => text.split("\n").find((line) => new RegExp(`^\\|\\s*${n}\\s*\\|`).test(line));

  it("takes the readiness answers from the --answers file, and never offers to save a config", () => {
    assert.match(row(2), /`--answers`/);
    assert.match(row(2), /never (?:offers|offer) to save/);
    assert.match(row(2), /never (?:a Ruling|rules)/);
  });

  it("makes the subject issue and an `unknown` row Rulings under the evidence bar, else the human's", () => {
    assert.match(row(3), /Ruling/);
    assert.match(row(3), /evidence bar/);
    assert.match(row(4), /`unknown`/);
    assert.match(row(4), /evidence bar/);
    assert.match(text, /`waiting`/);
  });

  it("turns 'Add the test' into a send-back Ruling, voids this QA, and commits nothing", () => {
    assert.match(row(4), /Add the test/);
    assert.match(row(4), /send-back Ruling/);
    assert.match(row(4), /building Delegation/);
    assert.match(row(4), /`void`/);
    assert.match(row(4), /commits nothing/);
  });

  it("delivers the QA Plan on a Ruling, with the reused-answers line", () => {
    assert.match(row(7), /Ruling/);
    assert.match(row(7), /answers\.reused/);
  });
});

describe("manual-qa: what replaces each wait", () => {
  const SKILL = read(".claude/skills/manual-qa/SKILL.md");
  const text = section(SKILL, HEADING);
  const row = (n) => text.split("\n").find((line) => new RegExp(`^\\|\\s*${n}\\s*\\|`).test(line));

  it("runs only a `stack` target from the brief: a `url` target stays typed by the human", () => {
    assert.match(text, /`target: stack`/);
    assert.match(text, /`url`/);
    assert.match(row(5), /typed/);
    assert.match(row(5), /`waiting`/);
  });

  it("uploads nothing: every QA Artifact stays local", () => {
    assert.match(row(10), /uploads nothing/);
    assert.match(row(10), /local/);
  });

  it("posts the QA Report only as a routine write the Dispatch Plan approved, else queues it", () => {
    assert.match(row(9), /routine/);
    assert.match(row(9), /Dispatch Plan/);
    assert.match(row(9), /queued write/);
  });
});

describe("qa-plan: --answers in the invocation", () => {
  const SKILL = read(".claude/skills/qa-plan/SKILL.md");

  it("puts --answers in the argument hint", () => {
    const hint = /^argument-hint: "(.+)"$/m.exec(SKILL)[1];
    assert.match(hint, /--answers <file>/);
  });

  it("step 2 runs check with --answers, asks only for what is left, and offers no save", () => {
    const step2 = workflowSteps(SKILL).get(2);
    assert.match(step2, /check --for plan --answers <file>/);
    assert.match(step2, /only for what/);
    assert.match(step2, /never offer to save a config/);
  });

  it("step 2 gives the --answers form before its Exit 1 bullet, so the bullets cover both forms", () => {
    const step2 = workflowSteps(SKILL).get(2);
    assert.ok(step2.indexOf("check --for plan --answers <file>") < step2.indexOf("- Exit 1:"));
  });

  it("step 2 always writes answers given in chat or a Decision Request to a file, save or not", () => {
    const step2 = workflowSteps(SKILL).get(2);
    assert.match(step2, /Always write the answers/);
  });

  it("docs/adopt.md names the autonomous exception on each QA skill's line", () => {
    const adopt = read("docs/adopt.md").split("\n");
    for (const skill of ["qa-plan", "manual-qa"]) {
      const line = adopt.find((l) => l.startsWith(`- \`.claude/skills/${skill}/\``));
      assert.match(line, /`go autonomous`/, skill);
    }
  });

  it("docs/qa.md says an autonomous orchestrate run follows the skills from a brief", () => {
    const intro = read("docs/qa.md")
      .split("\n")
      .find((l) => l.startsWith("Both skills are User-scope"));
    assert.match(intro, /`go autonomous`/);
  });

  it("step 4 passes the same file to two-point.mjs, and step 7 shows the reused-answers line", () => {
    assert.match(workflowSteps(SKILL).get(4), /`--answers` file/);
    const step7 = workflowSteps(SKILL).get(7);
    assert.match(step7, /Readiness answers reused from <file>: <values>/);
  });
});
