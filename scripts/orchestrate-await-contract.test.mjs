/**
 * Contract test: an `orchestrate` Chief of Staff never waits on one signal
 * alone (issue #279). Every harness's `await` has a primary event and a
 * heartbeat that re-arms itself, a wake-up means "something may have
 * changed", and a Delegation's report says whether it is final. The skill is
 * prose, so these tests pin the sentences a run relies on; what a sentence
 * means is for review, and these only keep it from being dropped.
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
const BRIEF = read(`${SKILL_DIR}/BRIEF.md`);
const HARNESSES = read(`${SKILL_DIR}/HARNESSES.md`);
const DESIGN = read(`${SKILL_DIR}/DESIGN.md`);
const DESKTOP = read(`${SKILL_DIR}/harnesses/claude-code-desktop.md`);
const CLI = read(`${SKILL_DIR}/harnesses/claude-code-cli.md`);
const CURSOR = read(`${SKILL_DIR}/harnesses/cursor.md`);
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

/** The `- \`await\`:` bullet of a harness file's Verbs section, up to the next top-level bullet. */
function awaitBullet(text) {
  const verbs = section(text, "## Verbs");
  const start = verbs.search(/^- `await`:/m);
  assert.ok(start >= 0, "the Verbs section has an `await` bullet");
  const rest = verbs.slice(start);
  const end = rest.indexOf("\n- ");
  return end < 0 ? rest : rest.slice(0, end);
}

/** A report form: the fenced block whose first line starts with `heading`. */
function form(text, heading) {
  const blocks = [...text.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]);
  const block = blocks.find((b) => b.startsWith(heading));
  assert.ok(block, `a form starting ${heading} exists`);
  return block;
}

describe("await: an event plus a heartbeat", () => {
  it("HARNESSES.md says a wake-up means something may have changed, never that a report is final", () => {
    const waiting = section(HARNESSES, "## Waiting: an event and a heartbeat");
    assert.match(waiting, /primary event/);
    assert.match(waiting, /heartbeat/);
    assert.match(waiting, /"something may have changed", never "a report is final"/);
    assert.match(waiting, /every running Delegation/);
  });

  it("HARNESSES.md's verb table says `await` never waits on one signal alone", () => {
    const row = HARNESSES.split("\n").find((l) => l.startsWith("| `await`"));
    assert.match(row, /never on one signal alone/);
  });

  it("HARNESSES.md gives every harness without a scheduler the foreground watch, and tier 3 none", () => {
    const waiting = section(HARNESSES, "## Waiting: an event and a heartbeat");
    assert.match(waiting, /foreground watch/);
    assert.match(section(HARNESSES, "## Tiers"), /no heartbeat/);
  });

  it("DESIGN.md says why: a wake-up is a turn-end, not a finished report", () => {
    const why = section(DESIGN, "## Four verbs, three tiers");
    assert.match(why, /a turn-end, not a finished report/);
    assert.match(why, /heartbeat/);
  });
});

describe("SKILL.md: the heartbeat", () => {
  const step6 = section(SKILL, "### 6. Run the loop");

  it("step 6 arms it at the first `spawn`, records its id on the board, and deletes it at close-out or park", () => {
    assert.match(step6, /\*\*The heartbeat\.\*\*/);
    assert.match(step6, /first `spawn`/);
    assert.match(step6, /its id on the board/);
    assert.match(step6, /close-out/);
    assert.match(step6, /parks/);
    assert.match(step6, /`--resume`/);
  });

  it("step 6 says what each firing does", () => {
    for (const phrase of [
      "reads the board",
      "`report.md` and `decisions.md`",
      "the pull request's checks",
      "the review run",
      "re-arms any wait that ended or timed out",
      "logs one line",
    ])
      assert.ok(step6.includes(phrase), `step 6 says "${phrase}"`);
  });

  it("step 6 checks every running Delegation on each wake-up, not only the one quoted", () => {
    assert.match(step6, /every running Delegation, not only the one/);
  });

  it("step 7 verifies only a final report", () => {
    const step7 = section(SKILL, "### 7. Verify each report");
    assert.match(step7, /`\*\*Final:\*\* yes`/);
    assert.match(step7, /not sent back/);
  });

  it("step 10 deletes the heartbeat", () => {
    assert.match(section(SKILL, "### 10. Close out"), /heartbeat/);
  });
});

