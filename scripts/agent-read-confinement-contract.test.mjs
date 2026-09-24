// Contract for the read-confinement PreToolUse hook. An allowlist entry only
// pre-approves a call and cannot revoke the action's base Read/Glob/Grep grant,
// so confinement has to be a deny decision on the resolved path.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "../.github/agent-runtime/confine-reads-to-workspace.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");

const SETTINGS_PATH = ".github/agent-runtime/read-confinement.settings.json";
// The hook runs from a read-only copy outside the workspace: a copy in the
// workspace is one an agent holding Write could replace mid-session.
const STAGED_DIR = "$RUNNER_TEMP/read-confinement";
const STAGED_SETTINGS = "${{ runner.temp }}/read-confinement/read-confinement.settings.json";
const STAGE_STEP = "Stage read-confinement hook outside the workspace";
const VERIFY_STEP = "Verify read-confinement hook unchanged";

// `publish` is the first later step that sends agent output anywhere or runs
// agent-written code; the digest check must run before it. `denyRuntimeEdits`
// marks agents that hold Write but have no reason to edit .github/agent-runtime;
// the implementer may be asked to change it, and runs the staged copy anyway.
const CONFINED_AGENT_STEPS = [
  {
    workflow: "agent-plan-reusable.yml",
    step: "Run planner (Claude Code)",
    publish: "Post trusted plan comment",
    denyRuntimeEdits: true,
  },
  {
    workflow: "agent-implement-reusable.yml",
    step: "Run implementer (Claude Code)",
    publish: "Run caller-owned verify commands",
    denyRuntimeEdits: false,
  },
  {
    workflow: "agent-review-reusable.yml",
    step: "Run code review (Claude Code)",
    denyRuntimeEdits: false,
  },
  {
    workflow: "security-audit-reusable.yml",
    step: "Run security audit (Claude Code)",
    publish: "Publish draft GHSA (required private delivery)",
    denyRuntimeEdits: true,
  },
];

const RESTORE_STEPS = [
  {
    workflow: "agent-review-reusable.yml",
    step: "Restore trusted review runtime from PR base",
  },
  {
    workflow: "security-audit-reusable.yml",
    step: "Restore trusted audit runtime from PR base",
  },
];

function namedStep(yml, name) {
  const marker = `- name: ${name}\n`;
  const start = yml.indexOf(marker);
  assert.ok(start >= 0, `missing step ${name}`);
  const rest = yml.slice(start + marker.length);
  const next = rest.search(/\n {6}- /);
  return next < 0 ? rest : rest.slice(0, next);
}

const workflow = (name) => readRepo(".github", "workflows", name);

