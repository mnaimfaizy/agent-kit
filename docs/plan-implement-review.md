# Plan-implement-review First-class flow

This runbook documents the reusable plan -> implement -> review flow. Setup steps: [Getting started](getting-started.md). Every input and secret: [reference.md](reference.md#plan).

## How a change flows

1. A human adds `agent:plan` to an issue. The plan job writes a plan and posts it as a comment that starts with the planner marker, authored by the job token (`github-actions[bot]`). That comment is the **Verified plan**.
2. A human reads it and adds `agent:implement`. The implement job extracts only the Verified plan, runs the Caller's `setup_commands`, lets the agent change code under a deny-by-default tool list, and opens a **draft** PR as the Claude GitHub App. A separate read-only job checks out the agent's branch and runs `setup_commands` and `verify_commands` there.
3. A human adds `agent:review` to the PR. The review job restores its runtime from the PR base, reviews on three axes, and comments. It never pushes, approves, or merges.

Each stage consumes its label, so re-adding the label re-runs the stage. Humans decide every transition. After review, [Review response](review-response.md) answers the review's findings: on its own label, or, in its auto mode, handed off by the review.

## Reusable jobs

- `.github/workflows/agent-plan-reusable.yml`
- `.github/workflows/agent-implement-reusable.yml`
- `.github/workflows/agent-review-reusable.yml`

Caller example: `examples/plan-implement-review-caller.yml`

## Required gates

Every job enforces:

- kill switch
- allowlist (when configured)
- consume trigger label so the run cannot loop

Caller workflows should trigger plan and implement on `issues.labeled`, and review on `pull_request.labeled` (or manual dispatch), not issue create.

Issue and PR text is untrusted and fenced as data.

## Verified plan contract

Implement reads only a Verified plan comment that:

- starts with the trusted marker
- is authored by the trusted bot login
- is extracted to `verified-plan.md` for this run only

`verified-plan.md` is removed and must not be committed.

## Implementer contract

- implement only from Verified plan
- open a draft PR, or post exact `gh` error plus compare link
- no merge, approve, or mark-ready actions
- no edits to `.github/workflows` or `.github/actions/`; the full list of limits is in [Agent limits](#agent-limits)
- verify commands are caller-owned inputs
- branch naming is caller-owned: `branch_prefix` (default `claude/`, at most 24 characters) and `branch_name_template` (must contain `{{entityNumber}}`; a re-run whose name already exists falls back to default naming), checked before the agent runs

## Reviewer contract

- on-demand review of a pull request (`pr_number`, `head_sha`, `base_sha`, `base_ref`)
- report three axes: Standards, Spec, Correctness
- Spec axis uses a Verified plan when the PR (or `issue_number`) names one
- without a Verified plan, the Spec axis uses the latest issue comment that starts with `<!-- agent-kit-brief -->` and is written by a login in `trusted_spec_authors` (empty by default, which turns this off; logins match exactly, and an invalid value fails the review); a triage agent brief can carry the marker to become the spec
- no push or product execution, no auto-fix
- fork pull requests are a no-op; do not switch the Caller to `pull_request_target`
- the review Caller's job grants `actions: write` (with `contents: read`, `issues: read`, `pull-requests: write`) for the `handoff` job, which runs only when `response_mode` is `auto`; see [Review response](review-response.md#auto-mode)

## Agent limits

What each agent can change, read and run. "Cannot" means a deny rule, a hook or a tool that is not granted stops it, not that the agent is asked to avoid it. Each row names the file to update if the limit changes.

| Agent                                                                             | Can edit                                                                                                                     | Cannot edit                                                                                                                                                                                                                                                                                                                    | Can run                                                                                                                                                                                                                                                                                                 | When a task needs more                                                                                                                       |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plan** (`agent-plan-reusable.yml`)                                              | Writes files in its own checkout with `Write`. Nothing is pushed; only the plan is published, as the issue comment.          | `.claude/`, `.mcp.json`, `.github/agent-runtime/`.                                                                                                                                                                                                                                                                             | `Read`, `Glob`, `Grep` (inside the workspace, never `.git`) and `Write`. No Bash, no subagents. Uses the job token.                                                                                                                                                                                     | It only writes a plan. A human decides what comes next.                                                                                      |
| **Implement** (`agent-implement-reusable.yml`, `confine-writes-to-worktree.mjs`)  | Ordinary source files, `CLAUDE.md`, `AGENTS.md`, `.claude/skills/` and other `.claude/` files except the two settings files. | `.github/workflows/`, `.github/actions/`, `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, anything under `.git/`, and anything outside the working tree. Paths are judged with symlinks resolved; a dangling symlink is refused.                                                                          | `git status`, `gh pr view`, the action's `git add`, `commit`, `rm` and push wrapper, the GitHub MCP `create_pull_request` tool, and the Caller's `extra_allowed_tools`. Not `gh pr create`, `git diff`, `git log` or `git show`. Commands with `$`, backticks or `<` outside single quotes are refused. | A plan that needs a workflow change: it skips those files and says so in the PR body. A denied command is not retried; the comment notes it. |
| **Review** (`agent-review-reusable.yml`)                                          | Nothing. `Edit` and `Write` are not granted, and it never pushes. The job token reads contents and comments.                 | Everything: it is not granted an edit or push tool.                                                                                                                                                                                                                                                                            | `Read`, `Glob`, `Grep`, subagents, `gh pr diff`, `gh pr view` and the inline-comment tool. Not `gh pr comment`, `git diff`, `git log` or `git show`; the diff and log are precomputed into its brief.                                                                                                   | It reports a finding. No auto-fix.                                                                                                           |
| **Review response** (`agent-review-response-reusable.yml`, `review-response.mjs`) | Files in the working tree. It commits; the separate `publish` job pushes.                                                    | `.github/workflows/` (denied). Protected paths are not blocked at the edit: a commit to one fails validation in `publish` and none of the round's commits are pushed; see [Refusals and protected paths](review-response.md#refusals-and-protected-paths). A pull request that already changes a protected path gets no round. | `git status`, `git add`, `git commit`, `git rev-parse HEAD`, and the Caller's checks as one staged script. Not push, `gh`, `git diff`, `git log`, `git show`, web access or subagents.                                                                                                                  | The finding is declined with a reply.                                                                                                        |
| **Security audit** (`security-audit-reusable.yml`)                                | Writes its report in its own checkout with `Write`. Nothing is pushed; later, staged steps publish the report.               | `.claude/`, `.mcp.json`, `.github/agent-runtime/`.                                                                                                                                                                                                                                                                             | `Read`, `Glob`, `Grep` (inside the workspace, never `.git`) and `Write`. No Bash, no subagents.                                                                                                                                                                                                         | It reports what it found.                                                                                                                    |

Permission rules and hooks the Consumer commits to `.claude/settings.json` apply to every agent, on top of these grants.

The implementer's push is also checked: a branch that changes `.github/workflows/` or `.github/actions/` is refused before the push, even if a tool added through `extra_allowed_tools` wrote the file. The push must run as its own command. Code run through `extra_allowed_tools` is outside the Bash checks above.

### Two protected lists

The implementer and Review response protect different files. The implementer **can** edit `CLAUDE.md`, `AGENTS.md` and `.claude/skills/`, and Review response refuses all of them at its gate. They differ because the implementer works from a Verified plan a human approved, while Review response would take its instructions from the change under review. See [Review response](security-model.md#review-response) and [Refusals and protected paths](review-response.md#refusals-and-protected-paths).

### Issues that need a workflow change

An issue that needs a change under `.github/workflows/` or `.github/actions/` needs a human. Give it `ready-for-human` rather than `agent:implement`. If the implementer gets one anyway, it skips the workflow files and says so in the PR body; for `.github/actions/`, the edit deny and the push check are what stop it.

The reasons for each limit: [Workflow controls](security-model.md#workflow-controls).

## Runner controls

Plan, implement, review, and audit load `.github/agent-runtime/` from the Consumer checkout, stage it to `$RUNNER_TEMP`, and run the staged copy. A PreToolUse hook denies Read/Grep/Glob paths outside the workspace. Copy that directory from the same tag as the workflow pin: a job refuses a settings file that runs the hook from the workspace.

Checkouts set `persist-credentials: false`. Plan, review, and audit pass the job token into the Claude action. The implementer does not: a pull request opened with the job token does not start CI, so that job uses the Claude GitHub App and needs `id-token: write`.

The implement job starts GitHub's MCP server as a Docker container, so the runner needs Docker (GitHub-hosted `ubuntu-latest` has it). The agent opens the draft PR through that server as the Claude GitHub App, so CI starts on it. If the agent did not open one (for example, the server could not start), the workflow's own draft-PR step opens the PR with the job token instead, and CI does not start until the branch is pushed again.

`anthropics/claude-code-action` is pinned to a commit SHA. The implementer tool list is deny-by-default; package-manager rules belong in `extra_allowed_tools`, and toolchain install belongs in `setup_commands`.
