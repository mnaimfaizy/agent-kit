// Contract for the read-confinement PreToolUse hook. An allowlist entry only
// pre-approves a call and cannot revoke the action's base Read/Glob/Grep grant,
// so confinement has to be a deny decision on the resolved path.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
// A hook that crashes is a non-blocking error, not a deny, so the settings run
// it with `|| exit 2`: any failure to decide blocks the call.
const FAIL_CLOSED = " || exit 2";

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
    // Also registers the pre-push guard; see implementer-push-guard-contract.
    settings: "implementer.settings.json",
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

  it("refuses .git for every read tool, and nothing that only starts with .git", () => {
    const ws = "/home/runner/work/repo/repo";
    for (const payload of [
      { tool_name: "Read", tool_input: { file_path: ".git/config" } },
      { tool_name: "Read", tool_input: { file_path: `${ws}/.git/HEAD` } },
      { tool_name: "Grep", tool_input: { pattern: "x", path: ".git" } },
      { tool_name: "Glob", tool_input: { pattern: "*", path: "vendor/lib/.git/hooks" } },
    ]) {
      assert.match(decide(payload, ws) ?? "", /inside \.git/, JSON.stringify(payload));
    }
    for (const file_path of [".gitignore", ".github/workflows/ci.yml", "docs/.git-notes"]) {
      assert.equal(decide({ tool_name: "Read", tool_input: { file_path } }, ws), null, file_path);
    }
  });

  it("judges the Glob pattern, not only its path", () => {
    // Glob resolves an absolute or climbing pattern from the filesystem, not
    // from `path`, so the pattern alone can list names outside the workspace.
    const ws = "/home/runner/work/repo/repo";
    const glob = (pattern, path) => ({
      tool_name: "Glob",
      tool_input: path === undefined ? { pattern } : { pattern, path },
    });
    for (const payload of [
      glob("/home/runner/**"),
      glob("/proc/self/*"),
      glob("C:/Users/*"),
      glob("\\\\server\\share\\*"),
      glob("~/.config/*"),
      glob("../../*"),
      glob("src/../../../etc/*"),
      glob("*", ".."),
      glob("src/*", "/tmp"),
    ]) {
      assert.match(decide(payload, ws) ?? "", /outside GITHUB_WORKSPACE/, JSON.stringify(payload));
    }
    for (const payload of [glob(".git/**"), glob("**/.git/*"), glob("vendor/.git/hooks/*")]) {
      assert.match(decide(payload, ws) ?? "", /inside \.git/, JSON.stringify(payload));
    }
    for (const payload of [
      glob("**/*.md"),
      glob("src/**/*.ts"),
      glob("*.{js,ts}"),
      glob("docs/*", "."),
      glob(".github/workflows/*.yml"),
      glob("**/.gitignore"),
    ]) {
      assert.equal(decide(payload, ws), null, JSON.stringify(payload));
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
      mkdirSync(join(ws, ".git"), { recursive: true });
      writeFileSync(join(ws, ".git", "config"), "[core]\n");
      symlinkSync(join(ws, ".git"), join(ws, "git-link"), "dir");
    });

    it("denies a link inside the tree that resolves into .git", () => {
      assert.match(decide(read("git-link/config"), ws) ?? "", /resolves inside \.git/);
    });

    after(() => rmSync(scratch, { recursive: true, force: true }));

    it("denies a path inside the tree that resolves outside it", () => {
      for (const payload of [
        read("file-link"),
        read("dir-link/secret.txt"),
        read(join(ws, "dir-link", "secret.txt")),
        grep("dir-link"),
        { tool_name: "Glob", tool_input: { pattern: "dir-link/*" } },
        { tool_name: "Glob", tool_input: { pattern: "deeper/*", path: "dir-link" } },
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
      assert.equal(
        decide({ tool_name: "Glob", tool_input: { pattern: "docs-link/*.md" } }, ws),
        null,
      );
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
    assert.equal(
      command,
      `node "${STAGED_DIR}/confine-reads-to-workspace.mjs"${FAIL_CLOSED}`,
      "hook must run the staged copy under $RUNNER_TEMP and fail closed",
    );
    assert.doesNotMatch(command, /CLAUDE_PROJECT_DIR|GITHUB_WORKSPACE/);
  });

  describe("the registered command, run by a shell", () => {
    const command = JSON.parse(readRepo(SETTINGS_PATH)).hooks.PreToolUse[0].hooks[0].command;
    const hook = join(root, ".github/agent-runtime/confine-reads-to-workspace.mjs");
    let temp;
    let staged;
    let hasShell;

    before(() => {
      temp = mkdtempSync(join(tmpdir(), "confine-cmd-"));
      staged = join(temp, "read-confinement", "confine-reads-to-workspace.mjs");
      mkdirSync(join(temp, "read-confinement"));
      mkdirSync(join(temp, "ws"));
      hasShell = !spawnSync("sh", ["-c", "true"]).error;
    });
    after(() => rmSync(temp, { recursive: true, force: true }));

    const run = (payload) =>
      spawnSync("sh", ["-c", command], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: { ...process.env, RUNNER_TEMP: temp, GITHUB_WORKSPACE: join(temp, "ws") },
      });

    it("denies an out-of-tree read with the staged hook", (t) => {
      if (!hasShell) return t.skip("no POSIX sh");
      copyFileSync(hook, staged);
      const result = run({ tool_name: "Read", tool_input: { file_path: "/proc/self/environ" } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /"permissionDecision":"deny"/);
    });

    it("blocks the call when the staged hook cannot run", (t) => {
      if (!hasShell) return t.skip("no POSIX sh");
      writeFileSync(staged, "\u0000 not a module");
      const result = run({ tool_name: "Read", tool_input: { file_path: "README.md" } });
      assert.equal(result.status, 2, "a crashing hook must exit 2, which blocks the call");
    });
  });

  it("loads the staged hook into every confined agent step", () => {
    for (const { workflow: name, step, settings } of CONFINED_AGENT_STEPS) {
      const agent = namedStep(workflow(name), step);
      const staged = settings
        ? STAGED_SETTINGS.replace("read-confinement.settings.json", settings)
        : STAGED_SETTINGS;
      assert.ok(
        agent.includes(`settings: ${staged}\n`),
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
        stage.includes(`grep -qF '${STAGED_DIR}/confine-reads-to-workspace.mjs\\"${FAIL_CLOSED}'`),
        `${name}: refuse settings that run the hook from the workspace or fail open`,
      );
      assert.ok(stage.includes('chmod 444 "$STAGED"/*'), `${name}: stage read-only`);
      assert.match(stage, /hook_sha256=/);
      // A copy that cannot run decides nothing: show the staged hook refuses an
      // out-of-tree read before any agent relies on it.
      const probe = stage.indexOf('| node "$STAGED/confine-reads-to-workspace.mjs"');
      assert.ok(probe > stage.indexOf("chmod 444"), `${name}: probe the staged hook`);
      assert.ok(stage.includes("/proc/self/environ"), `${name}: probe an out-of-tree read`);
      assert.ok(stage.includes(`'"permissionDecision":"deny"'`), `${name}: require a deny`);

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

  it("rewrites the checkout under pinned attributes before restoring", () => {
    // A pull request's .gitattributes decides how git writes files, and
    // checkout has already written them that way; a restore that finds the
    // index unchanged leaves them. Pin the attributes that rewrite content in
    // info/attributes, which outranks the tree, then write the tree again.
    for (const { workflow: name, step } of RESTORE_STEPS) {
      const restore = namedStep(workflow(name), step);
      const pin = restore.indexOf("git rev-parse --git-path info/attributes");
      assert.ok(pin >= 0, `${step} must pin attributes in info/attributes`);
      assert.ok(
        restore.includes("'* -text -eol -working-tree-encoding -filter -ident\\n'"),
        `${step} must unset every content-rewriting attribute`,
      );
      const drop = restore.indexOf("git rm -r -q --cached -- .");
      const rewrite = restore.indexOf("git reset -q --hard HEAD");
      assert.ok(pin < drop && drop < rewrite, `${name}: pin, drop the index, then rewrite`);
      assert.ok(
        rewrite < restore.indexOf('restore_from_base "$path"'),
        `${name}: rewrite before restoring`,
      );
    }
  });
});
