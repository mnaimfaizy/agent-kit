// Pattern guide skeleton: docs/patterns/sub-agent-sync.md in Agent-kit.
//
// The contract suite for sync-agents-core.mjs. A few cases to start from:
// keep one test per rule in docs/patterns/sub-agent-sync.md, and add one every
// time the generator does something you did not expect.
//
// Run with: node --test <path>/sync-agents-core.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  auditPins,
  parseCanonical,
  planSync,
  renderSections,
  renderTarget,
} from "./sync-agents-core.mjs";

const HARNESSES = {
  alpha: {
    dir: "alpha/agents",
    fileName: (slug) => `${slug}.md`,
    tools: { read: ["Read"], search: ["Grep"], edit: ["Edit"], execute: ["Shell"], web: ["Fetch"] },
  },
  beta: {
    dir: "beta/agents",
    fileName: (slug) => `${slug}.md`,
    readonly: (roles) => !roles.includes("edit") && !roles.includes("execute"),
  },
};
const MODELS = { agents: { scout: { alpha: "model-a", beta: "model-b" } } };

const canonical = (overrides = {}) => {
  const fields = {
    name: "scout",
    description: '"Finds things: read-only."',
    tools: "[read, search]",
    ...overrides,
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\nShared line.\n`;
};
const scout = (overrides) => parseCanonical("scout", canonical(overrides));

test("a canonical file gives its name, description and roles", () => {
  const agent = scout();
  assert.equal(agent.name, "scout");
  assert.equal(agent.description, "Finds things: read-only.");
  assert.deepEqual(agent.roles, ["read", "search"]);
});

test("CRLF line endings read the same as LF", () => {
  const agent = parseCanonical("scout", canonical().replace(/\n/g, "\r\n"));
  assert.deepEqual(agent.roles, ["read", "search"]);
});

test("a canonical file without a description, a tools list, or with an unknown role is an error", () => {
  assert.throws(() => scout({ description: undefined }), /no description/);
  assert.throws(() => scout({ tools: undefined }), /no tools/);
  assert.throws(() => scout({ tools: "read, search" }), /one-line list/);
  assert.throws(() => scout({ tools: "[read, admin]" }), /unknown tool role "admin"/);
  assert.throws(() => parseCanonical("scout", "no frontmatter"), /no --- frontmatter/);
});

test("a harness block reaches only the harnesses it names", () => {
  const body = "all\n<!-- harness:alpha -->\nalpha only\n<!-- /harness -->\nall again";
  assert.equal(renderSections(body, "alpha", ["alpha", "beta"]), "all\nalpha only\nall again");
  assert.equal(renderSections(body, "beta", ["alpha", "beta"]), "all\nall again");
});

test("an unknown, nested, unopened or unclosed harness block is an error", () => {
  const known = ["alpha", "beta"];
  assert.throws(
    () => renderSections("<!-- harness:gamma -->\nx\n<!-- /harness -->", "alpha", known),
    /unknown harness/,
  );
  assert.throws(
    () =>
      renderSections(
        "<!-- harness:alpha -->\n<!-- harness:beta -->\n<!-- /harness -->",
        "alpha",
        known,
      ),
    /inside another/,
  );
  assert.throws(() => renderSections("x\n<!-- /harness -->", "alpha", known), /never opened/);
  assert.throws(() => renderSections("<!-- harness:alpha -->\nx", "alpha", known), /never closed/);
});

test("each copy carries the model pinned for its harness, from the policy", () => {
  const alpha = renderTarget(scout(), "alpha", MODELS, HARNESSES);
  const beta = renderTarget(scout(), "beta", MODELS, HARNESSES);
  assert.match(alpha, /^model: "model-a"$/m);
  assert.match(beta, /^model: "model-b"$/m);
});

test("a missing pin is an error, not a harness default", () => {
  const models = { agents: { scout: { alpha: "model-a" } } };
  assert.throws(() => renderTarget(scout(), "beta", models, HARNESSES), /no beta model pinned/);
});

test("roles become each harness's tool names, or a readonly flag", () => {
  assert.match(renderTarget(scout(), "alpha", MODELS, HARNESSES), /^tools: Read, Grep$/m);
  assert.match(renderTarget(scout(), "beta", MODELS, HARNESSES), /^readonly: true$/m);
  const builder = scout({ tools: "[read, edit]" });
  assert.match(renderTarget(builder, "beta", MODELS, HARNESSES), /^readonly: false$/m);
});

test("a description with a colon stays one valid quoted scalar", () => {
  const line = renderTarget(scout(), "alpha", MODELS, HARNESSES).match(/^description: (.*)$/m)[1];
  assert.equal(JSON.parse(line), "Finds things: read-only.");
});

test("the plan creates missing copies, leaves matching ones, and flags extras", () => {
  const fresh = renderTarget(scout(), "alpha", MODELS, HARNESSES);
  const actions = planSync(
    [scout()],
    MODELS,
    { alpha: { "scout.md": fresh, "old.md": "x" } },
    HARNESSES,
  );
  const byPath = Object.fromEntries(actions.map((action) => [action.path, action.action]));
  assert.deepEqual(byPath, {
    "alpha/agents/scout.md": "unchanged",
    "alpha/agents/old.md": "extra",
    "beta/agents/scout.md": "create",
  });
});

test("a hand edit to a copy is drift, and the plan restores the generated file", () => {
  const fresh = renderTarget(scout(), "alpha", MODELS, HARNESSES);
  const edited = fresh.replace('model: "model-a"', 'model: "something-newer"');
  const [action] = planSync([scout()], MODELS, { alpha: { "scout.md": edited } }, HARNESSES);
  assert.equal(action.action, "update");
  assert.equal(action.content, fresh);
});

test("a pin for a deleted agent or an unknown harness stops the plan", () => {
  const stale = { agents: { ...MODELS.agents, gone: { alpha: "model-a" } } };
  assert.throws(
    () => planSync([scout()], stale, {}, HARNESSES),
    /pins gone, which has no canonical file/,
  );
  const unknown = { agents: { scout: { ...MODELS.agents.scout, gamma: "model-c" } } };
  assert.throws(() => planSync([scout()], unknown, {}, HARNESSES), /unknown harness gamma/);
});

test("the audit finds each pin in its harness's catalog, case-insensitively", () => {
  const result = auditPins(MODELS, { alpha: "Models: MODEL-A, model-z", beta: "model-b" });
  assert.deepEqual(result, { missing: [], notRun: [] });
});

test("the audit reports a pin its catalog no longer lists", () => {
  const { missing } = auditPins(MODELS, { alpha: "model-z", beta: "model-b" });
  assert.deepEqual(missing, ['alpha: "model-a" (pinned for scout) is not in the catalog']);
});

test("an unread or unconfigured catalog is NOT RUN, never a pass", () => {
  const result = auditPins(MODELS, { alpha: null });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.notRun, [
    "alpha: the catalog could not be read",
    "beta: no catalog source configured",
  ]);
});

test("the skeleton's example copy is what the generator writes", () => {
  const here = new URL(".", import.meta.url);
  const body = fs.readFileSync(new URL("reviewer.agent.md", here), "utf8");
  const models = JSON.parse(fs.readFileSync(new URL("agent-models.json", here), "utf8"));
  const example = fs.readFileSync(new URL("reviewer.claude.md", here), "utf8");
  assert.equal(renderTarget(parseCanonical("reviewer", body), "claude", models), example);
});
