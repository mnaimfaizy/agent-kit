# Adopt Agent-kit

Adopt follows a split contract:

- live-reference reusable workflows via `uses: ...@<semver-tag>`
- copy the four shipped skill folders from the same exact tag into `.claude/skills/`

Do not mix tags between workflow pins and copied skills.

## Companion library (not Agent-kit)

Procedure skills such as `implement`, `tdd`, and `wayfinder` are not vendored here. Adopt **[Matt Pocock's skills](https://github.com/mattpocock/skills)** separately — copy from that repo or use its Claude plugin. That library is outside this kit's Release line; there is no SemVer pin for it in Adopt docs.

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
- `.github/agent-runtime/` (Read/Grep/Glob confinement hook the jobs load from the Consumer checkout)
- `.github/security-audit/` (prompt and the publish/email scripts the audit stages from a trusted commit)
- `.github/agent-pipeline/` (planner and implementer contracts, and the draft-PR fallback script)

The copied files and workflow references should always move together on upgrade.

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

## Further reading

- [Releases](releases.md) — SemVer, pre-releases, changelog policy
- [Security model](security-model.md) — public-log rule, private delivery, gates
- [Security audit](security-audit.md) — `full` / `pr` Caller
- [Plan → implement → review](plan-implement-review.md) — labels, Verified plan, draft PR
- [Copilot restore](copilot-restore.md) — inert archive, choose-one generation
- [Issuebridge reference Consumer](issuebridge.md) — target state + stand-up checklist (not an extract runbook)
