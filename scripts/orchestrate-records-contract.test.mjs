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

import { CAUSES, EVENT_KINDS, STEP_KINDS } from "../.claude/skills/orchestrate/records.mjs";

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
      assert.ok(step.includes(`\`${kind}\``) || step.includes(kind), kind);
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
      /The count of people with access is left out when the sink cannot be read for it\./,
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
      /the sink is not private, or its visibility cannot be read: there is no override/,
    );
    assert.match(uploading, /different bytes are already at the path: nothing is overwritten/);
    assert.match(uploading, /exit code `3`: the repository cannot be told/);
  });

  it("the sink file states the writer's access, and mirrors the tracker files", () => {
    const sink = flat(read(`${SKILL_DIR}/sinks/github.md`));
    assert.match(sink, /^# GitHub - \*\*Id:\*\* `github` - \*\*Support Level:\*\* `documented`/);
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

  it("SINKS.md lists the gitlab sink and says where its Support Level is read", () => {
    const index = flat(read(`${SKILL_DIR}/SINKS.md`));
    assert.match(index, /\| `gitlab` \| `documented` \|/);
    assert.match(
      index,
      /A sink's Support Level is the one its own file states, and the Dispatch Plan and the disclosure name it while it is below `verified` \\(\\[RUN\\.md\\]\\(RUN\\.md#uploading-the-run-record\\)\\): `gitlab` ships at `documented` until a run has uploaded to it/,
    );
  });

  it("RUN.md and SKILL.md have the Dispatch Plan and the close-out say the sink's Support Level", () => {
    const run = flat(read(`${SKILL_DIR}/RUN.md`));
    assert.match(
      run,
      /When the sink's file states a Support Level below `verified` \(`gitlab` ships at `documented`\), the Dispatch Plan says so beside "upload the Run Record", and the close-out repeats it after the disclosure/,
    );
    assert.match(flat(SKILL), /the sink's Support Level \(\[SINKS\.md\]\(SINKS\.md\)\)/);
    assert.match(flat(DESIGN), /`gitlab` sink ships at Support Level `documented`/);
  });

  it("CONFIG.md documents the records keys, and the path and login rules", () => {
    const config = flat(read(`${SKILL_DIR}/CONFIG.md`));
    assert.match(
      config,
      /A record's path in the sink is `records\/<host>\/<owner>\/<repo>\/<login>\/<run-id>\.json`, every segment lowercased/,
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
