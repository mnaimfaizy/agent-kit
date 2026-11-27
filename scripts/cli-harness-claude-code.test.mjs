// Contract for the Claude Code Harness adapter (cli/src/harness/): given a
// Stage request it returns the nine-part launch plan of ADR 0027 as plain
// data, and starts nothing. What the Launcher does with the plan is held by
// the Deep scan CLI contract tests (scripts/cli-deep-scan-*.test.mjs).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { agentScript } from "../cli/src/deep-scan/agent.mjs";
import { claudeCode } from "../cli/src/harness/claude-code.mjs";
import { layerDockerfile } from "../cli/src/harness/install-layer.mjs";

const PARTS = [
  "identity",
  "installLayer",
  "modelRoute",
  "credentials",
  "launch",
  "checkoutConfig",
  "instructionFiles",
  "stops",
  "transcript",
];

const REQUEST = {
  stage: "deep-scan",
  proxyUrl: "http://10.0.0.1:5",
  briefPath: "/agent-kit/in/brief.md",
  kitDir: "/agent-kit",
  maxTurns: 200,
};

const TOOLS = "Bash,Read,Write,Edit,Glob,Grep";

const SETTINGS = {
  env: {
    ANTHROPIC_BASE_URL: "http://10.0.0.1:5",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  },
  permissions: {
    allow: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    deny: ["WebFetch", "WebSearch"],
  },
};

/** What every plan holds, whatever the credential kind. */
function assertCommonParts(plan) {
  assert.deepEqual(Object.keys(plan), PARTS, "the nine parts: no output parser, no Guard table");
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, "the plan is plain data");
  assert.deepEqual(plan.identity, {
    name: "claude-code",
    displayName: "Claude Code",
    version: "2.1.328",
    major: 2,
  });
  assert.deepEqual(plan.installLayer, {
    env: ["DISABLE_AUTOUPDATER=1"],
    run: [
      "npm install --global @anthropic-ai/claude-code@2.1.328 \\",
      "  && mkdir -p /etc/claude-code \\",
      `  && printf '%s\\n' '{"env":{"DISABLE_AUTOUPDATER":"1"}}' > /etc/claude-code/managed-settings.json`,
    ],
  });
  assert.deepEqual(plan.modelRoute, { profile: "anthropic" });
  assert.deepEqual(plan.credentials, {
    accepted: {
      "api-key": {
        secret: "anthropic_api_key",
        env: "ANTHROPIC_API_KEY",
        placeholder: "agent-kit-deep-scan-placeholder",
      },
      subscription: {
        secret: "claude_code_oauth_token",
        env: "CLAUDE_CODE_OAUTH_TOKEN",
        placeholder: "sk-ant-oat01-agent-kit-deep-scan-placeholder",
      },
    },
    scrub: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  });
  assert.deepEqual(plan.checkoutConfig, [
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".mcp.json",
  ]);
  assert.deepEqual(plan.instructionFiles, ["CLAUDE.md", "CLAUDE.local.md"]);
  assert.deepEqual(plan.stops, { turnCap: { stderrPattern: "^Error: Reached max turns" } });
  assert.deepEqual(plan.transcript, { path: "/agent-kit/logs/agent.log" });
}

/** argv with the --settings value parsed, so it compares as data. */
function parsed(argv) {
  const i = argv.indexOf("--settings") + 1;
  return argv.map((a, at) => (at === i ? JSON.parse(a) : a));
}

