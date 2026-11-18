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

  it("has a mapping file for GitHub", () => {
    assert.ok(MAPPINGS.includes("github.md"));
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

  /** The text of one operation's `### \`<id>\`` section. */
  const op = (id) => {
    const text = read("github.md");
    const start = text.indexOf(`\n### \`${id}\`\n`);
    assert.ok(start >= 0, `section for \`${id}\``);
    const body = text.slice(text.indexOf("\n", start + 1) + 1);
    const next = body.search(/^#{2,3} /m);
    return next < 0 ? body : body.slice(0, next);
  };

  it("finds a row by its hidden marker, and edits it by its comment id", () => {
    assert.match(op("row"), /orchestrate:shared-board-row/);
    assert.match(op("row"), /issues\/<n>\/comments/);
    assert.match(op("write-row"), /-X PATCH repos\/<owner>\/<repo>\/issues\/comments\/<id>/);
    assert.match(op("write-row"), /repos\/<owner>\/<repo>\/issues\/<n>\/comments/);
  });

  it("sets one state label, removes the others, and reads it back, since GitHub can drop it silently", () => {
    const set = op("set-state");
    assert.match(set, /--add-label/);
    assert.match(set, /--remove-label/);
    assert.match(set, /silently/);
    assert.match(set, /row comment stays the record/);
  });
});
