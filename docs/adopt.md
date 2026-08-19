# Adopt Agent-kit

Adopt follows a split contract:

- live-reference reusable workflows via `uses: ...@<semver-tag>`
- copy the four shipped skill folders from the same exact tag into `.claude/skills/`

Do not mix tags between workflow pins and copied skills.

## Tag-pinned workflow references

Pin reusable jobs to an immutable SemVer tag:

- `uses: <owner>/agent-kit/.github/workflows/security-audit-reusable.yml@v1.2.3`
- `uses: <owner>/agent-kit/.github/workflows/agent-plan-reusable.yml@v1.2.3`
- `uses: <owner>/agent-kit/.github/workflows/agent-implement-reusable.yml@v1.2.3`
- `uses: <owner>/agent-kit/.github/workflows/agent-review-reusable.yml@v1.2.3`

No floating major tags (`@v1`) are part of the contract.

## Copy skills from the same tag

From the exact same tag used in `uses:`, copy:

- `.claude/skills/code-review/`
- `.claude/skills/security-audit/`
- `.claude/skills/security-finding-triage/`
- `.claude/skills/security-response/`

The copied-skill and workflow references should always move together on upgrade.

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

## Dependabot for stable workflow pins

Enable Dependabot for `github-actions` and keep updates on stable tags only.
Pre-releases (`-alpha.N`, `-beta.N`, `-rc.N`) are intentionally not auto-bumped.

Example configuration:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "*"
        versions:
          - "*-alpha.*"
          - "*-beta.*"
          - "*-rc.*"
```
