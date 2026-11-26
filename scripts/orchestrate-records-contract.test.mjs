/**
 * Contract test: an `orchestrate` run writes Run Events as it goes and, at
 * close-out, derives a Run Record from them (issue #423, spec #414). The
 * skill is prose, so these tests pin the sentences a run relies on: when the
 * Chief of Staff and each Delegation write each event, what a human step is,
 * the cause list, and the close-out derive. What a sentence means is for
 * review, and these only keep it from being dropped. The script itself is
 * tested in `.claude/skills/orchestrate/records.test.mjs`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PRUNE_KEYS,
  RAW_KEYS,
  RAW_SINK_TYPES,
  RECORDS_KEYS,
  RECORDS_UPLOADS,
  SECTIONS,
  SINK_TYPES,
} from "../.claude/skills/orchestrate/config.mjs";
import { COLUMNS } from "../.claude/skills/orchestrate/pages/board.mjs";
import {
  ACTORS,
  CAUSES,
  EVENT_KINDS,
  STEP_KINDS,
  eventFlags,
} from "../.claude/skills/orchestrate/records.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const SKILL_DIR = ".claude/skills/orchestrate";
const SKILL = read(`${SKILL_DIR}/SKILL.md`);
const RUN = read(`${SKILL_DIR}/RUN.md`);
const BRIEF = read(`${SKILL_DIR}/BRIEF.md`);
const DESIGN = read(`${SKILL_DIR}/DESIGN.md`);
const DOCS = read("docs/orchestrate.md");

/** The text of a heading's section, up to the next heading of the same depth or higher. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const depth = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${depth}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

const flat = (text) => text.replace(/\s+/g, " ");

describe("RUN.md: the events files and the Run Record", () => {
  const records = section(RUN, "## Run Events and the Run Record");

  it("lays out an events file for the Chief of Staff and one per Delegation, and the record outside the run folder", () => {
    const layout = section(RUN, "## Layout");
    assert.match(layout, /^ {2}events\.jsonl {2,}the Chief of Staff's Run Events/m);
    assert.match(layout, /^ {4}events\.jsonl {2,}the Delegation's own Run Events/m);
    assert.match(
      flat(layout),
      /The Run Record is not in the run folder\. It is derived at close-out into `<run_dir>\/records\/<run-id>\.json`/,
    );
  });

  it("says every step is a Run Event written as it happens, only through the records script, with the time from the clock", () => {
    const text = flat(records);
    assert.match(text, /Every step of a run is written as a \*\*Run Event\*\*, as it happens/);
    assert.match(
      text,
      /`events\.jsonl` for the Chief of Staff and one `delegations\/<id>\/events\.jsonl` for each Delegation/,
    );
    assert.match(
      text,
      /written only with the records script, never by hand\. It takes the time from the clock/,
    );
    assert.match(text, /node "<skill>\/records\.mjs" event --file/);
    assert.match(text, /A value is an enum, a number, a SHA or an id: never a sentence/);
  });

  it("says every event carries an actor of human, chief-of-staff or delegation", () => {
    const text = flat(records);
    assert.match(text, /Every event carries an `actor`: `human`, `chief-of-staff` or `delegation`/);
  });

  it("names every event kind the script takes, and no other", () => {
    const named = [...records.matchAll(/^\| `([a-z-]+)`(?:, `([a-z-]+)`)?/gm)].flatMap((m) => [
      m[1],
      m[2],
    ]);
    const kinds = named.filter((k) => k && !Object.hasOwn(CAUSES, k));
    assert.deepEqual([...new Set(kinds)].sort(), Object.keys(EVENT_KINDS).sort());
  });

  it("defines a human step as one touch listing the Decision Requests it covered, and a wait by its open and close", () => {
    const text = flat(records);
    assert.match(
      text,
      /\*\*A human step is one touch\*\* from the human: one answer, click or typed command, and it lists every Decision Request it covered/,
    );
    assert.match(
      text,
      /A wait has a `wait-opened` and a `wait-closed` sharing one `wait-id`, and the close is the touch the Run Record counts/,
    );
    assert.match(
      text,
      /A card start the harness refused opens a wait with cause `harness-limit` and the card's id/,
    );
    assert.match(
      text,
      /A ticket parked on a teammate's ticket opens a `teammate-blocker` wait carrying the blocker ticket and the teammate's login/,
    );
  });

  it("lists each cause with whether it is avoidable or by design, matching the script", () => {
    const rows = [...records.matchAll(/^\| `([a-z-]+)` +\| (avoidable|by design) /gm)];
    assert.deepEqual(Object.fromEntries(rows.map((m) => [m[1], m[2].replace(" ", "-")])), CAUSES);
    assert.match(flat(records), /The plan's approval and the close-out are always `by-design`/);
  });

  it("names the step kinds the cause rows rely on", () => {
    for (const kind of ["plan-approval", "card-start", "merge", "close-out", "teammate-blocker"])
      assert.ok(STEP_KINDS.includes(kind), kind);
  });

  it("says the record is derived at close-out into the records folder, holds no free text, and the safe-field check errors and never strips", () => {
    const text = flat(records);
    assert.match(text, /node "<skill>\/records\.mjs" derive <run_dir>\/<run>/);
    assert.match(text, /writes `<run_dir>\/records\/<run-id>\.json`/);
    assert.match(
      text,
      /It never holds issue text, ticket titles, commit messages, command output, file contents or a reason in words/,
    );
    assert.match(
      text,
      /A \*\*safe-field check\*\* runs on every derive: a field outside the schema, or a value that is free text, is an error that names the field, and nothing is written\. It never strips/,
    );
  });

  it("says where the operator and the repository come from, and that there is no backfill", () => {
    const text = flat(records);
    assert.match(
      text,
      /`run\.operator` is the login of the tracker CLI \(`gh api user`, or `glab api user`\), and only `ORCHESTRATE_OPERATOR` overrides it/,
    );
    assert.match(text, /there is no backfill/);
  });

  it("never names run.team_run, which a Team Run replaces with team and spec", () => {
    for (const text of [SKILL, RUN, BRIEF, DESIGN, DOCS]) assert.doesNotMatch(text, /team_run/);
  });
});

describe("SKILL.md: when the Chief of Staff writes each event", () => {
  it("makes every step a Run Event, and keeps the Activity Log as the prose", () => {
    const rules = flat(section(SKILL, "## Rules"));
    assert.match(
      rules,
      /\*\*Every step is a Run Event\.\*\* The Chief of Staff and each Delegation write a timestamped Run Event for each step as it happens/,
    );
    assert.match(
      rules,
      /A Run Record holds no free text\. The Activity Log stays as the readable prose/,
    );
  });

  it("step 2 opens the events file with run-opened", () => {
    const step = flat(section(SKILL, "### 2. Open the run"));
    assert.match(
      step,
      /write the run's first Run Event, `run-opened`, to the Chief of Staff's `events\.jsonl`/,
    );
    assert.match(step, /never afterwards from memory: the time comes from the clock/);
  });

  it("step 4 writes the plan's approval as a wait and the go as one touch", () => {
    const step = flat(section(SKILL, "### 4. Show the Dispatch Plan"));
    assert.match(
      step,
      /write `wait-opened` \(step kind `plan-approval`, cause `by-design`, how `chat`\)/,
    );
    assert.match(
      step,
      /The human's "go" is one touch: write `wait-closed` with actor `human`, covering those Decision Requests, then `plan-approved`/,
    );
  });

  it("step 5 has the Delegation write its own start and end, and a refused card start opens a harness-limit wait", () => {
    const step = flat(section(SKILL, "### 5. Dispatch a wave"));
    assert.match(
      step,
      /The Delegation writes them, so its start and end are the times it really started and ended/,
    );
    assert.match(
      step,
      /opens a `wait-opened` with cause `harness-limit`, how `card` and the card's id/,
    );
  });

  it("step 6 writes each loop event, with the actor who did it", () => {
    const step = flat(section(SKILL, "### 6. Run the loop"));
    assert.match(
      step,
      /\*\*Run Events in the loop\.\*\* Each event above is also written as a Run Event, with the actor who did it/,
    );
    for (const kind of [
      "decision-request",
      "wait-opened",
      "ruling-made",
      "ruling-verdict",
      "send-back",
      "write",
      "review",
      "ci",
      "teammate-blocker",
    ])
      assert.ok(step.includes(`\`${kind}\``), kind);
    assert.match(
      step,
      /each write made in the human's name is a `write` with `as-human` true and actor `chief-of-staff`/,
    );
  });

  it("step 10 derives the Run Record at close-out, outside the run folder, with or without a records config", () => {
    const step = flat(section(SKILL, "### 10. Close out"));
    assert.match(step, /\*\*Derive the Run Record\.\*\*/);
    assert.match(step, /last `run-closed` with the run's outcome/);
    assert.match(step, /node "<skill>\/records\.mjs" derive "<run_dir>\/<run>"/);
    assert.match(
      step,
      /It writes `<run_dir>\/records\/<run-id>\.json`, outside the run folder, so pruning or deleting the folder leaves it/,
    );
    assert.match(
      step,
      /The record is local only, and every run writes it, with or without any `records` config/,
    );
  });
});

