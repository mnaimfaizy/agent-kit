# Adopt Agent-kit

## Security-audit reusable job

1. Copy the Caller pattern from `examples/security-audit-caller.yml`.
2. Pin the reusable workflow reference to a release tag for stable adoption.
3. Supply Consumer-owned threat pack paths and secrets.

## Consumer-owned contract surface

- Caller workflow triggers and allowlist policy
- kill switch
- advisory token for draft GHSA creation
- optional scanner command
- optional email notification secrets

The Agent-kit reusable workflow provides the job body; the Consumer controls policy and repository-specific inputs.

## Plan-implement-review reusable jobs

1. Copy the Caller pattern from `examples/plan-implement-review-caller.yml`.
2. Pin reusable workflow `uses:` references to a release tag for stable adoption.
3. Set your label names, allowlist, and kill switch policy in the Caller.
4. Provide your own verify commands in the implement caller input.

### Plan-implement-review caller-owned contract surface

- trigger labels (for example `agent:plan`, `agent:implement`, `agent:review`)
- allowlist policy and kill switch
- branch policy and merge policy
- verify commands (lint, tests, typecheck, etc.)
- optional workflow-dispatch controls
