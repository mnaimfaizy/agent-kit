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