describe("BRIEF.md: when each Delegation writes its events", () => {
  const item = flat(section(BRIEF, "## The Brief Contract"));

  it("gives the Delegation its events file and its commands, pre-filled", () => {
    assert.match(
      item,
      /its \*\*events file\*\*, `events\.jsonl` beside them, as an absolute path too, and the `records\.mjs event` commands/,
    );
    assert.match(item, /Executor kind, model and start route/);
  });

  it("says when each of its events is written, with actor delegation and no time of its own", () => {
    assert.match(
      item,
      /with `--actor delegation`, never afterwards and never with a time of its own/,
    );
    assert.match(item, /`delegation-started` as its very first act, before it reads anything/);
    assert.match(item, /`delegation-landed` each time it pushes work it reports as landed/);
    assert.match(
      item,
      /`delegation-ended` as the last thing it does, once its final report says `\*\*Final:\*\* yes`/,
    );
    assert.match(item, /A Run Event holds ids, numbers and enum values and never a sentence/);
    assert.match(
      item,
      /A Delegation never writes the Chief of Staff's events file or another Delegation's/,
    );
  });
});

describe("RUN.md's event table names each kind's field flags, as `event` takes them (C19)", () => {
  it("has a Flags cell per kind equal to the schema's flags", () => {
    const rows = new Map(
      RUN.split("\n")
        .filter((l) => /^\| `[a-z-]+` +\|/.test(l))
        .map((l) => l.split("|").map((c) => c.trim()))
        .map((cells) => [cells[1].replaceAll("`", ""), cells.at(-2)]),
    );
    for (const kind of Object.keys(EVENT_KINDS)) {
      const expected =
        eventFlags(kind)
          .map((f) => `\`${f}\``)
          .join(" ") || "none";
      assert.equal(rows.get(kind), expected, kind);
    }
  });
});

