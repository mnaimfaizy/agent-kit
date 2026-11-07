// Contract for the implementer's Bash guard. claude-code-action grants the
// implementer `git add`, `git commit`, and `git rm` by command prefix, so the
// rule allows any arguments. Some read a file the agent names (`-F`,
// `--template`, `--pathspec-from-file`), and shell expansion in an argument
// (`"$VAR"`, `$(...)`, `<file`) puts a secret from the agent's environment or a
// runner file into a commit message or an error the agent can copy out. The
// staged Bash hook refuses those before the command runs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decideBash } from "../.github/agent-runtime/guard-implementer-push.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

describe("implementer Bash guard", () => {
  it("refuses git options that read a file", () => {
    for (const command of [
      "git commit -F /proc/self/environ",
      "git commit -F/proc/self/environ",
      "git commit -aF /proc/self/environ",
      "git commit --file=/etc/passwd",
      "git commit --file /etc/passwd",
      "git commit --fil=/etc/passwd",
      "git commit -t /etc/passwd",
      "git commit --template /etc/passwd",
      "git commit --templ=/etc/passwd",
      "git commit -m 'x' -F .git/config",
      "git add --pathspec-from-file=/proc/self/environ",
      "git rm --pathspec-from-file /proc/self/environ",
      "git commit --pathspec-from=/proc/self/environ",
      "git status --pathspec-from-file=/etc/passwd",
      "git commit -m 'x'; git add --pathspec-from-file=/etc/passwd",
      "{ git commit -F /etc/passwd; }",
      "/usr/bin/git commit -F /etc/passwd",
    ]) {
      assert.match(decideBash(bash(command)) ?? "", /reads a file/, command);
    }
  });

  it("refuses shell expansion and input redirection outside single quotes", () => {
    for (const command of [
      'git commit -m "$CLAUDE_CODE_OAUTH_TOKEN"',
      "git commit -m $GITHUB_TOKEN",
      'git commit -m "${ACTIONS_ID_TOKEN_REQUEST_TOKEN}"',
      "git commit -m `id`",
      'git commit -m "$(cat /proc/self/environ)"',
      "git commit -m \"$(cat <<'EOF'\nfix: x\nEOF\n)\"",
      "git commit -F - < /proc/self/environ",
      'gh pr view "$GITHUB_TOKEN"',
      "uv run pytest $PYTEST_ADDOPTS",
    ]) {
      assert.match(decideBash(bash(command)) ?? "", /single-quoted/, command);
    }
  });

  it("refuses git global options and environment assignments", () => {
    for (const command of [
      "git -c core.pager=x status",
      "git -C /tmp status",
      "git --git-dir=/tmp/x commit -m 'x'",
      "GIT_DIR=/tmp/x git status",
      "FOO=1 git commit -m 'x'",
    ]) {
      assert.match(decideBash(bash(command)) ?? "", /global options|assignment/, command);
    }
  });

  it("refuses what it cannot parse", () => {
    for (const command of ["git commit -m 'unclosed", 'git commit -m "unclosed']) {
      assert.match(decideBash(bash(command)) ?? "", /cannot be parsed/, command);
    }
  });

  it("allows the commands the implementer needs", () => {
    for (const command of [
      "git status",
      "git status --porcelain",
      "git add -A",
      "git add src/a.ts docs/b.md",
      "git add -- src/a.ts",
      "git rm old.txt",
      "git commit -m 'feat: add x'",
      'git commit -m "fix: y"',
      "git commit -am 'x'",
      "git commit -m 'subject' -m 'body that mentions -F and --file'",
      'git commit -m "-F only looks like a flag"',
      "git commit --message='-t also' --no-verify",
      'git commit -m "it\'s \\"quoted\\""',
      "git commit -m 'x' 2>&1",
      "gh pr view 12 --json title",
      "uv run pytest -q",
      "npx prettier --check .",
      "/home/runner/work/_actions/anthropics/claude-code-action/abc/scripts/git-push.sh origin HEAD",
    ]) {
      assert.equal(decideBash(bash(command)), null, command);
    }
  });

  it("ignores other tools and empty input", () => {
    assert.equal(decideBash({ tool_name: "Write", tool_input: { file_path: "$X" } }), null);
    assert.equal(decideBash(bash("")), null);
    assert.equal(decideBash({}), null);
  });

  it("is probed in staging before the agent starts", () => {
    const implement = readRepo(".github/workflows/agent-implement-reusable.yml");
    assert.ok(
      implement.includes("git commit -F /proc/self/environ"),
      "staging must probe the Bash guard with a file-reading commit",
    );
    assert.ok(
      implement.includes("The staged Bash guard did not refuse a commit that reads a file."),
    );
  });
});
