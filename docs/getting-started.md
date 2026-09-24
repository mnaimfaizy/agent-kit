# Getting started

A complete first adoption of Agent-kit in a Consumer repository, in order. Budget about 30 minutes. Terms in **bold** are defined in [CONTEXT.md](../CONTEXT.md).

You will:

1. [Check prerequisites](#1-prerequisites)
2. [Pick a tag](#2-pick-a-tag)
3. [Copy the runtime files](#3-copy-the-runtime-files-from-the-same-tag)
4. [Add secrets](#4-add-secrets)
5. [Add the Caller workflows](#5-add-the-caller-workflows)
6. [Create trigger labels](#6-create-trigger-labels)
7. [Prepare the security audit](#7-prepare-the-security-audit)
8. [Turn the flows on](#8-turn-the-flows-on-kill-switch-variables)
9. [Do a first run](#9-first-run)

Then see [Troubleshooting](#troubleshooting) and [Upgrading](#upgrading).

## 1. Prerequisites

- A GitHub repository where you are an admin (you will add secrets, variables, and labels).
- A Claude subscription that works with Claude Code, and the `claude` CLI installed locally (for `claude setup-token`).
- `gh` CLI, authenticated (`gh auth status`), for the label and settings commands below. The web UI works too.
- For **plan → implement → review**: the [Claude GitHub App](https://github.com/apps/claude) installed on the repository. The implementer opens its draft PR as the App, because GitHub does not start CI for PRs opened with the job token.

## 2. Pick a tag

Use the newest tag from [Releases](https://github.com/mnaimfaizy/agent-kit/releases), for example `v1.0.0-alpha.5`. Every file you copy and every `uses:` pin must be the **same exact tag** — see [Adopt](adopt.md).

> Do not use `v1.0.0-alpha.1` or `v1.0.0-alpha.2`: GitHub rejects their reusable workflows ("Invalid workflow file").

## 3. Copy the runtime files from the same tag

The reusable workflows run in _your_ checkout and load prompts, the read-confinement hook, and skills from it. Copy them:

```bash
TAG=v1.0.0-alpha.5
git clone --depth 1 --branch "$TAG" https://github.com/mnaimfaizy/agent-kit.git /tmp/agent-kit
mkdir -p .claude/skills .github
cp -R /tmp/agent-kit/.claude/skills/. .claude/skills/
cp -R /tmp/agent-kit/.github/agent-runtime /tmp/agent-kit/.github/agent-pipeline /tmp/agent-kit/.github/security-audit .github/
rm -rf /tmp/agent-kit
```

| Copied path               | Needed by                                                                       |
| ------------------------- | ------------------------------------------------------------------------------- |
| `.claude/skills/`         | review (`code-review`), audit (`security-audit`), and triage/response by hand   |
| `.github/agent-runtime/`  | plan, implement, review, audit (hook that confines file reads to the workspace) |
| `.github/agent-pipeline/` | plan, implement (prompts, draft-PR fallback)                                    |
| `.github/security-audit/` | audit (prompt, advisory publisher, email notifier)                              |

Commit these files. Do **not** copy `.github/workflows/*-reusable.yml`; you reference those remotely.

## 4. Add secrets

Settings → Secrets and variables → Actions → **New repository secret**, or `gh secret set NAME`.

| Secret                              | Used by         | How to get it                                                                                                                               |
| ----------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`           | all flows       | Run `claude setup-token` locally and paste the token.                                                                                       |
| `AGENT_KIT_ADVISORIES_TOKEN`        | audit           | Fine-grained PAT, this repository only, **Repository security advisories: Read and write**. Set an expiry you will track.                   |
| `AGENT_KIT_DEPENDABOT_ALERTS_TOKEN` | audit, optional | Fine-grained PAT, this repository only, **Dependabot alerts: Read-only**. Lets `full` mode ground on open alerts; skipped when unset.       |
| `AGENT_KIT_NOTIFY_*`                | audit, optional | SMTP settings for the optional email notice (counts only). See [examples/security-audit-caller.yml](../examples/security-audit-caller.yml). |

The job token (`GITHUB_TOKEN`) is **not** passed as a secret; the reusable workflows use `github.token`, limited by your Caller's `permissions:`.

## 5. Add the Caller workflows

Copy one or both templates into `.github/workflows/`:

- [`examples/security-audit-caller.yml`](../examples/security-audit-caller.yml)
- [`examples/plan-implement-review-caller.yml`](../examples/plan-implement-review-caller.yml)

Then edit:

1. **Pin:** every `uses: mnaimfaizy/agent-kit/...@<tag>` equals the tag from step 2.
2. **Allowlist:** replace `your-github-login` in `allowlist_actors` with the logins allowed to trigger runs (JSON array).
3. **Audit paths:** point `threat_model_path` and `findings_ledger_path` at your **Threat pack** (step 7).
4. **Implement:** set `verify_commands` (your lint/test/typecheck), and if needed `setup_commands` (toolchain install) and `extra_allowed_tools` (e.g. `Bash(npm test:*)`).
5. **Permissions:** keep the `permissions:` block. A Caller must grant at least what the reusable workflow requests — see [reference.md](reference.md).

Every input and secret is listed in the [workflow reference](reference.md).

## 6. Create trigger labels

```bash
gh label create "agent:plan"      --color 1D76DB --description "Agent-kit: plan this issue"
gh label create "agent:implement" --color 0E8A16 --description "Agent-kit: implement the Verified plan"
gh label create "agent:review"    --color 5319E7 --description "Agent-kit: review this PR"
```

Each run removes its label when it finishes, so adding it again re-runs the stage.

## 7. Prepare the security audit

Skip if you only use plan → implement → review.

1. **Threat pack.** Create the two files your Caller points at (defaults: `.security/threat-model.md`, `.security/findings-ledger.md`). The threat model lists assets, trust boundaries, and attack paths; the ledger holds only fingerprints (concept id, status, dates) of known findings, never details. This repository's own [threat model](../security/threat-model.md) and [ledger](../security/findings-ledger.md) are working examples.
2. **Advisories on.** Private repositories: Settings → Code security → make sure security advisories are available. Delivery is always a draft GitHub Security Advisory; there is no other sink.
3. **Seed one draft advisory by hand.** Security → Advisories → **New draft security advisory**, any placeholder content. The preflight treats a token that sees zero drafts as mis-scoped (a public repository cannot tell the two apart), so the first run fails without one.

## 8. Turn the flows on (Kill switch variables)

Callers read their **Kill switch** from repository variables and stay off until the variable is exactly `true`:

| Variable                        | Enables                   |
| ------------------------------- | ------------------------- |
| `CLAUDE_SECURITY_AUDIT_ENABLED` | security audit            |
| `CLAUDE_PIPELINE_ENABLED`       | plan → implement → review |

```bash
gh variable set CLAUDE_SECURITY_AUDIT_ENABLED --body true
gh variable set CLAUDE_PIPELINE_ENABLED --body true
```

Set a variable to anything else (or delete it) to stop a flow instantly without a commit.

**Model (optional).** The example Callers pass `model: ${{ vars.CLAUDE_MODEL || 'claude-opus-5' }}`, so the `CLAUDE_MODEL` variable picks the Claude model for every flow, with no commit needed:

```bash
gh variable set CLAUDE_MODEL --body claude-opus-5-5
```

Delete the variable to fall back to `claude-opus-5`.

## 9. First run

**Security audit:** Actions → your audit Caller → **Run workflow** (mode `full`). On success, the log shows only validated metadata (counts, severity); the full report is in Security → Advisories as a draft.

**Plan → implement → review:**

1. Open an issue describing a small change. Add `agent:plan`. The planner comments a plan that starts with the planner marker — that comment is the **Verified plan**.
2. Read the plan. If you agree, add `agent:implement`. The implementer works only from the Verified plan and opens a **draft** PR (or comments the exact error and a compare link).
3. On the PR, add `agent:review`. The reviewer comments a three-axis review. It never pushes, approves, or merges.

## Troubleshooting

| Symptom                                                                       | Cause and fix                                                                                                                                                   |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run fails in 0s: "This run likely failed because of a workflow file issue"    | The pinned tag's reusable workflow is invalid (`v1.0.0-alpha.1`/`alpha.2`), or your Caller YAML is. Pin `v1.0.0-alpha.3`+ and run `actionlint` on the Caller.   |
| "The nested job … is requesting '…', but is only allowed '…'"                 | Your Caller's `permissions:` grant less than the reusable workflow needs. Copy the block from the example or [reference.md](reference.md).                      |
| Jobs show as skipped                                                          | The Kill switch is on: the variable is unset or not exactly `true`. Or the label name doesn't match the Caller's `if:`.                                         |
| "Actor is not allowlisted."                                                   | The login that added the label (or dispatched the run) is not in `allowlist_actors`. Scheduled runs use the last actor to edit the schedule.                    |
| Audit: "advisories token missing" / "rejected by GitHub"                      | `AGENT_KIT_ADVISORIES_TOKEN` unset, expired, or revoked. Rotate it.                                                                                             |
| Audit: "advisories token sees no draft advisories"                            | No draft exists yet, or the token lacks security-advisories access. Do step 7.3; check the PAT permission.                                                      |
| Audit: "Dependabot alerts fetch failed" / "not set"                           | Informational. Add `AGENT_KIT_DEPENDABOT_ALERTS_TOKEN` if you want alert grounding.                                                                             |
| Implement: "No verified plan found from trusted author with required marker." | The plan comment must start with `planner_marker` and be authored by `trusted_plan_author` (default `github-actions[bot]`). Edited or copied plans don't count. |
| Implement: PR opened but CI didn't start                                      | The PR came from the job-token fallback, not the Claude App. Install the [Claude GitHub App](https://github.com/apps/claude).                                   |
| Review on a fork PR does nothing                                              | By design: fork PRs get no secrets. Do not switch the Caller to `pull_request_target`.                                                                          |
| `test -f …` fails in "Validate caller-owned paths exist"                      | A Threat pack path, the audit prompt, or the copied skill is missing. Re-check steps 3 and 7.                                                                   |

## Upgrading

1. Read the [CHANGELOG](../CHANGELOG.md) entries between your tag and the new one; Major bumps require Caller changes.
2. Re-run step 3 with the new tag (overwrite the copied files).
3. Bump every `uses: …@<tag>` to the new tag in the same commit.
4. Diff your Callers against the new `examples/` for new or renamed inputs and secrets.

Dependabot can open step 3's pin bumps for stable tags; see [Adopt](adopt.md#dependabot-for-stable-workflow-pins). It does not re-copy files, so do step 2 by hand in the same PR.
