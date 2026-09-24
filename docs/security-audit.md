# Security audit First-class flow

This runbook documents the Agent-kit reusable security audit flow.

## Reusable job

Use:

- `.github/workflows/security-audit-reusable.yml` (job body in Agent-kit)
- Caller example: `examples/security-audit-caller.yml`

The reusable job supports:

- `full` and `pr` modes
- required private delivery to draft GHSA
- optional email notification
- counts-only PR comments in `pr` mode when findings exist
- advisory-token preflight before the agent runs
- credentialed scripts staged outside the workspace and checked by digest
- Read/Grep/Glob confined to the workspace

`pr` mode requires `head_sha`, `base_sha`, `base_ref`, and `pr_number`. The job restores instructions and `.github/agent-runtime/` from the base before the agent starts. `scan_command` runs in `full` mode only.

The preflight treats a token that can see zero draft advisories as mis-scoped, because a public repository cannot tell that apart from a token with no advisories access. Create one draft advisory by hand before the first automated run.

## Private delivery and public-log rule

- Every successful run must create a draft GHSA with full report details.
- Public PR comments include counts only.
- Logs and artifacts must not include finding bodies.
- The same job applies to public, private, and org repositories.

## Private/org repositories

Use the same reusable job and same required sink (draft GHSA).

If Advisories are disabled in your repository, enable Advisories first. This is Consumer setup, not a separate delivery sink.

## Caller-owned inputs

The Caller owns:

- Threat pack paths (`threat_model_path`, `findings_ledger_path`)
- kill switch
- allowlist policy
- advisories token secret
- optional scanner command (`full` mode only)
- optional email secrets
- Claude subscription token and the job token
- for `pr` mode, the head SHA, base SHA, base ref, and PR number

Triage and response happen after delivery using the shipped skills.
