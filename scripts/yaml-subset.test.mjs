// Contract for the CLI's dependency-free YAML reader (cli/src/yaml-subset.mjs):
// block sequences come back as real lists, of scalars and of mappings, nested
// mappings included, so the Scan recipe reader can read `entry_points` and
// `fixtures`. Flow collections stay as their raw text.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCaller } from "../cli/src/callers.mjs";
import { parseWorkflowCallInputs, parseWorkflowCallSecrets } from "../cli/src/workflow-call.mjs";
import { parseYamlSubset } from "../cli/src/yaml-subset.mjs";

describe("parseYamlSubset block sequences", () => {
  it("reads a sequence of scalars as a list", () => {
    const doc = parseYamlSubset(
      ["registries:", "  - registry.npmjs.org", '  - "pypi.org" # index', "  - 'a: b'", ""].join(
        "\n",
      ),
    );
    assert.deepEqual(doc, { registries: ["registry.npmjs.org", "pypi.org", "a: b"] });
  });

  it("reads a sequence of mappings, nested mappings included", () => {
    const doc = parseYamlSubset(
      [
        "fixtures:",
        "  - name: admin",
        "    role: admin # the only admin",
        "    credentials:",
        "      user: admin@example.test",
        "      password: not-a-real-secret",
        "",
        "  - name: viewer",
        "    role: viewer",
        "notes: static only",
        "",
      ].join("\n"),
    );
    assert.deepEqual(doc, {
      fixtures: [
        {
          name: "admin",
          role: "admin",
          credentials: { user: "admin@example.test", password: "not-a-real-secret" },
        },
        { name: "viewer", role: "viewer" },
      ],
      notes: "static only",
    });
  });

  it("reads a sequence at its key's indent, and lists inside list items", () => {
    const doc = parseYamlSubset(
      [
        "entry_points:",
        "- command: node cli/bin/agent-kit.mjs",
        "  note: the CLI",
        "  args:",
        "  - doctor",
        "  - --json",
        "- url: http://localhost:8080/api",
        "  note: the API",
        "setup:",
        "  -",
        "    - npm ci",
        "    - npm run build",
        "",
      ].join("\n"),
    );
    assert.deepEqual(doc, {
      entry_points: [
        { command: "node cli/bin/agent-kit.mjs", note: "the CLI", args: ["doctor", "--json"] },
        { url: "http://localhost:8080/api", note: "the API" },
      ],
      setup: [["npm ci", "npm run build"]],
    });
  });

  it("keeps flow items raw, reads block-scalar items, and an empty item as null", () => {
    const doc = parseYamlSubset(
      [
        "items:",
        "  - { name: api, port: 8080 }",
        "  - [a, b]",
        "  - |",
        "    line one",
        "    line two",
        "  -",
        "  - last",
        "",
      ].join("\n"),
    );
    assert.deepEqual(doc, {
      items: ["{ name: api, port: 8080 }", "[a, b]", "    line one\n    line two", null, "last"],
    });
  });
});

// The readers built on parseYamlSubset treat a list where they expect a
// mapping the way they did when lists came back as raw lines.
describe("callers read lists as before", () => {
  const uses = "mnaimfaizy/agent-kit/.github/workflows/agent-plan-reusable.yml@v1";

  it("parseCaller reports a list of secrets as unreadable", () => {
    const caller = parseCaller(
      `jobs:\n  plan:\n    uses: ${uses}\n    secrets:\n      - CLAUDE_CODE_OAUTH_TOKEN\n`,
    );
    assert.equal(caller.jobs[0].secretsUnsupported, "`secrets:` is a list");
    assert.deepEqual(caller.jobs[0].secrets, {});
  });

  it("parseCaller ignores a list under jobs or with", () => {
    assert.deepEqual(parseCaller("jobs:\n  - plan\n").jobs, []);
    const caller = parseCaller(`jobs:\n  plan:\n    uses: ${uses}\n    with:\n      - a\n`);
    assert.deepEqual(caller.jobs[0].with, {});
  });

  it("parseCaller finds workflow_dispatch in a list of events", () => {
    const listed = "on:\n  - push\n  - workflow_dispatch # manual\njobs: {}\n";
    assert.deepEqual(parseCaller(listed).dispatchInputs, []);
    assert.equal(parseCaller("on:\n  - push\njobs: {}\n").dispatchInputs, null);
    const inputsList = "on:\n  workflow_dispatch:\n    inputs:\n      - pr_number\njobs: {}\n";
    assert.deepEqual(parseCaller(inputsList).dispatchInputs, []);
  });

  it("the workflow_call readers ignore a list of secrets or inputs", () => {
    const text = "on:\n  workflow_call:\n    secrets:\n      - A\n    inputs:\n      - b\n";
    assert.deepEqual([...parseWorkflowCallSecrets(text)], []);
    assert.deepEqual([...parseWorkflowCallInputs(text)], []);
    assert.equal(parseWorkflowCallSecrets("on:\n  - workflow_call\n"), null);
  });
});
