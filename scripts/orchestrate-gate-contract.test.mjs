/**
 * Contract test: the re-gate and the landing checks are commands of
 * `config.mjs` (the spec #413 run's retrospective), and the skill text points
 * at them. For every landing the Chief of Staff had typed the same worktree
 * pipeline by hand, compared failing test names to five known ones by eye, and
 * read the scope fence off `git diff --stat`. The skill is prose, so these
 * tests pin the sentences a run relies on: SKILL.md step 7 and SPEC.md item 5
 * name `regate` and `land`, BRIEF.md writes the fence as globs `land --fence`
 * takes verbatim, CONFIG.md documents the commands and `allowed_failures`, and
 * DESIGN.md gives the reason.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LAND_REFUSALS } from "../.claude/skills/orchestrate/config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const SKILL_DIR = ".claude/skills/orchestrate";
const SKILL = read(`${SKILL_DIR}/SKILL.md`);
const SPEC = read(`${SKILL_DIR}/SPEC.md`);
const BRIEF = read(`${SKILL_DIR}/BRIEF.md`);
const CONFIG = read(`${SKILL_DIR}/CONFIG.md`);
const DESIGN = read(`${SKILL_DIR}/DESIGN.md`);

const line = (text, start) => {
  const found = text.split("\n").find((l) => l.startsWith(start));
  assert.ok(found, `a line starts with ${start}`);
  return found;
};

describe("SKILL.md step 7", () => {
  it("re-gates with `config.mjs regate`, writing its result under the run's evidence/", () => {
    const item = line(SKILL, "- **re-gate:**");
    assert.match(item, /node "<skill>\/config\.mjs" regate <head> --out/);
    assert.match(item, /evidence\//);
    assert.match(item, /`regate\.allowed_failures`/);
  });

  it("names `land` as the check of a landing's fence", () => {
    const item = line(SKILL, "- **scope fence:**");
    assert.match(item, /config\.mjs" land/);
  });
});

describe("SPEC.md item 5", () => {
  const start = SPEC.indexOf("\n5. **Fast-forward it back");
  const item = SPEC.slice(start, SPEC.indexOf("\n6. **Start the next wave", start));

  it("re-gates the pinned commit with `regate`", () => {
    assert.match(item, /config\.mjs" regate <pinned commit> --out/);
  });

  it("lands with `land`, which checks descent, the fence and checked-out worktrees, and moves the branch by update-ref", () => {
    assert.match(
      item,
      /config\.mjs" land <pinned commit> --cut <cut commit> --onto <integration> --fence/,
    );
    assert.match(item, /descends from the cut/);
    assert.match(item, /checked out/);
    assert.match(
      item,
      /git update-ref refs\/heads\/<integration> <pinned commit> <integration head>/,
    );
    assert.match(item, /never merges, rebases or pushes/);
  });

  it("raises a refusal as a Decision Request, never works around it", () => {
    assert.match(item, /names its cause/);
  });
});

describe("BRIEF.md: the fence as globs", () => {
  it("writes the scope fence as globs as well as prose, which `land --fence` takes verbatim", () => {
    const item = line(BRIEF, "4. **Scope fences.**");
    assert.match(item, /as globs as well as prose/);
    assert.match(item, /`land --fence`/);
    assert.match(item, /verbatim/);
  });
});

describe("CONFIG.md", () => {
  it("documents `regate.allowed_failures`, and both commands", () => {
    assert.match(CONFIG, /^### `regate`$/m);
    assert.match(CONFIG, /`allowed_failures`/);
    assert.match(CONFIG, /config\.mjs" regate <sha> --out <file>/);
    assert.match(
      CONFIG,
      /config\.mjs" land <branch> --cut <sha> --onto <integration> --fence <glob>/,
    );
  });

  it("names each refusal code `land` can print", () => {
    assert.ok(LAND_REFUSALS.length > 0);
    const sentence = CONFIG.split("\n").find((l) => l.includes("`refusal` code"));
    assert.ok(sentence, "CONFIG.md has the sentence naming the refusal codes");
    for (const code of LAND_REFUSALS) assert.ok(sentence.includes(`\`${code}\``), code);
  });

  it("says an allowed failure excuses only named test failures", () => {
    assert.match(CONFIG, /only excuses named test failures/);
    assert.match(CONFIG, /anything but 1/);
  });

  it("says how a failing test is named, and that a listed name is matched whole", () => {
    assert.match(CONFIG, /matched whole/);
  });
});

describe("docs/orchestrate.md", () => {
  const DOCS = read("docs/orchestrate.md");

  it("tells the integration-branch flow's reader about the whole-integration review and its fix", () => {
    const flow = DOCS.split("\n").find((l) =>
      l.startsWith("On an integration branch, the Chief of Staff cuts"),
    );
    assert.match(flow, /`d<n>-review`/);
    assert.match(flow, /stale-wording list/);
    assert.match(flow, /before the pull request is drafted/);
  });

  it("points the verify step's re-gate at `config.mjs regate` and `land`", () => {
    const step = DOCS.split("\n").find((l) => l.startsWith("7. **Verify each report**"));
    assert.match(step, /config\.mjs regate/);
    assert.match(step, /config\.mjs land/);
  });
});

describe("DESIGN.md", () => {
  it("gives the reason for commands: the same long pipeline and by-eye comparison, typed for every landing", () => {
    assert.match(DESIGN, /^## The re-gate and the landing are commands$/m);
    assert.match(DESIGN, /by eye/);
  });
});
