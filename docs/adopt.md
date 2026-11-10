# Adopt Agent-kit

> First adoption? Follow [Getting started](getting-started.md) step by step, or run `npx @mnaimfaizy/agent-kit init --tag <tag>` ([Adopt with the CLI](getting-started.md#adopt-with-the-cli)), which copies the Kit-owned paths, writes the Callers and the Threat pack skeleton, and prints the GitHub-side steps. This page is the contract behind both.

Adopt follows a split contract:

- live-reference reusable workflows via `uses: ...@<semver-tag>`
- copy the **Kit-owned paths** from the same exact tag: the shipped skill folders in `.claude/skills/` and three runtime folders in `.github/`

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

## Copy Kit-owned paths from the same tag

From the exact same tag used in `uses:`, copy each Kit-owned path. The source of truth is [`kit-owned-paths.txt`](../kit-owned-paths.txt) at the root of every tag from `v1.0.0-alpha.11`; the list below matches it, and a contract test keeps the two in step. Replace each path whole: delete it, then copy it fresh (the loop in [Getting started §3](getting-started.md#3-copy-the-runtime-files-from-the-same-tag) does this, and so do the CLI's `init` and `upgrade`). Never edit these paths. Your own skills next to the kit's in `.claude/skills/` are never touched.

Don't install a Kit-owned skill with `npx skills` in a Consumer: [Install individual skills](install-skills.md) is for Skill installers who don't adopt the kit. A project install turns the Kit-owned path into a symlink to `.agents/skills/<name>/` (a junction on Windows), which `agent-kit upgrade` refuses to replace and `agent-kit doctor` reports. To undo it, remove the link and `.agents/skills/<name>/`, then run `agent-kit upgrade --tag <the tag your pins name> --force`: with the link gone its files show as deleted, and `--force` lets `upgrade` restore them (it discards changes in Kit-owned paths only).

- `.claude/skills/code-review/`
- `.claude/skills/security-audit/`
- `.claude/skills/security-finding-triage/`
- `.claude/skills/security-response/`
- `.claude/skills/explainer/` — a Kit-owned path copied with the rest. No First-class flow uses it; you use it by hand. Its per-repository settings in your own `docs/agents/explainer.md` (template: [`examples/explainer-config.md`](../examples/explainer-config.md)) are not Kit-owned and survive upgrades.
- `.claude/skills/instruction-drift-audit/` — a Kit-owned path copied with the rest. No First-class flow uses it; you run `/instruction-drift-audit` by hand. Its adapter, `instruction-drift-audit.config.yml` at your repository root (keys: [`ADAPTER.md`](../.claude/skills/instruction-drift-audit/ADAPTER.md)), is not Kit-owned and survives upgrades; a host that adopted the skill as `upstream-brief` keeps its `upstream-brief.config.*`, which is still read.
- `.github/agent-runtime/` — hooks and settings the jobs load from the Consumer checkout and run from a read-only copy under `$RUNNER_TEMP`:
  - `confine-reads-to-workspace.mjs`: PreToolUse hook that denies Read/Grep/Glob outside the workspace. Plan, implement, review, audit.
  - `read-confinement.settings.json`: settings that run the read hook. Plan, review, audit (implement checks it too).
  - `implementer.settings.json`: settings that run the read hook, write hook, and push guard. Implement.
  - `confine-writes-to-worktree.mjs`: PreToolUse hook that keeps writes in the worktree and out of `.git/`. Implement.
  - `guard-implementer-push.mjs`: PreToolUse hook that refuses any push except the expected one. Implement.
  - `check-git-config.mjs`: allowlist check of the checkout's git config and hooks, run before and after the agent. Implement.
- `.github/security-audit/` (prompt and the publish/email scripts the audit stages from a trusted commit)
- `.github/agent-pipeline/` (planner and implementer contracts, and the draft-PR fallback script)

The copied paths and workflow references should always move together on upgrade.

## Security-audit reusable job

1. Copy the Caller pattern from `examples/security-audit-caller.yml`.
2. Pin the reusable workflow reference to a release tag for stable adoption.
3. Supply Consumer-owned Threat pack paths and secrets.

## Consumer-owned contract surface

- Caller workflow triggers and allowlist policy
- Kill switch (the examples read the `CLAUDE_SECURITY_AUDIT_ENABLED` repository variable)
- advisory token for draft GHSA creation (`advisories_token`)
- optional Dependabot alerts token (`dependabot_alerts_token`)
- optional scanner command
- optional email notification secrets

The job token is not a secret input: reusable workflows use `github.token`, limited by the Caller's `permissions:`. The Caller must grant at least the permissions each reusable workflow lists in [reference.md](reference.md).

The Agent-kit reusable workflow provides the job body; the Consumer controls policy and repository-specific inputs.

## Plan-implement-review reusable jobs

1. Copy the Caller pattern from `examples/plan-implement-review-caller.yml`.
2. Pin reusable workflow `uses:` references to a release tag for stable adoption.
3. Set your label names, allowlist, and Kill switch policy in the Caller (the example reads the `CLAUDE_PIPELINE_ENABLED` repository variable).
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

## Check an adoption with doctor

`npx @mnaimfaizy/agent-kit doctor` checks a Consumer against the tag its Callers pin (CLI from `v1.0.0-alpha.12`; how to run it: [Getting started](getting-started.md#check-the-setup-with-doctor)). It is read-only: it runs git in your checkout without hooks or configured filter commands, writes nothing to it, and never changes GitHub settings. Kit files come from the git tag, not from the npm package, and tags without `kit-owned-paths.txt` (up to `v1.0.0-alpha.10`) are refused: adopt those by hand with that tag's `docs/adopt.md`.

| Check                        | Result when it does not hold | Runs in `--ci` | How                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uses:` pins agree           | fail                         | yes            | Every Agent-kit `uses:` in `.github/workflows/` names the same repository and Release-line tag. Pins of a fork or a GitHub Enterprise mirror pass with a note: the other checks then compare against that repository.                                                                      |
| Kit-owned paths match        | fail                         | yes            | Each path in the tag's `kit-owned-paths.txt` has the same git tree hash in your working copy (tracked and untracked files, minus ignored ones) as at the tag. Paths marked skip-worktree (a sparse checkout, say) are compared as committed at HEAD, and skipped only if HEAD has no copy. |
| Secrets set                  | fail; warn if optional       | no             | Each `secrets.X` a Caller passes. Required or optional comes from the reusable workflow's `secrets:` block at the pinned tag.                                                                                                                                                              |
| Variables set                | fail                         | no             | Each `vars.X` a Caller reads, unless every read falls back with `\|\|` (the model variables). The Kill switch variables are required: set them to `true` or `false`.                                                                                                                       |
| Trigger labels exist         | fail                         | no             | Each Caller's `trigger_label`, or the reusable workflow's default at the tag when the Caller leaves it out.                                                                                                                                                                                |
| Claude GitHub App installed  | fail                         | no             | Organization repositories only. GitHub does not show a personal account's app installations to a `gh` login, so there it is skipped.                                                                                                                                                       |
| Default branch `update` rule | warn                         | no             | [Repository hardening §1](repository-hardening.md#1-default-branch-an-update-rule). Each ruleset check also warns when a GitHub App, the Write role or another role below Maintain is on the bypass list.                                                                                  |
| Branch `creation` rule       | warn                         | no             | [Repository hardening §2](repository-hardening.md#2-release-branches-a-creation-rule). Matters only if you cut releases from branches.                                                                                                                                                     |
| `v*` tag ruleset             | warn                         | no             | [Repository hardening §3](repository-hardening.md#3-release-tags-a-v-tag-ruleset): creation, update and deletion blocked.                                                                                                                                                                  |
| Release tag pushes           | warn                         | no             | On a personal account, a workflow that pushes tags with `GITHUB_TOKEN`; see [Personal-account repositories](repository-hardening.md#personal-account-repositories-pushing-release-tags).                                                                                                   |

A check it could not run (no admin `gh` login, `--ci`, a refused API call, or a Caller `secrets:` block written as a flow mapping, anchor or alias) is reported as **skipped** and never counts as passed. The run exits 1 on any fail; `--strict` turns warnings into failures. Fix commands are printed for a POSIX shell, and only for names that pass a strict allowlist; anything else is shown escaped, to fix by hand. When the Kit-owned paths differ, the failure names the fix, `npx @mnaimfaizy/agent-kit@<version> upgrade --tag <tag>` (from the CLI's `v1.0.0-beta.1`), and also links this page's [copy step](#copy-kit-owned-paths-from-the-same-tag) at the tag, to re-copy the paths by hand instead.

## Upgrading

Move the `uses:` pins and the copied files to the new tag in the same commit. Read the CHANGELOG between the two tags first; a Major bump means Caller changes. Step-by-step: [Getting started → Upgrading](getting-started.md#upgrading).

`npx @mnaimfaizy/agent-kit upgrade --tag <new-tag>` does both for you, from pins on `v1.0.0-alpha.11` or later. It replaces each Kit-owned path the new tag lists (delete, then copy), deletes paths only the old tag listed, rewrites only the `@<tag>` of the Agent-kit `uses:` pins, prints the `examples/` diff for you to apply to your Callers by hand, and finishes with the `doctor --ci` checks. It writes only local files, commits nothing, and refuses before changing anything if a path it would replace has uncommitted changes (unless `--force`).

## Further reading

- [Getting started](getting-started.md) — first adoption, step by step
- [Workflow reference](reference.md) — every input, secret, and permission
- [Releases](releases.md) — SemVer, pre-releases, changelog policy
- [Security model](security-model.md) — public-log rule, private delivery, gates
- [Security audit](security-audit.md) — `full` / `pr` Caller
- [Plan → implement → review](plan-implement-review.md) — labels, Verified plan, draft PR
- [Copilot restore](copilot-restore.md) — inert archive, choose-one generation
- [Issuebridge reference Consumer](issuebridge.md) — target state + stand-up checklist (not an extract runbook)
