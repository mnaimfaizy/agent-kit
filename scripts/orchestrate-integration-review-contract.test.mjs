/**
 * Contract test: a spec run's integration branch is reviewed whole before its
 * one pull request is drafted (the spec #413 run's retrospective). Each ticket
 * Delegation reviews only its own diff against its cut point, so two bugs
 * where tickets met, and ten passages that still stated an old rule, were
 * found only after the pull request opened, and cost a fix round. The skill is
 * prose, so these tests pin the sentences a run relies on: the review step in
 * SPEC.md item 7, its stale-wording list and completion criterion, the fix
 * Delegation it feeds, the same list in a building brief, the Delegation id in
 * RUN.md, and the reason in DESIGN.md. What a sentence means is for review;
 * these only keep it from being dropped.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const SKILL_DIR = ".claude/skills/orchestrate";
const SPEC = read(`${SKILL_DIR}/SPEC.md`);
const BRIEF = read(`${SKILL_DIR}/BRIEF.md`);
const RUN = read(`${SKILL_DIR}/RUN.md`);
const DESIGN = read(`${SKILL_DIR}/DESIGN.md`);

/** One numbered item of SPEC.md's integration-branch list, from its number to the next item. */
function specItem(n) {
  const start = SPEC.indexOf(`\n${n}. **`);
  assert.ok(start >= 0, `SPEC.md has item ${n}`);
  const rest = SPEC.slice(start + 1);
  const next = rest.search(/\n\d+\. \*\*|\n### |\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("SPEC.md item 7: an integration review before the pull request", () => {
  const item = specItem(7);

  it("starts one review Delegation on the whole integration diff, after the last ticket lands", () => {
    assert.match(item, /one review Delegation/);
    assert.match(item, /whole integration diff against the default branch/);
    assert.ok(
      item.indexOf("one review Delegation") < item.indexOf("draft the pull request"),
      "the review comes before the draft",
    );
  });

  it("uses the code-review skill", () => {
    assert.match(item, /`code-review`/);
  });

  it("carries a stale-wording list taken from the spec and its tickets", () => {
    assert.match(item, /stale-wording list/);
    assert.match(item, /old wording of each rule the spec changes/);
  });

  it("searches code, skills and docs for each phrase, and the list accounted for is its completion criterion", () => {
    assert.match(item, /searches the repository for each phrase \(code, skills, docs\)/);
    assert.match(item, /reports every hit/);
    assert.match(item, /fully accounted for/);
  });

  it("sends its findings to a fix Delegation, landed by item 5, before the pull request is drafted", () => {
    assert.match(item, /`d<n>-fix<k>`/);
    assert.match(item, /landed by item 5/);
  });

  it("is a step of the same item that drafts the pull request", () => {
    assert.match(item, /Opening it pushes the branch/);
  });
});

describe("BRIEF.md: the stale-wording item in a building brief", () => {
  it("asks a building brief whose ticket changes a rule for the rule's old wording", () => {
    assert.match(BRIEF, /stale-wording list/);
    assert.match(BRIEF, /ticket changes a rule/);
  });

  it("has the Delegation search the repository for each phrase and report every hit", () => {
    const phase = BRIEF.split("\n").find((l) => l.includes("stale-wording list"));
    assert.match(phase, /searches the repository for each phrase/);
    assert.match(phase, /every hit/);
  });
});

describe("RUN.md and DESIGN.md", () => {
  it("RUN.md names `d<spec>-fix<k>` as the integration review's fix Delegation too", () => {
    assert.match(RUN, /`d<spec>-fix<k>`/);
    assert.match(RUN, /integration review/);
  });

  it("DESIGN.md gives the reason: a ticket review sees only its own diff", () => {
    assert.match(DESIGN, /^## The integration is reviewed whole$/m);
    assert.match(DESIGN, /only its own diff/);
    assert.match(DESIGN, /stale/);
  });
});
