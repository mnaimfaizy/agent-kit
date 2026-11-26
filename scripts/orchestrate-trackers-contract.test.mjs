/**
 * Contract test: the tracker seam of an `orchestrate` Team Run (spec #314,
 * ADR 0014). The Team Run's parts of the skill speak only of the operations
 * `TRACKERS.md` names; each tracker's mapping file under `trackers/`
 * says how each one is done there. An operation with no mapping would leave a
 * run on that tracker with a step it cannot take, so this test holds every
 * mapping file to every operation, and to the header a run reads its Support
 * Level from. What each command returns is a fact for a run to check, not for
 * this test.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SUPPORT_LEVELS, TRACKERS } from "../.claude/skills/orchestrate/config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = join(root, ".claude/skills/orchestrate");
const DIR = join(SKILL_DIR, "trackers");
const read = (name) => readFileSync(join(DIR, name), "utf8");
const LIST = readFileSync(join(SKILL_DIR, "TRACKERS.md"), "utf8");

/** The operation ids: the first cell of each row of TRACKERS.md's operations table. */
const OPERATIONS = [...LIST.matchAll(/^\| `([a-z][a-z-]*)` +\|/gm)].map((m) => m[1]);
/** The Kind cell of one operation's row. */
const kind = (id) => new RegExp(`^\\| \`${id}\` +\\| ([^|]+?) +\\|`, "m").exec(LIST)?.[1] ?? "";
const MAPPINGS = readdirSync(DIR)
  .filter((name) => name.endsWith(".md"))
  .sort();

