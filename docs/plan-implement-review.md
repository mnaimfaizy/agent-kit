# Plan-implement-review First-class flow

This runbook documents the reusable plan -> implement -> review flow.

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

Plan, review, and audit load `.github/agent-runtime/` from the Consumer checkout. A PreToolUse hook denies Read/Grep/Glob paths outside the workspace. Copy that directory from the same tag as the workflow pin.

Checkouts set `persist-credentials: false`. Plan, review, and audit pass the job token into the Claude action. The implementer does not: a pull request opened with the job token does not start CI, so that job uses the Claude GitHub App and needs `id-token: write`.

`anthropics/claude-code-action` is pinned to a commit SHA. The implementer tool list is deny-by-default; package-manager rules belong in `extra_allowed_tools`, and toolchain install belongs in `setup_commands`.
