// Contract for keeping the implementer away from git's own configuration. git
// runs commands that its config, or a hook in .git/hooks, names. The
// implementer holds Write and the Claude GitHub App token, and the action's
// commit and push plumbing, the push guard, and the checks after the agent all
// run git in its checkout. So the implementer cannot write inside .git or
// outside the workspace, and git configuration is checked against an allowlist
// before each credentialed git call that is not the agent's own.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { checkGitDir, unexpectedConfigNames } from "../.github/agent-runtime/check-git-config.mjs";
import { decideWrite } from "../.github/agent-runtime/confine-writes-to-worktree.mjs";
import { GIT_HARDENING } from "../.github/agent-runtime/guard-implementer-push.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const IMPLEMENT = ".github/workflows/agent-implement-reusable.yml";
const WRITE_HOOK = 'node "$RUNNER_TEMP/read-confinement/confine-writes-to-worktree.mjs" || exit 2';

function namedStep(yml, name) {
  const start = yml.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `step "${name}" not found`);
  const next = yml.indexOf("\n      - name: ", start + 1);
  const jobEnd = yml.indexOf("\n  verify:\n", start);
  const ends = [next, jobEnd].filter((i) => i > start);
  return yml.slice(start, ends.length ? Math.min(...ends) : undefined);
}

const write = (file_path) => ({ tool_name: "Write", tool_input: { file_path } });