/** GitHub's anchor for each heading of a Markdown file, code blocks left out. */
const anchors = (text) =>
  new Set(
    text
      .replace(/^```[\s\S]*?^```/gm, "")
      .split("\n")
      .filter((l) => /^#{1,6} /.test(l))
      .map((l) =>
        l
          .replace(/^#+ /, "")
          .toLowerCase()
          .replace(/[^\w\- ]/g, "")
          .replaceAll(" ", "-"),
      ),
  );

describe("docs/orchestrate.md's lists match the code's constants (C23)", () => {
  /** `a`, `b` or `c`, as the docs write a closed list. */
  const words = (list, quote = (w) => `\`${w}\``, last = "or") =>
    list.length === 1
      ? quote(list[0])
      : `${list.slice(0, -1).map(quote).join(", ")} ${last} ${quote(list.at(-1))}`;
  const row = (key) => {
    const line = DOCS.split("\n").find((l) => l.startsWith(`| \`${key}\` `));
    assert.ok(line, key);
    return line;
  };

  it("names the board's columns as pages/board.mjs's COLUMNS", () => {
    assert.ok(DOCS.includes(`- **Kanban.** ${words(COLUMNS, (w) => w, "and")}.`));
  });

  it("names the actors as records.mjs's ACTORS", () => {
    assert.ok(DOCS.includes(`and an \`actor\`: ${words(ACTORS)}.`));
  });

  it("gives the `records` and `prune` rows the keys and values config.mjs takes", () => {
    const records = row("records");
    for (const key of RECORDS_KEYS.filter((k) => k !== "raw"))
      assert.match(records, new RegExp(`\`${key}\`: `), key);
    assert.ok(
      records.includes(
        `\`upload\`: \`${RECORDS_UPLOADS[0]}\` (default) or ${words(RECORDS_UPLOADS.slice(1))}`,
      ),
    );
    assert.ok(records.includes(`\`type: ${SINK_TYPES[0]}\`, ${words(SINK_TYPES.slice(1))}`));
    const raw = row("records.raw");
    for (const key of RAW_KEYS) assert.match(raw, new RegExp(`\`${key}\`: `), key);
    assert.ok(raw.includes(`${words(RAW_SINK_TYPES.map((t) => `type: ${t}`))} only`));
    const prune = row("prune");
    for (const key of PRUNE_KEYS) assert.match(prune, new RegExp(`\`${key}\`: `), key);
  });
});

describe("SINKS.md's operations are the closed list each sink file has (C28)", () => {
  const SINKS = read(`${SKILL_DIR}/SINKS.md`);
  const ops = [...SINKS.matchAll(/^\| `([a-z]+)` +\| (read|write) +\|(.*)\|$/gm)].map((m) => ({
    op: m[1],
    s3Only: /^\s*`s3` only/.test(m[3]),
  }));

  it("lists lifecycle as an `s3`-only operation, and the file-format rule says so", () => {
    assert.deepEqual(
      ops.map((o) => o.op),
      ["visibility", "access", "read", "create", "list", "lifecycle"],
    );
    assert.deepEqual(
      ops.filter((o) => o.s3Only).map((o) => o.op),
      ["lifecycle"],
    );
    assert.match(
      flat(SINKS),
      /and only these: the first five on every sink, and `lifecycle` on an `s3` sink alone/,
    );
    assert.match(
      flat(SINKS),
      /a `###` section for each operation above that the sink has \(`lifecycle` in `sinks\/s3\.md` alone\)/,
    );
  });

  it("each sink file has a section for each operation it has, and no other", () => {
    for (const sink of ["github", "gitlab", "s3"]) {
      const text = read(`${SKILL_DIR}/sinks/${sink}.md`);
      const headed = [...text.matchAll(/^### `([a-z]+)`$/gm)].map((m) => m[1]);
      const expected = ops.filter((o) => sink === "s3" || !o.s3Only).map((o) => o.op);
      assert.deepEqual(headed, expected, sink);
    }
  });
});

describe("DESIGN.md and HARNESSES.md stand alone (C24, C29)", () => {
  it("DESIGN.md names a Stage's record as a later schema, with no ADR number", () => {
    assert.match(flat(DESIGN), /a Stage's record is a later schema\./);
    assert.doesNotMatch(DESIGN, /ADR 0036|Factory Stage/);
  });

  it("HARNESSES.md moves a sink's Support Level up the way it moves a harness's or a tracker's", () => {
    assert.match(
      flat(read(`${SKILL_DIR}/HARNESSES.md`)),
      /the change to the harness, tracker or sink file cites that run/,
    );
  });
});

describe("CONFIG.md: its key sections and its links (C20, C21)", () => {
  const CONFIG = read(`${SKILL_DIR}/CONFIG.md`);

  it("every link into RUN.md, SKILL.md or CONFIG.md itself names a heading that exists", () => {
    const files = { "RUN.md": RUN, "SKILL.md": SKILL, "": CONFIG, "CONFIG.md": CONFIG };
    const links = [...CONFIG.matchAll(/\]\(((?:RUN|SKILL|CONFIG)\.md)?#([^)]+)\)/g)];
    assert.ok(links.length > 5);
    for (const [, file = "", anchor] of links)
      assert.ok(anchors(files[file]).has(anchor), `${file}#${anchor}`);
  });

  it("documents `records` and `prune` under `## Keys`, last, in the order of config.mjs's SECTIONS", () => {
    const keys = section(CONFIG, "## Keys");
    const headed = [...keys.matchAll(/^### `([a-z_]+)`$/gm)].map((m) => m[1]);
    const order = Object.keys(SECTIONS);
    assert.deepEqual(headed.slice(-3), order.slice(-3));
    assert.deepEqual(order.slice(-2), ["records", "prune"]);
    assert.doesNotMatch(section(CONFIG, "## Readiness check"), /^### `prune`/m);
  });
});

describe("one writer for `decision-request`: the Chief of Staff, as it queues the request (C8)", () => {
  it("says so alike in BRIEF.md, SKILL.md and RUN.md", () => {
    const brief = flat(section(BRIEF, "## The Brief Contract"));
    assert.match(
      brief,
      /It writes no `decision-request`: when it raises a Decision Request, the Chief of Staff writes that event as it queues the request, with the next run-wide id `dr<n>`/,
    );
    assert.doesNotMatch(brief, /`dr<n>` the brief gives it/);
    const loop = flat(section(SKILL, "### 6. Run the loop"));
    assert.match(
      loop,
      /a Decision Request queued, the run's own or a Delegation's, is `decision-request`, which only the Chief of Staff writes, with the next run-wide id `dr<n>` \(a Delegation writes none\)/,
    );
    const row = RUN.split("\n").find((l) => l.startsWith("| `decision-request`"));
    assert.match(row, /^\| `decision-request`\s+\| Chief of Staff\s+\|/);
    assert.match(row, /A Delegation writes none/);
    assert.doesNotMatch(RUN, /whoever raises it/);
  });
});

describe("DESIGN.md and the docs page say what a run now writes, and why", () => {
  it("DESIGN.md has a Run Events and the Run Record section giving the reasons", () => {
    const text = flat(section(DESIGN, "## Run Events and the Run Record"));
    assert.match(text, /A human step is one touch, listing the Decision Requests it covered/);
    assert.match(text, /Every write carries an `actor`/);
    assert.match(
      text,
      /a field outside the schema is an error that names it, never silently stripped/,
    );
    assert.match(text, /written to `<run_dir>\/records\/`, beside the run folders and not in one/);
    assert.match(
      text,
      /Records start with the first run that writes events: a backfill would be built on guesses/,
    );
  });

  it("docs/orchestrate.md says what the run writes and that a run with no records config is unchanged apart from it", () => {
    const text = flat(section(DOCS, "### Run Events and the Run Record"));
    assert.match(text, /a run writes a structured \*\*Run Event\*\* for each step as it happens/);
    assert.match(
      text,
      /`<run_dir>\/records\/<run-id>\.json`, beside the run folders and not inside one, so pruning or deleting a run folder leaves it/,
    );
    assert.match(text, /it errors, and never strips/);
    assert.match(text, /a run with no `records` config behaves as before apart from it/);
    assert.match(text, /there is no backfill/);
  });
});

describe("waits and Ruling events: when each is written", () => {
  const TEAM = read(`${SKILL_DIR}/TEAM.md`);

  it("RUN.md says what a wait must carry, and that a wait never closed is reported open", () => {
    const text = flat(section(RUN, "## Run Events and the Run Record"));
    assert.match(
      text,
      /A `harness-limit` wait must name its `card`, and a `teammate-blocker` wait its blocker ticket and the teammate's login/,
    );
    assert.match(text, /derive reports it as still open, by id and step kind/);
    assert.match(text, /A cause that is by design is never counted as avoidable/);
    assert.match(text, /the record's `rulings` counts them \(`made`, `upheld`, `overturned`\)/);
  });

  it("SKILL.md writes ruling-made when a Ruling is sent and ruling-verdict at the Ruling Review", () => {
    const text = flat(SKILL);
    assert.match(
      text,
      /Write `ruling-made` \(the Ruling's `R<n>` and the Delegation it was sent to\)/,
    );
    assert.match(
      text,
      /Each verdict is a `ruling-verdict`, written with actor `human` for each Ruling the answer names/,
    );
    assert.match(
      text,
      /a wait that belongs to the run and not a Delegation \(the review label, posting replies, the merge\) is a `wait-opened` with no `delegation`/,
    );
  });

  it("BRIEF.md says the Chief of Staff writes the Ruling events and a Delegation opens no wait on the human", () => {
    assert.match(
      flat(section(BRIEF, "## Ruling")),
      /writes `ruling-made` when it sends the Ruling and `ruling-verdict` at the Ruling Review; the Delegation writes neither, and a wait on the human is never its to open/,
    );
  });

  it("TEAM.md opens a teammate-blocker wait when a ticket is parked and closes it at the wake-up that sees the blocker merged", () => {
    const text = flat(TEAM);
    assert.match(
      text,
      /Parking the ticket writes a `wait-opened` for each blocker that is another teammate's ticket, with step kind and cause `teammate-blocker` \(by design, never avoidable\), how `github`, the blocker ticket \(`--blocker`\), the teammate's login \(`--blocker-login`\)/,
    );
    assert.match(
      text,
      /the Chief of Staff writes the `wait-closed` with the same `wait-id` at the wake-up that found it/,
    );
  });

  it("docs/orchestrate.md names the waits and the Rulings counts", () => {
    const text = flat(section(DOCS, "### Run Events and the Run Record"));
    assert.match(text, /A wait that belongs to the run, such as plan approval, the review label/);
    assert.match(
      text,
      /a by-design `teammate-blocker` wait with the blocker ticket and the teammate's login/,
    );
    assert.match(text, /A wait never closed is reported as open at close-out/);
  });
});

// ── Upload to a private sink (issue #425) ───────────────────────────────────

const APPROVED_DISCLOSURE =
  "**Upload this run's Run Record?** To `acme/run-records` (private GitHub repository, 4 people with access) at `records/github.com/acme/widgets/naim/2026-11-19-spec-344.json`. It holds counts, ids, times, outcomes and 23 human steps with their kind and cause: no issue text, no command output, no prose. It is kept indefinitely (git cannot expire it). [Show the record] [Upload] [Not now]";

describe("uploading the Run Record to a sink", () => {
  const uploading = flat(section(RUN, "### Uploading the Run Record"));

  it("RUN.md carries the approved disclosure wording, word for word", () => {
    assert.ok(
      uploading.includes(`> ${APPROVED_DISCLOSURE}`),
      "the disclosure's record line is the approved wording",
    );
  });

  it("docs/orchestrate.md carries the same wording", () => {
    assert.ok(flat(DOCS).includes(`> ${APPROVED_DISCLOSURE}`));
  });

  it("leaves the access count out when it cannot be read, and never rewords the line", () => {
    assert.match(
      uploading,
      /The count of people with access is left out when the [Ss]ink cannot be read for it\./,
    );
    assert.match(uploading, /The words are the script's; never reword them\./);
  });

  it("answers the three buttons: show the record, upload, and Not now leaves the local record for `--upload <run>`", () => {
    assert.match(uploading, /\*\*\[Show the record\]:\*\* print the file the output names/);
    assert.match(uploading, /\*\*\[Upload\]:\*\* run the `--yes` form/);
    assert.match(
      uploading,
      /\*\*\[Not now\]:\*\* do nothing more\. The record stays in `<run_dir>\/records\/`, and the human can run `--upload <run>` later\./,
    );
  });

  it("makes 'upload the Run Record' a routine write the Dispatch Plan may list, approved once at go", () => {
    assert.match(
      uploading,
      /The Dispatch Plan may list "upload the Run Record" among the kinds of routine write, when the config sets a `records\.sink`\. Approved with the plan's "go", the close-out runs the `--yes` form without asking again/,
    );
    assert.match(flat(SKILL), /\*\*uploading the Run Record\*\* at close-out/);
  });

  it("SKILL.md admits `--upload <run>` in its invocation list, hint and grammar", () => {
    assert.match(SKILL, /argument-hint: ".*\| --upload <run> \|.*"/);
    assert.match(
      flat(SKILL),
      /- `\/orchestrate --upload <run>`: upload a closed run's Run Record to the sink the config's `records\.sink` names, after showing the disclosure/,
    );
    assert.match(
      flat(SKILL),
      /`--upload <run>` takes exactly one run name and nothing else, and `--upload` comes first\./,
    );
  });

  it("makes the close-out offer the upload after the derive, and only with a sink", () => {
    const text = flat(section(SKILL, "### 10. Close out"));
    assert.match(
      text,
      /With a `records\.sink` and `records\.upload` not `never`, then \*\*upload it\*\* as \[RUN\.md\]\(RUN\.md#uploading-the-run-record\) says: show the disclosure, and upload on the human's "Upload", or without asking when the Dispatch Plan's routine write "upload the Run Record" was approved\. Without a `records\.sink`, the record stays local and nothing is offered\./,
    );
  });

  it("lists what stops an upload, and gives no override", () => {
    assert.match(
      uploading,
      /the [Ss]ink is not private, or its visibility cannot be read: there is no override/,
    );
    assert.match(uploading, /different bytes are already at the path: nothing is overwritten/);
    assert.match(uploading, /exit code `3`: the repository cannot be told/);
  });

  it("the sink file states the writer's access, and mirrors the tracker files", () => {
    const sink = flat(read(`${SKILL_DIR}/sinks/github.md`));
    assert.match(sink, /^# GitHub - \*\*Id:\*\* `github` - \*\*Support Level:\*\* `verified`/);
    assert.match(sink, /- \*\*Facts from:\*\*/);
    assert.match(sink, /\*\*The writer\*\* needs \*\*Contents: write\*\* on the sink repository/);
    for (const op of ["visibility", "access", "read", "create", "list"])
      assert.match(sink, new RegExp(`### \`${op}\``), op);
    assert.match(sink, /## Check before use/);
    const index = flat(read(`${SKILL_DIR}/SINKS.md`));
    for (const op of ["visibility", "access", "read", "create", "list"])
      assert.match(index, new RegExp(`\\| \`${op}\``), op);
  });

  it("the gitlab sink file mirrors the github one: both accesses, every operation, and Support Level `documented`", () => {
    const sink = flat(read(`${SKILL_DIR}/sinks/gitlab.md`));
    assert.match(
      sink,
      /^# GitLab - \*\*Id:\*\* `gitlab` - \*\*Support Level:\*\* `documented`\. No run has uploaded/,
    );
    assert.match(sink, /- \*\*Facts from:\*\*/);
    assert.match(sink, /\*\*The writer\*\* needs the \*\*Developer\*\* role/);
    assert.match(sink, /\*\*The reader\*\* \(the dashboard\) needs the \*\*Reporter\*\* role/);
    for (const op of ["visibility", "access", "read", "create", "list"])
      assert.match(sink, new RegExp(`### \`${op}\``), op);
    assert.match(sink, /## Check before use/);
    assert.match(sink, /GitLab does not document a create-only write, so the path is read first/);
    assert.match(sink, /`internal` and `public` are refused/);
  });

  it("the s3 sink file mirrors the others: both accesses, every operation, Other storage, and moving a sink", () => {
    const sink = flat(read(`${SKILL_DIR}/sinks/s3.md`));
    assert.match(
      sink,
      /^# S3 - \*\*Id:\*\* `s3` - \*\*Support Level:\*\* `documented`\. No run has uploaded/,
    );
    assert.match(sink, /- \*\*Facts from:\*\*/);
    assert.match(
      sink,
      /\*\*The writer\*\* needs `s3:PutObject` and `s3:GetObject` on `records\/\*`/,
    );
    assert.match(
      sink,
      /\*\*The reader\*\* \(the dashboard\) needs `s3:ListBucket` and `s3:GetObject` on `records\/`/,
    );
    assert.match(sink, /ORCHESTRATE_S3_ACCESS_KEY_ID` and `ORCHESTRATE_S3_SECRET_ACCESS_KEY`/);
    for (const op of ["visibility", "access", "read", "create", "list"])
      assert.match(sink, new RegExp(`### \`${op}\``), op);
    assert.match(sink, /## Check before use/);
    assert.match(sink, /`ListObjectsV2`, paginated/);
    assert.match(sink, /retried once with the current repository's prefix/);
    assert.match(sink, /## Other storage/);
    for (const name of [
      "AWS S3",
      "Cloudflare R2",
      "Google Cloud Storage with HMAC keys",
      "Backblaze B2",
      "MinIO",
      "Wasabi",
      "DigitalOcean Spaces",
    ])
      assert.match(sink, new RegExp(`\\*\\*${name}\\*\\*: \\[`), name);
    assert.match(sink, /untested hints/);
    assert.match(sink, /Not sinks today:\*\* Azure Blob.*Bitbucket.*Gitea and Forgejo/);
    assert.match(
      sink,
      /## Moving to a new sink\s+Copy `records\/` to the new sink under the same paths/,
    );
  });

  it("SINKS.md lists the s3 sink, and CONFIG.md, the example and the docs name it", () => {
    assert.match(
      flat(read(`${SKILL_DIR}/SINKS.md`)),
      /\| `s3` \| `documented` \| \[sinks\/s3\.md\]/,
    );
    const config = flat(read(`${SKILL_DIR}/CONFIG.md`));
    assert.match(config, /`s3`: any S3-compatible bucket, signed with SigV4/);
    for (const key of ["endpoint", "bucket", "region"])
      assert.match(config, new RegExp(`\\| \`${key}\` +\\| none: required for \`s3\``), key);
    assert.match(flat(DESIGN), /The `s3` sink is any S3-compatible bucket, signed with SigV4/);
  });

  it("SINKS.md lists the gitlab sink and says where its Support Level is read", () => {
    const index = flat(read(`${SKILL_DIR}/SINKS.md`));
    assert.match(index, /\| `github` \| `verified` \|/);
    assert.match(index, /\| `gitlab` \| `documented` \|/);
    assert.match(
      index,
      /A sink's Support Level is the one its own file states, and the Dispatch Plan and the disclosure name it while it is below `verified` \(\[RUN\.md\]\(RUN\.md#uploading-the-run-record\)\): `github` is `verified`, while `gitlab` and `s3` ship at `documented` until a run has uploaded to them/,
    );
  });

  it("RUN.md and SKILL.md have the Dispatch Plan and the close-out say the sink's Support Level", () => {
    const run = flat(read(`${SKILL_DIR}/RUN.md`));
    assert.match(
      run,
      /When the [Ss]ink's file states a Support Level below `verified` \(`gitlab` and `s3` ship at `documented`; `github` is `verified`\), the Dispatch Plan says so beside "upload the Run Record", and the close-out repeats it after the disclosure/,
    );
    assert.match(flat(SKILL), /the sink's Support Level \(\[SINKS\.md\]\(SINKS\.md\)\)/);
    assert.match(
      flat(DESIGN),
      /`github` is `verified`, while `gitlab` and `s3` ship at Support Level `documented`/,
    );
  });

  it("CONFIG.md documents the records keys, and the path and login rules", () => {
    const config = flat(read(`${SKILL_DIR}/CONFIG.md`));
    assert.match(
      config,
      /A record's path in the [Ss]ink is `records\/<host>\/<owner>\/<repo>\/<login>\/<run-id>\.json`, every segment lowercased/,
    );
    assert.match(
      config,
      /overridable only by the `ORCHESTRATE_OPERATOR` environment variable, and with none, nothing uploads/,
    );
  });
});

describe("pruning closed-out run folders, on opt-in", () => {
  it("makes the close-out prune only with the key, never records/ or an open run", () => {
    const text = flat(section(SKILL, "### 10. Close out"));
    assert.match(
      text,
      /With `prune\.after_days` set in the config, run `node "<skill>\/records\.mjs" prune` once the record is derived: it deletes the closed-out run folders older than that many days, never `records\/` and never an open run/,
    );
  });

  it("asks once with no key, writes the key only on a yes, and does not ask again after a no", () => {
    const text = flat(section(SKILL, "### 10. Close out"));
    assert.match(
      text,
      /With no `prune` key, ask once whether to prune at 90 days, and write `prune\.after_days: 90` into the config only on a yes\. On a no, run `node "<skill>\/records\.mjs" prune --declined` and write nothing to the config: a "no" is not asked again\. Do not ask when the `prune` key is there, or when `<run_dir>\/prune-declined` is\./,
    );
    const run = flat(section(RUN, "### Pruning old run folders"));
    assert.match(run, /The key is written only on a yes\./);
    assert.match(run, /A bad config, or no `prune` key, deletes nothing\./);
    assert.match(run, /`<run_dir>\/records\/`, and every record in it, always stays/);
  });

  it("CONFIG.md, the docs page and DESIGN.md say what prune.after_days does", () => {
    const config = flat(read(`${SKILL_DIR}/CONFIG.md`));
    assert.match(config, /### `prune`/);
    assert.match(config, /Setting it is the consent to delete\./);
    assert.match(
      config,
      /With no `prune` key, the close-out asks once whether to prune at 90 days, and writes `prune\.after_days: 90` into the config only on a yes\./,
    );
    const docs = flat(DOCS);
    assert.match(docs, /Local pruning is \*\*off\*\* until you set `prune\.after_days`/);
    assert.match(docs, /\| `prune` \| `after_days`/);
    assert.match(
      flat(DESIGN),
      /Pruning local run folders is opt-in and is the one setting that deletes data/,
    );
  });
});

// ── Raw run folders to an expiring bucket (issue #431) ──────────────────────

const APPROVED_RAW_LINE =
  "**Also upload the raw run folder?** 37 files, 1.8 MB, to bucket `acme-run-records` at `raw/github.com/acme/widgets/naim/2026-11-19-spec-344/`. It **may quote private issue text, command output and file contents**. The bucket's own rule deletes it after about 30 days. [List the files] [Upload] [Not now]";

describe("uploading the raw run folder to an expiring bucket", () => {
  const raw = flat(section(RUN, "### Uploading the raw run folder"));
  const closeOut = flat(section(SKILL, "### 10. Close out"));

  it("RUN.md and docs/orchestrate.md carry the approved raw line, word for word", () => {
    assert.ok(raw.includes(`> ${APPROVED_RAW_LINE}`), "RUN.md's raw line");
    assert.ok(flat(DOCS).includes(`> ${APPROVED_RAW_LINE}`), "the docs' raw line");
  });

  it("asks for the raw line only after the record line, in RUN.md and in the close-out", () => {
    const run = flat(RUN);
    assert.ok(
      run.indexOf(`> ${APPROVED_DISCLOSURE}`) < run.indexOf(`> ${APPROVED_RAW_LINE}`),
      "RUN.md shows the record line first",
    );
    assert.match(raw, /only after the Run Record's own line has been answered, at every close-out/);
    assert.ok(
      closeOut.indexOf("**upload it**") < closeOut.indexOf("offer the raw run folder"),
      "the close-out offers the raw folder after the record",
    );
    assert.match(
      closeOut,
      /after the record's line has been answered, show the raw line from `upload-raw <run>`, and upload only on the human's "Upload", at every close-out/,
    );
  });

  it("makes it never a routine write: the Dispatch Plan cannot list it", () => {
    assert.match(
      raw,
      /\*\*Never a routine write\.\*\* The Dispatch Plan cannot list it, and approving the plan at "go" does not answer it/,
    );
    assert.match(closeOut, /It is never a routine write: the Dispatch Plan cannot list it/);
    assert.match(
      flat(SKILL),
      /\*\*uploading the Run Record\*\* at close-out\)\. Uploading the raw run folder is never one of them\./,
    );
    assert.match(
      flat(DOCS),
      /\*\*never a routine write\*\*: approving the plan at "go" does not cover it/,
    );
    // The record's routine write is still the record's alone.
    assert.doesNotMatch(flat(section(RUN, "### Uploading the Run Record")), /raw run folder/);
  });

  it("answers the three buttons, and offers [List the files]", () => {
    assert.match(raw, /\*\*\[List the files\]:\*\* run the `--list` form/);
    assert.match(raw, /\*\*\[Upload\]:\*\* run the `--yes` form/);
    assert.match(raw, /\*\*\[Not now\]:\*\* do nothing more\. The folder stays on this machine\./);
  });

  it("is offered only with `records.raw.sink`, an `s3` bucket, and nothing otherwise", () => {
    assert.match(
      raw,
      /It is offered only when the config sets `records\.raw\.sink` \(\[CONFIG\.md\]\(CONFIG\.md#raw\)\), an `s3` bucket and nothing else/,
    );
    assert.match(raw, /Without `records\.raw`, nothing is offered and the run behaves as before\./);
  });

  it("reads the lifecycle, never writes it, and uploads nothing without an expiring rule", () => {
    assert.match(raw, /The script reads the bucket's lifecycle before it prints the line/);
    assert.match(raw, /no enabled lifecycle rule expires `raw\/`, or the lifecycle cannot be read/);
    assert.match(raw, /the skill never writes the bucket's configuration/);
  });

  it("DESIGN.md says why: s3 only, its own yes, never routine, read but never written", () => {
    const design = flat(DESIGN);
    assert.match(
      design,
      /only to an `s3` bucket, only after the bucket's own lifecycle rule is read/,
    );
    assert.match(design, /and only on a yes of its own at every close-out/);
    assert.match(design, /It is never a routine write, because/);
    assert.match(design, /The skill reads the lifecycle and never writes it/);
  });

  it("the s3 sink file and CONFIG.md say what access it needs and what `records.raw.sink` does", () => {
    const s3 = flat(read(`${SKILL_DIR}/sinks/s3.md`));
    assert.match(s3, /`s3:GetLifecycleConfiguration`\*\*/);
    assert.match(s3, /They never need `s3:PutLifecycleConfiguration`/);
    const configDoc = flat(read(`${SKILL_DIR}/CONFIG.md`));
    assert.match(
      configDoc,
      /`raw\.sink` takes the keys of an `s3` [Ss]ink .* any other type is a problem/,
    );
    assert.match(configDoc, /only a bucket can do that \(a git [Ss]ink cannot expire a file\)/);
    assert.match(
      flat(read(`${SKILL_DIR}/SINKS.md`)),
      /Raw run folders\*\* go only to an `s3` sink/,
    );
  });
});

describe("the second review's doc fixes (D1 to D5)", () => {
  const CONFIG = flat(read(`${SKILL_DIR}/CONFIG.md`));
  const records = section(RUN, "## Run Events and the Run Record");

  it("RUN.md's cause table renders: its delimiter row has as many cells as its header (D1)", () => {
    const lines = records.split("\n");
    const header = lines.findIndex((l) => /^\| Cause +\| Counts as +\| Meaning +\|$/.test(l));
    assert.ok(header >= 0, "the cause table's header row");
    const cells = (line) => line.split("|").length - 2;
    assert.match(lines[header + 1], /^\|( -+ \|)+$/);
    assert.equal(cells(lines[header + 1]), cells(lines[header]));
  });

  it("the `wait-closed` row names the unpark's actor, `chief-of-staff` (D2)", () => {
    const row = records.split("\n").find((l) => l.startsWith("| `wait-closed`"));
    assert.match(
      row,
      /\| Chief of Staff, actor `human` \(`chief-of-staff` when it unparks a `teammate-blocker` wait\) +\|/,
    );
  });

  it("CONFIG.md says `gh` or `glab` signs in, and names `--dashboard` as a reader of `records` (D3, D4)", () => {
    assert.match(
      CONFIG,
      /The config holds no credential: `gh` or `glab` signs in as the person who runs it/,
    );
    assert.match(
      CONFIG,
      /Read by the close-out \(\[SKILL\.md\]\(SKILL\.md#10-close-out\)\), by `--upload <run>` \(\[RUN\.md\]\(RUN\.md#uploading-the-run-record\)\), and by `--dashboard` \(\[RUN\.md\]\(RUN\.md#the-past-runs-dashboard\)\)\./,
    );
  });

  it("the docs page's board counts the stalled and crashed cards with the open waits (D5)", () => {
    const bullet = flat(DOCS.split("\n").find((l) => l.startsWith("- **What waits on you.**")));
    assert.match(bullet, /`stalled`/);
    assert.match(bullet, /`crashed`/);
    assert.match(
      bullet,
      /The banner, the Needs you column, the tab title, the favicon and the notifications count the same list/,
    );
  });
});