describe("the Claude Code launch plan with an API key", () => {
  const plan = claudeCode({ ...REQUEST, credentialKind: "api-key" });

  it("has the nine parts of ADR 0027, as plain data", () => {
    assertCommonParts(plan);
  });

  it("launches with --bare, the brief on stdin and a placeholder key", () => {
    assert.deepEqual(
      { ...plan.launch, argv: parsed(plan.launch.argv) },
      {
        argv: [
          "claude",
          "--bare",
          "--print",
          "--settings",
          SETTINGS,
          "--setting-sources",
          "user",
          "--tools",
          TOOLS,
          "--allowedTools",
          TOOLS,
          "--disallowedTools",
          "WebFetch,WebSearch",
          "--permission-mode",
          "dontAsk",
          "--add-dir",
          "/agent-kit",
          "--no-session-persistence",
          "--max-turns",
          "200",
        ],
        stdin: { file: "/agent-kit/in/brief.md" },
        files: [],
        env: [
          "ANTHROPIC_API_KEY=agent-kit-deep-scan-placeholder",
          "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
        ],
      },
    );
  });

  it("is the default credential kind", () => {
    assert.deepEqual(claudeCode(REQUEST), plan);
  });

  it("passes the model and effort through verbatim", () => {
    const { argv } = claudeCode({ ...REQUEST, model: "claude-x[1m]", effort: "high" }).launch;
    assert.deepEqual(argv.slice(-4), ["--model", "claude-x[1m]", "--effort", "high"]);
  });
});

describe("the Claude Code launch plan with a subscription token", () => {
  const plan = claudeCode({ ...REQUEST, credentialKind: "subscription" });

  it("has the nine parts of ADR 0027, as plain data", () => {
    assertCommonParts(plan);
  });

  it("runs without --bare, with hooks off, no repository MCP server and a placeholder token", () => {
    assert.deepEqual(
      { ...plan.launch, argv: parsed(plan.launch.argv) },
      {
        argv: [
          "claude",
          "--print",
          "--settings",
          { ...SETTINGS, disableAllHooks: true },
          "--setting-sources",
          "user",
          "--strict-mcp-config",
          "--tools",
          TOOLS,
          "--allowedTools",
          TOOLS,
          "--disallowedTools",
          "WebFetch,WebSearch",
          "--permission-mode",
          "dontAsk",
          "--add-dir",
          "/agent-kit",
          "--no-session-persistence",
          "--max-turns",
          "200",
        ],
        stdin: { file: "/agent-kit/in/brief.md" },
        files: [],
        env: [
          "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-agent-kit-deep-scan-placeholder",
          "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
        ],
      },
    );
  });
});

describe("the Claude Code adapter starts nothing", () => {
  it("imports no module, so it can reach no process, file or network", () => {
    const source = readFileSync(
      new URL("../cli/src/harness/claude-code.mjs", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /^\s*import\s|\bimport\(|\bprocess\.|\bfetch\(/m);
  });

  it("returns a fresh plan each time, so a caller's change stays its own", () => {
    claudeCode(REQUEST).credentials.scrub.push("OTHER");
    assert.equal(claudeCode(REQUEST).credentials.scrub.includes("OTHER"), false);
  });
});

describe("the Launcher runs the plan it is handed", () => {
  const given = {
    ...claudeCode(REQUEST),
    identity: { name: "other", displayName: "Other CLI", version: "9.9.9", major: 9 },
    installLayer: { env: ["OTHER=1"], run: ["install other"] },
    launch: { argv: ["other", "do it"], stdin: { file: "/in/task.md" }, files: [], env: [] },
    stops: { turnCap: { stderrPattern: "^out of turns" } },
    transcript: { path: "/agent-kit/logs/other.jsonl" },
  };
  const script = (plan) =>
    agentScript({ plan, report: "/agent-kit/out/report.md", workspace: "/workspace" });

  it("layers the plan's install layer on the base image", () => {
    assert.equal(
      layerDockerfile("node:22", given.installLayer),
      "FROM node:22\nENV OTHER=1\nRUN install other\n",
    );
  });

  it("runs the plan's command on its stdin file, into its transcript, with its turn marker", () => {
    const text = script(given);
    assert.ok(
      text.includes("{ other 'do it' < /in/task.md 2>&1 > /agent-kit/logs/other.jsonl || "),
      text,
    );
    assert.ok(
      text.includes(
        "if grep -q '^out of turns' /agent-kit/logs/agent.err; then echo 'agent-kit-deep-scan: Other CLI reached its turn limit'; fi",
      ),
      text,
    );
    assert.doesNotMatch(text, /claude/i);
  });

  it("looks for no turn marker where the plan reports no turn cap", () => {
    assert.doesNotMatch(script({ ...given, stops: { turnCap: null } }), /grep|turn limit/);
  });
});
