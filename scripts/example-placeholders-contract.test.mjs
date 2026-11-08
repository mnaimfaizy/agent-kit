// Contract: each Caller example under examples/ holds every placeholder
// `agent-kit init` fills in, exactly as many times as init expects
// (cli/src/templates.mjs). init refuses a tag whose example does not match,
// so changing an example's placeholders means changing templates.mjs too.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findKitPins, parseCaller } from "../cli/src/callers.mjs";
import { FLOWS, PLACEHOLDERS, placeholderCounts, renderCaller } from "../cli/src/templates.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const presets = readdirSync(join(root, "examples/setup-presets")).filter((f) => f.endsWith(".sh"));

const values = (preset) => ({
  actors: ["alice", "bob"],
  tag: "v9.8.7-rc.6",
  defaultBranch: "trunk",
  verify: "set -e\nnpm test",
  preset,
  threatPackDir: "docs/security",
});

describe("example placeholders", () => {
  for (const [flow, { example }] of Object.entries(FLOWS)) {
    it(`${example} holds each placeholder the expected number of times`, () => {
      const found = placeholderCounts(read(example));
      for (const p of PLACEHOLDERS) {
        assert.equal(found[p.name], p.counts[flow], `${example}: ${p.name}`);
      }
    });

    it(`${example} renders with no placeholder left and the same jobs`, () => {
      const text = read(example);
      const out = renderCaller(flow, text, values(null));
      assert.doesNotMatch(out, /your-github-login|\.security\/|Provide Consumer verify/);
      assert.ok(findKitPins(out).every((pin) => pin.ref === "v9.8.7-rc.6"));
      assert.equal(findKitPins(out).length, findKitPins(text).length);
      assert.deepEqual(
        parseCaller(out).jobs.map((j) => j.name),
        parseCaller(text).jobs.map((j) => j.name),
      );
    });
  }

  it("the pipeline example names its flow, and so does the audit example", () => {
    assert.match(read(FLOWS.pipeline.example), /^name: agent-pipeline$/m);
    assert.match(read(FLOWS.audit.example), /^name: security-audit$/m);
  });

  for (const preset of presets) {
    it(`setup preset ${preset} inlines under setup_commands with every line indented`, () => {
      const text = read(FLOWS.pipeline.example);
      const out = renderCaller("pipeline", text, values(read(`examples/setup-presets/${preset}`)));
      const lines = out.split("\n");
      const start = lines.findIndex((l) => /^ {6}setup_commands: \|$/.test(l));
      assert.ok(start > 0, "setup_commands block written");
      const body = [];
      for (const l of lines.slice(start + 1)) {
        if (l !== "" && !l.startsWith("        ")) break;
        body.push(l);
      }
      assert.equal(
        body.filter(Boolean).length,
        read(`examples/setup-presets/${preset}`).trim().split("\n").filter(Boolean).length,
      );
      assert.equal(parseCaller(out).jobs.length, 3);
    });
  }

  it("a wrong count is refused before anything is replaced", () => {
    const text = read(FLOWS.audit.example).replace("your-github-login", "someone");
    assert.throws(
      () => renderCaller("audit", text, values(null)),
      /your-github-login: expected 1, found 0/,
    );
  });
});
