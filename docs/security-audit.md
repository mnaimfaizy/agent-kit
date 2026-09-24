# Security audit First-class flow

This runbook documents the Agent-kit reusable security audit flow. Setup steps: [Getting started](getting-started.md#7-prepare-the-security-audit). Every input and secret: [reference.md](reference.md#security-audit).

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

## Dependabot alert grounding (optional)

In `full` mode the job can hand the agent a summary of open Dependabot alerts (advisory id, package, ecosystem, severity, manifest) so `dependency-advisory` findings are grounded. `GITHUB_TOKEN` has no Dependabot-alerts permission, so this needs the optional `dependabot_alerts_token` secret: a fine-grained PAT with **Dependabot alerts: Read-only**. When it is unset the step logs a skip and the audit continues. The token is never in the agent step's environment.

## Threat pack

The Caller passes two Consumer-owned files:

- `threat_model_path`: assets, trust boundaries, attack paths to walk, out-of-scope areas.
- `findings_ledger_path`: fingerprints of known findings (concept id, status, dates) so repeat runs dedupe. The ledger is committed and public, so it never holds attack paths, evidence, or locations.

Both are restored from the PR base in `pr` mode, so a PR cannot edit the Threat pack that audits it. See this repository's [threat model](../security/threat-model.md) and [ledger](../security/findings-ledger.md) for a worked example.

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
- optional Dependabot alerts token
- Claude subscription token
- `permissions:` that cover what the reusable job requests (`contents: read`, `pull-requests: write`, `security-events: write`)
- for `pr` mode, the head SHA, base SHA, base ref, and PR number

Triage and response happen after delivery using the shipped skills.
