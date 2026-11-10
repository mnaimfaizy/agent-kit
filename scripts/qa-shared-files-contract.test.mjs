/**
 * Contract test: `qa-plan` and `manual-qa` share their plan format and their
 * reader as byte-identical copies (ADR 0003). A Portable skill carries every
 * file it uses, so the two cannot import one shared file; this test is what
 * keeps the copies from drifting. `qa-plan` owns both: change it there, copy
 * it to `manual-qa`, in the same change.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude", "skills");
const SHARED = ["ANATOMY.md", "adapter.mjs"];

for (const file of SHARED)
  test(`manual-qa/${file} is a byte-identical copy of qa-plan/${file}`, () => {
    const owner = readFileSync(join(SKILLS, "qa-plan", file));
    const copy = readFileSync(join(SKILLS, "manual-qa", file));
    assert.ok(
      owner.equals(copy),
      `.claude/skills/manual-qa/${file} differs from .claude/skills/qa-plan/${file}: ` +
        `copy it over (cp .claude/skills/qa-plan/${file} .claude/skills/manual-qa/${file})`,
    );
  });
