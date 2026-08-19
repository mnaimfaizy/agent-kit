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
- consume trigger label after run

Caller workflows should trigger on `issues.labeled` (or manual dispatch), not issue create.

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

- on-demand review job
- report three axes: Standards, Spec, Correctness
- Spec axis uses Verified plan when present
- no push, no product run, no auto-fix