/** The `### \`<id>\`` headings of a mapping file. */
const mapped = (text) => [...text.matchAll(/^### `([a-z][a-z-]*)`$/gm)].map((m) => m[1]);

/** The text of operation `<id>`'s `### \`<id>\`` section in mapping file `<name>`. */
const section = (name, id) => {
  const text = read(name);
  const start = text.indexOf(`\n### \`${id}\`\n`);
  assert.ok(start >= 0, `section for \`${id}\``);
  const body = text.slice(text.indexOf("\n", start + 1) + 1);
  const next = body.search(/^#{2,3} /m);
  return next < 0 ? body : body.slice(0, next);
};

/** A text's lines, each line that ends in `\` joined to the next. */
const joinedLines = (text) => text.replace(/\\\n\s*/g, " ").split("\n");

describe("TRACKERS.md", () => {
  it("names the operations a Team Run's Dispatch Plan reads, each once", () => {
    for (const id of ["viewer", "spec-tickets", "blockers", "merged", "public", "labels"])
      assert.ok(OPERATIONS.includes(id), `operation \`${id}\` is listed`);
    assert.equal(new Set(OPERATIONS).size, OPERATIONS.length, "no operation is listed twice");
  });

  it("names the Shared Board's operations: find a ticket's row, write it, and set its state label", () => {
    for (const id of ["row", "write-row", "set-state", "pull-head"])
      assert.ok(OPERATIONS.includes(id), `operation \`${id}\` is listed`);
  });

  it('makes the row and label writes routine, approved once at "go", and creating a label never routine', () => {
    for (const id of ["write-row", "set-state"])
      assert.match(kind(id), /^routine write$/, `\`${id}\` is a routine write`);
    assert.match(kind("create-label"), /^write as the human/);
  });

  it("has a mapping file for GitHub and one for GitLab", () => {
    assert.ok(MAPPINGS.includes("github.md"));
    assert.ok(MAPPINGS.includes("gitlab.md"));
  });

  it("names only trackers the config's `tracker` key can pin", () => {
    for (const name of MAPPINGS) assert.ok(TRACKERS.includes(name.slice(0, -3)), name);
  });
});

for (const name of MAPPINGS) {
  describe(`trackers/${name}`, () => {
    const text = read(name);
    const line = (label) => new RegExp(`^- \\*\\*${label}:\\*\\* (.*)$`, "m").exec(text)?.[1];

    it("opens with its Id, Support Level and Facts from lines", () => {
      assert.equal(line("Id"), `\`${name.slice(0, -3)}\``);
      const level = /^`([a-z]+)`/.exec(line("Support Level") ?? "")?.[1];
      assert.ok(SUPPORT_LEVELS.includes(level), `Support Level is one of ${SUPPORT_LEVELS}`);
      assert.ok(line("Facts from"), "Facts from line");
    });

    it("never gives `gh api --slurp` with `--jq`, which `gh` refuses", () => {
      for (const line of joinedLines(text))
        if (/^gh api /.test(line)) assert.ok(!(/--slurp/.test(line) && /--jq/.test(line)), line);
    });

    it("never gives `glab api` a `--jq`, which it does not have", () => {
      for (const line of joinedLines(text))
        if (/^glab api /.test(line)) assert.ok(!/--jq/.test(line), line);
    });

    it("maps every operation TRACKERS.md names, and no other", () => {
      const ids = mapped(text);
      assert.deepEqual(
        OPERATIONS.filter((id) => !ids.includes(id)),
        [],
        "operations with no mapping",
      );
      assert.deepEqual(
        ids.filter((id) => !OPERATIONS.includes(id)),
        [],
        "mappings for no listed operation",
      );
    });
  });
}

describe("trackers/github.md", () => {
  it("starts at Support Level `documented`, until a Team Run on GitHub passes", () => {
    assert.match(read("github.md"), /^- \*\*Support Level:\*\* `documented`/m);
  });

  const op = (id) => section("github.md", id);

  it("finds a row by its hidden marker, and edits it by its comment id", () => {
    assert.match(op("row"), /orchestrate:shared-board-row/);
    assert.match(op("row"), /issues\/<n>\/comments/);
    assert.match(op("write-row"), /-X PATCH repos\/<owner>\/<repo>\/issues\/comments\/<id>/);
    assert.match(op("write-row"), /repos\/<owner>\/<repo>\/issues\/<n>\/comments/);
  });

  it("sets one state label via REST POST, removes the others via REST DELETE, and reads it back, since GitHub can drop it silently", () => {
    const set = op("set-state");
    assert.match(set, /-X POST repos\/<owner>\/<repo>\/issues\/<n>\/labels/);
    assert.match(set, /-X DELETE "repos\/<owner>\/<repo>\/issues\/<n>\/labels\//);
    assert.match(set, /404/);
    assert.match(set, /silently/);
    assert.match(set, /row comment stays the record/);
  });
});

describe("trackers/gitlab.md", () => {
  const text = read("gitlab.md");

  const op = (id) => section("gitlab.md", id);
  /** The shell commands in the file's ```bash blocks, one per line, continuations joined. */
  const commands = [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)]
    .flatMap((m) => joinedLines(m[1]))
    .filter((line) => line.trim() !== "");

  it("starts at Support Level `documented`, until a Team Run on GitLab passes", () => {
    assert.match(text, /^- \*\*Support Level:\*\* `documented`/m);
  });

  it("dates its facts, and marks the research's unconfirmed points to check before use", () => {
    assert.match(/^- \*\*Facts from:\*\* (.*)$/m.exec(text)?.[1] ?? "", /\d{4}-\d{2}-\d{2}/);
    const at = text.indexOf("\n## Check before use\n");
    assert.ok(at >= 0, "a Check before use section");
    const check = text.slice(at);
    for (const point of [/is_blocked_by/, /quick action/i, /closed_by/, /Planner/])
      assert.match(check, point);
  });

  it("works with `glab` alone, never `gh`", () => {
    for (const line of commands) assert.ok(!/(^|[|;&]\s*)gh /.test(line), line);
    assert.ok(commands.some((line) => /^glab api /.test(line)));
  });

  it("needs no Premium feature: no scoped label, epic, Status or custom field", () => {
    for (const line of commands) {
      assert.ok(!/::/.test(line.replace(/projects\/:id/g, "")), `no scoped label: ${line}`);
      assert.ok(!/epics|statusWidget|customFields|work_items/.test(line), line);
    }
  });

  it("keeps the row in one note per ticket: found by its marker, edited by its note id", () => {
    assert.match(op("row"), /projects\/:id\/issues\/<n>\/notes/);
    assert.match(op("row"), /orchestrate:shared-board-row/);
    assert.match(op("row"), /system/, "system notes are skipped");
    assert.match(op("write-row"), /-X PUT projects\/:id\/issues\/<n>\/notes\/<id>/);
    assert.match(op("write-row"), /glab api projects\/:id\/issues\/<n>\/notes /);
  });

  it("refuses to write a row with a line starting with `/`, which GitLab runs as a quick action", () => {
    assert.match(op("write-row"), /grep -nE '\^\[\[:space:\]\]\*\/' <file>/);
    assert.match(op("write-row"), /quick action/);
  });

  it("reads blockers from native `is_blocked_by` links, and else a `Blocked by:` line atop the description", () => {
    const blockers = op("blockers");
    assert.match(blockers, /projects\/:id\/issues\/<n>\/links/);
    assert.match(blockers, /is_blocked_by/);
    assert.match(blockers, /Blocked by: #<n>, #<n>/);
    assert.match(blockers, /Premium/);
  });

  it("clears a blocker only on a merged merge request, read through `closed_by`, not the issue closing", () => {
    const merged = op("merged");
    assert.match(merged, /projects\/:id\/issues\/<n>\/closed_by/);
    assert.match(merged, /`merged`/);
    assert.match(merged, /not (from )?the issue clos/);
  });

  it("sets one plain state label with add and remove, and reads it back", () => {
    const set = op("set-state");
    assert.match(set, /add_labels/);
    assert.match(set, /remove_labels/);
    assert.match(set, /plain label/);
    assert.match(set, /row (note|comment) stays the record/);
  });
});
