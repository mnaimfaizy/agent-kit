/**
 * Contract test: the tracker seam of an `orchestrate` Team Run (spec #314,
 * ADR 0014). The Team Run's parts of the skill speak only of the operations
 * `trackers/TRACKERS.md` names; each tracker's mapping file under `trackers/`
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
const DIR = join(root, ".claude/skills/orchestrate/trackers");
const read = (name) => readFileSync(join(DIR, name), "utf8");
const LIST = read("TRACKERS.md");

/** The operation ids: the first cell of each row of TRACKERS.md's operations table. */
const OPERATIONS = [...LIST.matchAll(/^\| `([a-z][a-z-]*)` +\|/gm)].map((m) => m[1]);
const MAPPINGS = readdirSync(DIR)
  .filter((name) => name.endsWith(".md") && name !== "TRACKERS.md")
  .sort();

/** The `### \`<id>\`` headings of a mapping file. */
const mapped = (text) => [...text.matchAll(/^### `([a-z][a-z-]*)`$/gm)].map((m) => m[1]);

describe("trackers/TRACKERS.md", () => {
  it("names the operations a Team Run's Dispatch Plan reads, each once", () => {
    for (const id of ["viewer", "spec-tickets", "blockers", "merged", "public", "labels"])
      assert.ok(OPERATIONS.includes(id), `operation \`${id}\` is listed`);
    assert.equal(new Set(OPERATIONS).size, OPERATIONS.length, "no operation is listed twice");
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
});
