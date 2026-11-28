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

  it("refuses a line continuation outside single quotes", () => {
    // The shell deletes a backslash-newline outside single quotes, inside
    // double quotes too, so the words on either side join into one.
    for (const command of [
      "git commit --fi\\\nle=/proc/self/environ",
      'git commit "--fi\\\nle=/proc/self/environ"',
      "git commit --fi\\\nle /proc/self/environ",
      "git add --pathspec-from\\\n-file=/proc/self/environ",
      "git rm --pathspec\\\n-from-file=/proc/self/environ",
      "git commit -\\\nF /proc/self/environ",
      "git commit --tem\\\nplate=/proc/self/environ",
      'git commit "--tem\\\nplate=/proc/self/environ"',
      "gi\\\nt commit -F /proc/self/environ",
      "g\\\nit -c core.pager=x status",
      "git commit -m 'x' \\\n  -m 'y'",
      'git commit -m "a\\\nb"',
    ]) {
      assert.match(decideBash(bash(command)) ?? "", /line continuation/, JSON.stringify(command));
    }
  });

  it("judges every word that names git, after a wrapper and its options", () => {
    for (const command of [
      "env -u git git commit -F /proc/self/environ",
      "env -u git git commit --file=/proc/self/environ",
      "env -u git git add --pathspec-from-file=/proc/self/environ",
      "env -u git git rm --pathspec-from-file=/proc/self/environ",
      "env -u git git status --pathspec-from-file=/proc/self/environ",
      "env -u git git commit -t /proc/self/environ",
      "timeout -s git 5 git commit -F /proc/self/environ",
      "env -u /usr/bin/git /usr/bin/git commit -F /proc/self/environ",
      "env -u git git -c core.pager=x status",
      "env -u git GIT_DIR=/tmp/x git status",
    ]) {
      assert.match(
        decideBash(bash(command)) ?? "",
        /reads a file|global options|assignment/,
        command,
      );
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
      // Inside single quotes a backslash-newline stays as written.
      "git commit -m 'a\\\nb'",
      "git commit -m 'subject' -m 'first paragraph' -m 'second paragraph'",
      "git commit -m 'fix: x'\ngit status",
      "git add git",
      "git rm -r src/git",
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
    for (const workflow of [
      ".github/workflows/agent-implement-reusable.yml",
      ".github/workflows/agent-review-response-reusable.yml",
    ]) {
      const text = readRepo(workflow);
      assert.ok(
        text.includes("git commit -F /proc/self/environ"),
        `${workflow}: staging must probe the Bash guard with a file-reading commit`,
      );
      assert.ok(
        text.includes("The staged Bash guard did not refuse a commit that reads a file."),
        workflow,
      );
      // The probe sends the JSON escape \\\n: a backslash, then a newline.
      assert.ok(
        text.includes(String.raw`git commit --fi\\\nle=/proc/self/environ`),
        `${workflow}: staging must probe the Bash guard with a split option`,
      );
      assert.ok(
        text.includes("The staged Bash guard did not refuse a line continuation."),
        workflow,
      );
    }
  });

  it("refuses the split-option probe the workflows send", () => {
    const probe = JSON.parse(
      String.raw`{"tool_name":"Bash","tool_input":{"command":"git commit --fi\\\nle=/proc/self/environ"}}`,
    );
    assert.match(decideBash(probe) ?? "", /line continuation/);
  });
});