describe("agent read-confinement hook contract", () => {
  it("decides allow inside the workspace and deny outside it", () => {
    const ws = "/home/runner/work/repo/repo";
    const allow = [
      { tool_name: "Read", tool_input: { file_path: "src/main.rs" } },
      { tool_name: "Read", tool_input: { file_path: "./agent-plan.md" } },
      { tool_name: "Grep", tool_input: { pattern: "x", path: "src" } },
      { tool_name: "Grep", tool_input: { pattern: "x" } },
      { tool_name: "Glob", tool_input: { pattern: "*", path: "." } },
      { tool_name: "Bash", tool_input: { command: "cat /etc/hostname" } },
    ];
    for (const payload of allow) {
      assert.equal(decide(payload, ws), null, JSON.stringify(payload));
    }

    const deny = [
      { tool_name: "Read", tool_input: { file_path: "/etc/hostname" } },
      { tool_name: "Read", tool_input: { file_path: "/proc/self/environ" } },
      { tool_name: "Read", tool_input: { file_path: "../../../etc/passwd" } },
      { tool_name: "Grep", tool_input: { pattern: "x", path: "/root/.ssh" } },
      { tool_name: "Glob", tool_input: { pattern: "*", path: "/home/runner" } },
      {
        tool_name: "Read",
        tool_input: { file_path: "/home/runner/work/repo/repo-evil/x" },
      },
    ];
    for (const payload of deny) {
      const reason = decide(payload, ws);
      assert.ok(reason, `expected a deny for ${JSON.stringify(payload)}`);
      assert.match(reason, /outside GITHUB_WORKSPACE/);
    }
  });

  it("fails closed when the workspace is unset, and stays silent on nothing to judge", () => {
    const call = {
      tool_name: "Read",
      tool_input: { file_path: "/etc/hostname" },
    };
    assert.match(decide(call, ""), /GITHUB_WORKSPACE is unset/);
    assert.match(decide(call, undefined), /GITHUB_WORKSPACE is unset/);
    assert.equal(decide({}, "/ws"), null);
    assert.equal(decide({ tool_name: "Read", tool_input: {} }, "/ws"), null);
    assert.equal(decide(null, "/ws"), null);
  });

  describe("symlinks in the checkout", () => {
    // A real tree on disk: the workspace, and a sibling it must not reach.
    let scratch;
    let ws;
    const read = (file_path) => ({ tool_name: "Read", tool_input: { file_path } });
    const grep = (path) => ({ tool_name: "Grep", tool_input: { pattern: "x", path } });

    before(() => {
      scratch = mkdtempSync(join(tmpdir(), "read-confinement-"));
      ws = join(scratch, "ws");
      const outside = join(scratch, "outside");
      mkdirSync(join(ws, "docs"), { recursive: true });
      mkdirSync(join(ws, "nest"), { recursive: true });
      mkdirSync(join(outside, "deeper"), { recursive: true });
      writeFileSync(join(ws, "docs", "readme.md"), "in tree\n");
      writeFileSync(join(outside, "secret.txt"), "out of tree\n");

      symlinkSync(join(outside, "secret.txt"), join(ws, "file-link"), "file");
      symlinkSync(outside, join(ws, "dir-link"), "dir");
      symlinkSync(join(outside, "deeper"), join(ws, "nest", "up"), "dir");
      symlinkSync(join(ws, "docs"), join(ws, "docs-link"), "dir");
    });

    after(() => rmSync(scratch, { recursive: true, force: true }));

    it("denies a path inside the tree that resolves outside it", () => {
      for (const payload of [
        read("file-link"),
        read("dir-link/secret.txt"),
        read(join(ws, "dir-link", "secret.txt")),
        grep("dir-link"),
      ]) {
        assert.match(
          decide(payload, ws) ?? "",
          /resolves outside GITHUB_WORKSPACE/,
          JSON.stringify(payload),
        );
      }
    });

    it(
      "resolves `..` after a link from the link's target, as the kernel does",
      { skip: process.platform === "win32" && "Win32 paths collapse `..` lexically" },
      () => {
        // Lexically this is nest/secret.txt, inside the tree.
        assert.match(
          decide(read("nest/up/../secret.txt"), ws) ?? "",
          /resolves outside GITHUB_WORKSPACE/,
        );
      },
    );

    it("allows a link that stays inside the tree, and a path that does not exist", () => {
      assert.equal(decide(read("docs-link/readme.md"), ws), null);
      assert.equal(decide(read("docs/readme.md"), ws), null);
      assert.equal(decide(read("docs/missing.md"), ws), null);
      assert.equal(decide(grep("docs-link"), ws), null);
    });
  });

  it("registers the hook for exactly the read tools, run through node", () => {
    const settings = JSON.parse(readRepo(SETTINGS_PATH));
    const entries = settings.hooks?.PreToolUse ?? [];
    assert.equal(entries.length, 1, "expected one PreToolUse hook group");

    const [group] = entries;
    assert.deepEqual(group.matcher.split("|").sort(), ["Glob", "Grep", "Read"]);
    const command = group.hooks.map((hook) => hook.command).join("\n");
    assert.match(command, /^node /, "hook must run through node, not jq/bash");
    assert.ok(
      command.includes(`"${STAGED_DIR}/confine-reads-to-workspace.mjs"`),
      "hook must run the staged copy under $RUNNER_TEMP",
    );
    assert.doesNotMatch(command, /CLAUDE_PROJECT_DIR|GITHUB_WORKSPACE/);
  });

  it("loads the staged hook into every confined agent step", () => {
    for (const { workflow: name, step } of CONFINED_AGENT_STEPS) {
      const agent = namedStep(workflow(name), step);
      assert.ok(
        agent.includes(`settings: ${STAGED_SETTINGS}\n`),
        `${step} must pass the staged read-confinement settings`,
      );
    }
  });

  it("stages the hook read-only outside the workspace and checks it after the agent", () => {
    for (const { workflow: name, step, publish } of CONFINED_AGENT_STEPS) {
      const yml = workflow(name);
      const stage = namedStep(yml, STAGE_STEP);
      assert.match(stage, /id: confine\n/);
      assert.ok(stage.includes(`STAGED="${STAGED_DIR}"`), `${name}: stage to ${STAGED_DIR}`);
      assert.ok(
        stage.includes(`grep -qF '${STAGED_DIR}/confine-reads-to-workspace.mjs'`),
        `${name}: refuse settings that run the hook from the workspace`,
      );
      assert.ok(stage.includes('chmod 444 "$STAGED"/*'), `${name}: stage read-only`);
      assert.match(stage, /hook_sha256=/);

      const verify = namedStep(yml, VERIFY_STEP);
      assert.match(verify, /steps\.confine\.outputs\.hook_sha256/);
      assert.match(verify, /exit 1/);

      const at = (s) => yml.indexOf(`- name: ${s}\n`);
      assert.ok(at(STAGE_STEP) < at(step), `${name}: stage before the agent`);
      assert.ok(at(step) < at(VERIFY_STEP), `${name}: verify after the agent`);
      if (publish) {
        assert.ok(at(VERIFY_STEP) < at(publish), `${name}: verify before ${publish}`);
      }
    }
  });

  it("denies .git reads to every confined agent, and runtime edits where none is needed", () => {
    for (const { workflow: name, step, denyRuntimeEdits } of CONFINED_AGENT_STEPS) {
      const agent = namedStep(workflow(name), step);
      const denied = agent.split('--disallowedTools "')[1].split('"')[0].split(",");
      assert.ok(denied.includes("Read(./.git/**)"), `${name}: deny .git reads`);
      if (denyRuntimeEdits) {
        assert.ok(
          denied.includes("Edit(./.github/agent-runtime/**)"),
          `${name}: an agent holding Write must not edit .github/agent-runtime`,
        );
      }
    }
  });

  it("restores the hook from the base before an untrusted-code agent runs", () => {
    for (const { workflow: name, step } of RESTORE_STEPS) {
      const restore = namedStep(workflow(name), step);
      assert.match(
        restore,
        /\.github\/agent-runtime\b/,
        `${step} must restore .github/agent-runtime`,
      );
    }
  });
});