describe("implementer write confinement", () => {
  const ws = "/home/runner/work/repo/repo";

  it("refuses writes inside .git, anywhere in the tree", () => {
    for (const payload of [
      write(".git/config"),
      write("./.git/hooks/pre-push"),
      write(`${ws}/.git/info/attributes`),
      write("sub/.git/config"),
      write("src/../.git/config"),
      { tool_name: "Edit", tool_input: { file_path: ".git/config" } },
      { tool_name: "MultiEdit", tool_input: { file_path: ".git/config" } },
      { tool_name: "NotebookEdit", tool_input: { notebook_path: ".git/x.ipynb" } },
    ]) {
      assert.match(decideWrite(payload, ws) ?? "", /inside \.git/, JSON.stringify(payload));
    }
  });

  it("refuses writes outside the workspace", () => {
    for (const target of [
      "/home/runner/.gitconfig",
      "/home/runner/.config/git/config",
      "../other/file",
      "/tmp/x",
      `${ws}-evil/x`,
    ]) {
      assert.match(decideWrite(write(target), ws) ?? "", /outside GITHUB_WORKSPACE/, target);
    }
  });

  it("ignores other tools and fails closed without a workspace", () => {
    assert.equal(decideWrite({ tool_name: "Read", tool_input: { file_path: "/etc/x" } }, ws), null);
    assert.equal(decideWrite({ tool_name: "Bash", tool_input: { command: "x" } }, ws), null);
    assert.match(decideWrite(write("a.txt"), "") ?? "", /GITHUB_WORKSPACE is unset/);
  });

  describe("on disk", () => {
    let dir;
    let linked = true;
    before(() => {
      dir = mkdtempSync(join(tmpdir(), "write-confine-"));
      mkdirSync(join(dir, ".git"));
      mkdirSync(join(dir, "src"));
      try {
        symlinkSync(join(dir, ".git"), join(dir, "git-link"), "dir");
        symlinkSync(tmpdir(), join(dir, "out-link"), "dir");
        symlinkSync(join(tmpdir(), "no-such-target-xyz"), join(dir, "dangling"));
      } catch {
        linked = false;
      }
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("refuses a link that leads into .git or out of the tree, and a dangling link", (t) => {
      if (!linked) return t.skip("symlinks unavailable on this machine");
      assert.match(decideWrite(write("git-link/config"), dir) ?? "", /resolves inside \.git/);
      assert.match(decideWrite(write("out-link/new.txt"), dir) ?? "", /resolves outside/);
      assert.match(
        decideWrite(write("dangling"), dir) ?? "",
        /resolves outside|cannot be resolved/,
      );
    });

    it("allows ordinary edits, including names that only start with .git", () => {
      for (const target of [
        "src/a.ts",
        "src/new/dir/file.ts",
        ".gitignore",
        ".gitattributes",
        ".github/CODEOWNERS",
        "a/.gitkeep",
      ]) {
        assert.equal(decideWrite(write(target), dir), null, target);
      }
    });

    it("fails closed when the workspace does not exist", () => {
      assert.match(decideWrite(write("a.txt"), join(dir, "missing")) ?? "", /cannot be resolved/);
    });
  });
});

describe("git configuration allowlist", () => {
  it("accepts what checkout and the action write", () => {
    const names = [
      "core.repositoryformatversion",
      "core.filemode",
      "core.bare",
      "core.logallrefupdates",
      "gc.auto",
      "remote.origin.url",
      "remote.origin.fetch",
      "branch.main.remote",
      "branch.main.merge",
      "branch.claude/issue-7.x.remote",
      "user.name",
      "user.email",
    ];
    assert.deepEqual(unexpectedConfigNames(names), []);
  });

  it("refuses any key that can name a command or pull in more config", () => {
    for (const name of [
      "core.fsmonitor",
      "core.hookspath",
      "core.sshcommand",
      "core.pager",
      "core.alternaterefscommand",
      "include.path",
      "includeif.gitdir:/x/.path",
      "credential.helper",
      "diff.external",
      "diff.x.textconv",
      "filter.x.clean",
      "alias.st",
      "remote.origin.uploadpack",
      "remote.evil.url",
      "extensions.worktreeconfig",
      "protocol.allow",
    ]) {
      assert.deepEqual(unexpectedConfigNames([name]), [name], name);
    }
  });

  describe("on a real repository", () => {
    let dir;
    const git = (...args) =>
      execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    before(() => {
      dir = mkdtempSync(join(tmpdir(), "git-config-check-"));
      git("init", "-q");
      git("config", "user.name", "x");
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("passes a fresh repository and fails one with an unexpected key or hook", () => {
      const gitDir = join(dir, ".git");
      assert.deepEqual(checkGitDir(gitDir), []);

      git("config", "core.fsmonitor", "true");
      assert.match(checkGitDir(gitDir).join("\n"), /core\.fsmonitor/);
      git("config", "--unset", "core.fsmonitor");
      assert.deepEqual(checkGitDir(gitDir), []);

      writeFileSync(join(gitDir, "hooks", "pre-push"), "#!/bin/sh\n");
      assert.match(checkGitDir(gitDir).join("\n"), /hooks\/pre-push/);
      rmSync(join(gitDir, "hooks", "pre-push"));
      assert.deepEqual(checkGitDir(gitDir), []);
    });

    it("fails closed when the config cannot be read", () => {
      assert.notDeepEqual(checkGitDir(join(dir, "missing")), []);
    });

    it("exits non-zero from the command line on an unexpected key", () => {
      const script = join(root, ".github/agent-runtime/check-git-config.mjs");
      const staged = mkdtempSync(join(tmpdir(), "staged-check-"));
      try {
        copyFileSync(script, join(staged, "check-git-config.mjs"));
        const run = () =>
          spawnSync(process.execPath, [join(staged, "check-git-config.mjs"), join(dir, ".git")], {
            encoding: "utf8",
          });
        assert.equal(run().status, 0);
        git("config", "credential.helper", "x");
        const result = run();
        assert.equal(result.status, 1);
        assert.match(result.stdout + result.stderr, /credential\.helper/);
      } finally {
        git("config", "--unset", "credential.helper");
        rmSync(staged, { recursive: true, force: true });
      }
    });
  });
});

describe("implement workflow wiring", () => {
  const implement = readRepo(IMPLEMENT);

  it("denies the implementer edits inside .git", () => {
    const denied = implement.split('--disallowedTools "')[1].split('"')[0].split(",");
    assert.ok(denied.includes("Edit(./.git/**)"), "Edit(./.git/**) not denied");
  });

  it("registers the write hook for every file-writing tool, failing closed", () => {
    const settings = JSON.parse(readRepo(".github/agent-runtime/implementer.settings.json"));
    const group = (settings.hooks?.PreToolUse ?? []).find((g) =>
      g.hooks.some((h) => h.command === WRITE_HOOK),
    );
    assert.ok(group, "implementer settings must run the staged write hook");
    assert.deepEqual(group.matcher.split("|").sort(), [
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Write",
    ]);
  });

  it("stages the write hook and the git config check, and probes both before the agent", () => {
    const stage = namedStep(implement, "Stage read-confinement hook outside the workspace");
    for (const file of ["confine-writes-to-worktree.mjs", "check-git-config.mjs"]) {
      assert.ok(stage.includes(`"$SRC/${file}"`), `staging must copy ${file}`);
    }
    assert.ok(
      stage.includes(
        `grep -qF '$RUNNER_TEMP/read-confinement/confine-writes-to-worktree.mjs\\" || exit 2'`,
      ),
      "staging must refuse settings that run the write hook fail-open",
    );
    assert.ok(
      stage.includes('| node "$STAGED/confine-writes-to-worktree.mjs"'),
      "staging must probe the staged write hook",
    );
    assert.ok(
      stage.includes('node "$STAGED/check-git-config.mjs" "$GITHUB_WORKSPACE/.git"'),
      "staging must check the checkout's git config before the agent",
    );
  });

  it("checks git config after the agent, before any other git call", () => {
    const at = (name) => implement.indexOf(`- name: ${name}\n`);
    const check = namedStep(implement, "Check git configuration after the agent");
    assert.ok(
      check.includes(
        'node "$RUNNER_TEMP/read-confinement/check-git-config.mjs" "$GITHUB_WORKSPACE/.git"',
      ),
    );
    assert.ok(at("Run implementer (Claude Code)") < at("Check git configuration after the agent"));
    assert.match(check, /id: gitconfig\n/);
    // #83: run after a failed agent, but not when the job failed before the
    // hooks were staged (a failed setup_commands, say). Then the agent never
    // ran, the staged checker does not exist, and a failure here would blame
    // the agent for the earlier step.
    assert.match(check, /if: always\(\) && steps\.confine\.outcome == 'success'\n/);
    // Fail closed: if the agent ran, staging succeeded, so the check runs. The
    // agent step and every step between staging and it run only on success.
    const stagingAt = at("Stage read-confinement hook outside the workspace");
    const agentAt = at("Run implementer (Claude Code)");
    assert.ok(stagingAt >= 0 && stagingAt < agentAt);
    const steps = implement.slice(stagingAt, agentAt).split("\n      - name: ");
    assert.ok(steps.length >= 2, "expected steps between staging and the agent");
    for (const step of steps) {
      const condition = /^ {8}if: (.*)$/m.exec(step);
      assert.ok(
        !condition || !/always\(\)|failure\(\)|cancelled\(\)/.test(condition[1]),
        `${step.split("\n")[0]} must run only when staging succeeded`,
      );
    }
    assert.doesNotMatch(namedStep(implement, "Run implementer (Claude Code)"), /\n {8}if: /);
    // continue-on-error would let a failed staging leave the job in success():
    // the agent would run, steps.confine.outcome would be failure, and the
    // check would be skipped.
    assert.doesNotMatch(implement.slice(stagingAt, agentAt), /\n {8}continue-on-error:/);
    // A missing checker names the missing staging, not the agent.
    assert.match(check, /test -s "\$RUNNER_TEMP\/read-confinement\/check-git-config\.mjs"/);
    // The cleanup step runs after a failed agent step, but not past a failed check.
    assert.match(
      namedStep(implement, "Remove extracted plan from tracked state"),
      /if: always\(\) && steps\.gitconfig\.outcome == 'success'\n/,
    );
    for (const later of [
      "Prevent workflow edits by implementer",
      "Remove extracted plan from tracked state",
      "Record the agent's branch",
    ]) {
      assert.ok(at("Check git configuration after the agent") < at(later), later);
      const step = namedStep(implement, later);
      assert.match(step, /GIT_CONFIG_COUNT: "2"/, `${later}: pin git config overrides`);
      assert.match(step, /GIT_CONFIG_KEY_0: core\.fsmonitor/, later);
      assert.match(step, /GIT_CONFIG_KEY_1: core\.hooksPath/, later);
    }
  });

  it("runs the push guard's git with config overrides and the config check", () => {
    assert.deepEqual(GIT_HARDENING, [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
    ]);
    const guard = readRepo(".github/agent-runtime/guard-implementer-push.mjs");
    assert.match(guard, /from "\.\/check-git-config\.mjs"/);
    assert.match(guard, /checkGitDir\(/);
  });
});
