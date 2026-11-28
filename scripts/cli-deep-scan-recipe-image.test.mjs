// Contract for `agent-kit deep-scan` (cli/): the recipe's `image` is pulled,
// and the pinned Claude Code layer built on it, by the host's Docker engine,
// outside the sandbox runtime. It is trusted like the recipe, so the run
// notes an image named by tag alone, which can change between runs.
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { imageDigestNote, validateRecipe } from "../cli/src/deep-scan/recipe.mjs";
import { VALID, run, recipeRepo, recipe, sbxHost } from "./cli-deep-scan-fixtures.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const NOTE = /Note: the recipe's image node:22-bookworm has no @sha256: digest/;

describe("a recipe image named by tag alone", () => {
  it("gets a note naming the digest form, and an image pinned by digest gets none", () => {
    assert.match(imageDigestNote("node:22-bookworm") ?? "", NOTE);
    assert.match(imageDigestNote("node:22-bookworm") ?? "", /node:22-bookworm@sha256:<digest>/);
    assert.match(imageDigestNote("ghcr.io/o/i") ?? "", /ghcr\.io\/o\/i@sha256:<digest>/);
    assert.match(imageDigestNote("node@sha256:abc") ?? "", /node@sha256:<digest>/);
    assert.equal(imageDigestNote(`node:22-bookworm@${DIGEST}`), null);
    assert.equal(imageDigestNote(`registry.example.com:5000/a/b:1@${DIGEST}`), null);
  });

  it("is still a valid recipe: a warning, not a refusal", () => {
    assert.deepEqual(validateRecipe(VALID), []);
  });

  it("is noted on the Docker Engine Image step, and the run goes on", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    assert.match(res.out, NOTE);
    assert.ok(
      res.out.indexOf("Image: pulling node:22-bookworm.") < res.out.search(NOTE),
      "after the pull line",
    );
  });

  it("is noted on Docker Sandboxes too", async () => {
    const res = await run(recipeRepo(VALID), [], { host: sbxHost() });
    assert.equal(res.code, 0, res.text);
    assert.match(res.out, NOTE);
  });

  it("is not noted once the image is pinned by digest", async () => {
    const text = recipe({ drop: ["image"], add: `image: node:22-bookworm@${DIGEST}` });
    for (const host of [undefined, sbxHost()]) {
      const res = await run(recipeRepo(text), [], host ? { host } : {});
      assert.equal(res.code, 0, res.text);
      assert.doesNotMatch(res.out, /has no @sha256: digest/);
    }
  });
});
