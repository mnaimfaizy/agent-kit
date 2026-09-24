# Plan-implement-review First-class flow

This runbook documents the reusable plan -> implement -> review flow. Setup steps: [Getting started](getting-started.md). Every input and secret: [reference.md](reference.md#plan).

## How a change flows

1. A human adds `agent:plan` to an issue. The plan job writes a plan and posts it as a comment that starts with the planner marker, authored by the job token (`github-actions[bot]`). That comment is the **Verified plan**.
2. A human reads it and adds `agent:implement`. The implement job extracts only the Verified plan, runs the Caller's `setup_commands`, lets the agent change code under a deny-by-default tool list, and opens a **draft** PR as the Claude GitHub App. A separate read-only job checks out the agent's branch and runs `setup_commands` and `verify_commands` there.
3. A human adds `agent:review` to the PR. The review job restores its runtime from the PR base, reviews on three axes, and comments. It never pushes, approves, or merges.

Each stage consumes its label, so re-adding the label re-runs the stage. Humans decide every transition.

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
- no edits to `.github/workflows`
- verify commands are caller-owned inputs

## Reviewer contract

- on-demand review of a pull request (`pr_number`, `head_sha`, `base_sha`, `base_ref`)
- report three axes: Standards, Spec, Correctness
- Spec axis uses a Verified plan when the PR (or `issue_number`) names one
- no push or product execution, no auto-fix
- fork pull requests are a no-op; do not switch the Caller to `pull_request_target`

## Runner controls

Plan, implement, review, and audit load `.github/agent-runtime/` from the Consumer checkout, stage it to `$RUNNER_TEMP`, and run the staged copy. A PreToolUse hook denies Read/Grep/Glob paths outside the workspace. Copy that directory from the same tag as the workflow pin: a job refuses a settings file that runs the hook from the workspace.

Checkouts set `persist-credentials: false`. Plan, review, and audit pass the job token into the Claude action. The implementer does not: a pull request opened with the job token does not start CI, so that job uses the Claude GitHub App and needs `id-token: write`.

The implement job starts GitHub's MCP server as a Docker container, so the runner needs Docker (GitHub-hosted `ubuntu-latest` has it). The agent opens the draft PR through that server as the Claude GitHub App, so CI starts on it. If the agent did not open one (for example, the server could not start), the workflow's own draft-PR step opens the PR with the job token instead, and CI does not start until the branch is pushed again.

`anthropics/claude-code-action` is pinned to a commit SHA. The implementer tool list is deny-by-default; package-manager rules belong in `extra_allowed_tools`, and toolchain install belongs in `setup_commands`.
