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
const HOOK_PATH = ".github/agent-runtime/confine-reads-to-workspace.mjs";

const CONFINED_AGENT_STEPS = [
  { workflow: "agent-plan-reusable.yml", step: "Run planner (Claude Code)" },
  { workflow: "agent-review-reusable.yml", step: "Run code review (Claude Code)" },
  {
    workflow: "security-audit-reusable.yml",
    step: "Run security audit (Claude Code)",
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
    assert.match(command, new RegExp(HOOK_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(command, /\$CLAUDE_PROJECT_DIR/);
  });

  it("loads the hook into every confined agent step", () => {
    for (const { workflow: name, step } of CONFINED_AGENT_STEPS) {
      const agent = namedStep(workflow(name), step);
      assert.match(
        agent,
        new RegExp(`settings:\\s*${SETTINGS_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        `${step} must pass the read-confinement settings`,
      );
    }
  });

  it("does not load the hook into the implementer", () => {
    const step = namedStep(
      workflow("agent-implement-reusable.yml"),
      "Run implementer (Claude Code)",
    );
    assert.doesNotMatch(step, /read-confinement\.settings\.json/);
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