describe("RUN.md", () => {
  it("the board records the heartbeat", () => {
    // The board's example opens with a `# Run` heading inside its fence, which ends `section`.
    const board = RUN.slice(RUN.indexOf("\n## Board\n"), RUN.indexOf("\n## States\n"));
    assert.match(board, /^Heartbeat: </m);
    assert.match(board, /^The `Heartbeat` line/m);
  });

  it("`--resume` re-arms the heartbeat", () => {
    assert.match(section(RUN, "## Resume"), /heartbeat/);
  });
});

describe("BRIEF.md: a report says whether it is final", () => {
  it("item 8 says a Delegation never ends its turn while work its report depends on runs", () => {
    const item = section(BRIEF, "## The Brief Contract")
      .split("\n")
      .find((l) => l.startsWith("8. "));
    assert.match(item, /never ends its turn while work its report depends on is still running/);
    assert.match(item, /`\*\*Final:\*\* no, waiting on <what>`/);
  });

  it("the report form has the Final line", () => {
    assert.match(form(BRIEF, "### Report:"), /^\*\*Final:\*\* /m);
  });

  it("the QA report form has the Final line", () => {
    assert.match(form(BRIEF, "### QA report:"), /^\*\*Final:\*\* /m);
  });

  it("the QA brief carries the same rule", () => {
    const item = section(BRIEF, "## The QA brief")
      .split("\n")
      .find((l) => l.startsWith("8. "));
    assert.match(item, /\*\*Final:\*\*/);
  });
});

describe("harnesses/claude-code-desktop.md", () => {
  const wait = awaitBullet(DESKTOP);

  it("drops 'Never poll'", () => {
    assert.ok(!DESKTOP.includes("Never poll"));
  });

  it("`await` arms the app's wake-up, a `notify_when_idle` subscription and a `CronCreate` heartbeat", () => {
    assert.match(wait, /continues the idle Chief of Staff/);
    assert.match(wait, /`notify_when_idle`/);
    assert.match(wait, /`CronCreate`/);
    assert.match(wait, /`\*\/10 \* \* \* \*`/);
    assert.match(wait, /plain text/);
    assert.match(wait, /7 days/);
  });

  it("waits on CI or the review are capped background commands the heartbeat re-arms", () => {
    assert.match(wait, /capped background command/);
  });

  it("checks for held messages before the first `message`", () => {
    const msg = section(DESKTOP, "## Verbs")
      .split("\n")
      .find((l) => l.startsWith("- `message`:"));
    assert.match(msg, /held/);
    assert.match(msg, /Dispatch Plan/);
  });

  it("Limits name the sibling wait, the prompt stall and Keep computer awake", () => {
    const limits = section(DESKTOP, "## Limits");
    assert.match(limits, /sibling/);
    assert.match(limits, /permission prompt/);
    assert.match(limits, /\*\*Keep computer awake\*\*/);
  });

  it("check before use carries the research's unconfirmed desktop items", () => {
    const check = section(DESKTOP, "## Check before use");
    for (const phrase of [
      "every turn-end",
      "any sibling still working",
      "as its own turn ends",
      "in the background",
      "`notify_when_idle` reaches",
    ])
      assert.ok(check.includes(phrase), `check before use says "${phrase}"`);
  });
});

describe("harnesses/claude-code-cli.md", () => {
  it("`await` names the process's end and the `CronCreate` heartbeat", () => {
    const wait = awaitBullet(CLI);
    assert.match(wait, /`CronCreate`/);
  });
});

describe("harnesses/cursor.md", () => {
  const wait = awaitBullet(CURSOR);

  it("`await` is a foreground watch inside the turn, and never ends the turn while a Delegation runs", () => {
    assert.ok(!CURSOR.includes("Never poll"));
    assert.match(wait, /foreground watch/);
    assert.match(wait, /60 seconds/);
    assert.match(wait, /`~\/\.cursor\/subagents\/`/);
    assert.match(wait, /10 to 15 minute/);
    assert.match(wait, /never ends its turn while a Delegation runs/);
  });

  it("offers a `stop`-hook heartbeat as a persistent change", () => {
    assert.match(CURSOR, /`stop` hook/);
    assert.match(CURSOR, /persistent change/);
  });

  it("check before use carries the research's unconfirmed Cursor items", () => {
    const check = section(CURSOR, "## Check before use");
    assert.match(check, /background shell/);
    assert.match(check, /how long a foreground shell command/i);
    assert.match(check, /`stop` hook may wait/);
  });
});

describe("docs/orchestrate.md", () => {
  it("tells a Consumer about the heartbeat and Keep computer awake", () => {
    assert.match(DOCS, /heartbeat/);
    assert.match(DOCS, /\*\*Keep computer awake\*\*/);
  });
});
