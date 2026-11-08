# Getting started

A complete first adoption of Agent-kit in a Consumer repository, in order. Budget about 30 minutes. Terms in **bold** are defined in [GLOSSARY.md](../GLOSSARY.md).

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

Along the way, settle the [decisions you'll make](#decisions-youll-make). Then [check the setup with `doctor`](#check-the-setup-with-doctor), and see [Troubleshooting](#troubleshooting) and [Upgrading](#upgrading).

## Decisions you'll make

None of these blocks the first run, but each comes up during setup. Settle them on purpose rather than by default:

- [ ] **Vocabulary clashes.** The kit's docs, prompts and logs use the terms in [GLOSSARY.md](../GLOSSARY.md), such as **Allowlist**, **Kill switch** and **Threat pack**. If your repository already uses one of these words for something else, decide how your own docs tell the two apart; the kit's terms are not renamed per Consumer.
- [ ] **Branch prefix strategy.** The implementer's branches start with `branch_prefix` (default `claude/`). It is an ordinary input, so it can be an expression over the issue's labels. For example, `fix/` for issues labelled `bug` and `feat/` for the rest:

  ```yaml
  branch_prefix: ${{ contains(github.event.issue.labels.*.name, 'bug') && 'fix/' || 'feat/' }}
  ```

  A `workflow_dispatch` run has no issue in its event, so it gets `feat/`. The prefix is checked before the agent runs (valid branch-name start, at most 24 characters); see [`branch_prefix`](reference.md) and `branch_name_template` in the workflow reference.

- [ ] **Where the Threat pack lives.** The audit Caller defaults to `.security/threat-model.md` and `.security/findings-ledger.md` (step 7). Keep it out of any folder you publish, such as a `docs/` site: the threat model maps your attack paths.
- [ ] **How much `verify_commands` covers.** A separate verify job runs them on the agent's branch on every implement run, after `setup_commands`. Keep them to fast checks (lint, typecheck, unit tests); slow suites stay in your PR CI, which runs on the draft PR anyway. If a check needs a toolchain, use a [setup preset](../examples/setup-presets/).
- [ ] **Merge policy.** Nothing in the kit merges, but the Claude GitHub App can merge its own pull request unless a ruleset stops it. Decide who merges once your default branch has the `update` rule: see [Repository hardening](repository-hardening.md).
- [ ] **Whether `trusted_spec_authors` is set.** Empty (the default), review checks the Spec axis only against a Verified plan. Listing logins lets their `<!-- agent-kit-brief -->` issue comment stand in as the spec when there is no plan; see [Plan → implement → review](plan-implement-review.md).

## 1. Prerequisites

- A GitHub repository where you are an admin (you will add secrets, variables, and labels).
- A Claude subscription that works with Claude Code, and the `claude` CLI installed locally (for `claude setup-token`).
- `gh` CLI, authenticated (`gh auth status`), for the label and settings commands below. The web UI works too.
- For **plan → implement → review**: the [Claude GitHub App](https://github.com/apps/claude) installed on the repository. The implementer opens its draft PR as the App, because GitHub does not start CI for PRs opened with the job token.

## 2. Pick a tag

Use the newest tag from [Releases](https://github.com/mnaimfaizy/agent-kit/releases), for example `v1.0.0-alpha.12`. Every file you copy and every `uses:` pin must be the **same exact tag** — see [Adopt](adopt.md).

> Do not use `v1.0.0-alpha.1` or `v1.0.0-alpha.2`: GitHub rejects their reusable workflows ("Invalid workflow file").

## 3. Copy the runtime files from the same tag

The reusable workflows run in _your_ checkout and load prompts, the read-confinement hook, and skills from it. These are the **Kit-owned paths**, listed in [`kit-owned-paths.txt`](../kit-owned-paths.txt) in every tag from `v1.0.0-alpha.11`. Copy them; the loop deletes each path, then copies it fresh, and leaves your own skills in `.claude/skills/` alone:

```bash
TAG=v1.0.0-alpha.12
rm -rf /tmp/agent-kit
git clone --depth 1 --branch "$TAG" https://github.com/mnaimfaizy/agent-kit.git /tmp/agent-kit &&
grep -v -e '^#' -e '^$' /tmp/agent-kit/kit-owned-paths.txt | while read -r path; do
  path="${path%/}"
  rm -rf "./$path"
  mkdir -p "$(dirname "$path")"
  cp -R "/tmp/agent-kit/$path" "$(dirname "$path")/" || { echo "copy of $path failed" >&2; exit 1; }
done
rm -rf /tmp/agent-kit
```

Tags up to `v1.0.0-alpha.10` have no `kit-owned-paths.txt`; for those, copy the paths [Adopt](adopt.md#copy-kit-owned-paths-from-the-same-tag) lists.

| Copied path               | Needed by                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `.claude/skills/*/`       | review (`code-review`), audit (`security-audit`); triage, response, `explainer` by hand |
| `.github/agent-runtime/`  | plan, implement, review, audit (hook that confines file reads to the workspace)         |
| `.github/agent-pipeline/` | plan, implement (prompts, draft-PR fallback)                                            |
| `.github/security-audit/` | audit (prompt, advisory publisher, email notifier)                                      |

Commit these files. Do **not** copy `.github/workflows/*-reusable.yml`; you reference those remotely.

## 4. Add secrets

Settings → Secrets and variables → Actions → **New repository secret**, or `gh secret set NAME`.

| Secret                              | Used by         | How to get it                                                                                                                                                                         |
| ----------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`           | all flows       | Run `claude setup-token` locally and paste the token.                                                                                                                                 |
| `AGENT_KIT_ADVISORIES_TOKEN`        | audit           | Fine-grained PAT, this repository only, **Repository security advisories: Read and write**. Set an expiry you will track.                                                             |
| `AGENT_KIT_DEPENDABOT_ALERTS_TOKEN` | audit, optional | Fine-grained PAT, this repository only, **Dependabot alerts: Read-only**. Lets `full` mode ground on open alerts; skipped when unset.                                                 |
| `AGENT_KIT_NOTIFY_*`                | audit, optional | SMTP settings for the optional email notice (counts only; the full report only if publishing fails). See [examples/security-audit-caller.yml](../examples/security-audit-caller.yml). |

The job token (`GITHUB_TOKEN`) is **not** passed as a secret; the reusable workflows use `github.token`, limited by your Caller's `permissions:`.

## 5. Add the Caller workflows

Copy one or both templates into `.github/workflows/`:

- [`examples/security-audit-caller.yml`](../examples/security-audit-caller.yml)
- [`examples/plan-implement-review-caller.yml`](../examples/plan-implement-review-caller.yml)

Then edit:

1. **Pin:** every `uses: mnaimfaizy/agent-kit/...@<tag>` equals the tag from step 2.
2. **Allowlist:** replace `your-github-login` in `allowlist_actors` with the logins allowed to trigger runs (JSON array).
3. **Audit paths:** point `threat_model_path` and `findings_ledger_path` at your **Threat pack** (step 7).
4. **Implement:** set `verify_commands` (your lint/test/typecheck), and if needed `setup_commands` (toolchain install) and `extra_allowed_tools` (e.g. `Bash(npm test:*)`). `setup_commands` run twice, once before the agent and once in the verify job before `verify_commands`, so they should install the toolchain and be safe to repeat.
   - `setup_commands` run as one plain `bash` step, so actions such as `actions/setup-python` or `actions/setup-node` can't be used inside them. To pick a version with no download, put a version from the runner tool cache (`/opt/hostedtoolcache/<tool>/<version>/x64/bin`) on `$GITHUB_PATH`, which later steps (the agent, `verify_commands`) inherit. Copy a preset from [`examples/setup-presets/`](../examples/setup-presets/) into the block and edit it; the copy is yours: [`python.sh`](../examples/setup-presets/python.sh), [`node.sh`](../examples/setup-presets/node.sh), [`mixed.sh`](../examples/setup-presets/mixed.sh) (Python and Node.js), [`redis-service.sh`](../examples/setup-presets/redis-service.sh) (a service container via `docker run`).
   - Don't copy your CI test environment into `verify_commands` or `setup_commands`: a password variable such as `DATABASE_PASSWORD` set in the Caller, even to a throwaway test value, sets off secret scanners like GitGuardian on the PR that adds it. Export non-secret settings only and let the app's defaults cover the rest.
   - An `extra_allowed_tools` entry that runs repository code gives the agent the Claude GitHub App token. Before you add one, protect your default branch and your release tags with rulesets that the App cannot bypass: see [Repository hardening](repository-hardening.md).
   - Permission rules and hooks in a committed `.claude/settings.json` also apply to every agent in CI, on top of the reviewed grants. Keep developer conveniences in the uncommitted `.claude/settings.local.json`.
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
2. **Advisories on.** Private repositories: Settings → Code security → make sure security advisories are available. Delivery is a draft GitHub Security Advisory. The one exception is a failed publish with `notify_email` on, which emails the full report instead of losing it (see [security-audit.md](security-audit.md)).

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

**Model (optional).** Each flow reads its own repository variable first, then the shared `CLAUDE_MODEL`, then `claude-opus-5`. For example, the plan job passes `model: ${{ vars.CLAUDE_MODEL_PLAN || vars.CLAUDE_MODEL || 'claude-opus-5' }}`. Change a model at any time, with no commit needed:

| Variable                 | Flow                                       |
| ------------------------ | ------------------------------------------ |
| `CLAUDE_MODEL_PLAN`      | plan                                       |
| `CLAUDE_MODEL_IMPLEMENT` | implement                                  |
| `CLAUDE_MODEL_REVIEW`    | review                                     |
| `CLAUDE_MODEL_AUDIT`     | security audit                             |
| `CLAUDE_MODEL`           | any flow above whose own variable is unset |

```bash
gh variable set CLAUDE_MODEL --body claude-opus-5-5
gh variable set CLAUDE_MODEL_AUDIT --body claude-fable-5-1
```

Delete a flow's variable to fall back to `CLAUDE_MODEL`, and delete that to fall back to `claude-opus-5`.

## 9. First run

**Security audit:** Actions → your audit Caller → **Run workflow** (mode `full`). On success, the log shows only validated metadata (counts, severity); the full report is in Security → Advisories as a draft.

**Plan → implement → review:**

1. Open an issue describing a small change. Add `agent:plan`. The planner comments a plan that starts with the planner marker — that comment is the **Verified plan**.
2. Read the plan. If you agree, add `agent:implement`. The implementer works only from the Verified plan and opens a **draft** PR (or comments the exact error and a compare link).
3. On the PR, add `agent:review`. The reviewer comments a three-axis review. It never pushes, approves, or merges.

## Check the setup with doctor

From `v1.0.0-alpha.12`, the `@mnaimfaizy/agent-kit` CLI ([cli/](../cli/README.md)) checks all of the above for you. It is read-only: it runs git in your checkout without hooks or configured filter commands, never changes files or GitHub settings, and prints a POSIX-shell `gh` command for anything to fix. Run it from a clone of your repository, logged in to `gh` as an admin:

```bash
npx @mnaimfaizy/agent-kit doctor
```

It reads the tag from your Callers' `uses:` pins and fetches that tag from GitHub. Each check reports **fail**, **warn** or **skipped**; the run exits 1 on any fail, and `--strict` turns warnings into failures too. A check it had no permission to run (for example the Claude GitHub App on a personal account, whose installations GitHub does not show to a `gh` login) is reported as skipped, never as passed. The full list of checks is in [Adopt](adopt.md#check-an-adoption-with-doctor).

`doctor --ci` runs only the checks that need no GitHub login: the Kit-owned paths match the pinned tag, and every `uses:` pin agrees. It is also what `doctor` falls back to when your `gh` login is not an admin. Add it as a check on pull requests that touch the kit, so a pin bump without a re-copy fails before it merges:

```yaml
name: agent-kit doctor
on:
  pull_request:
    paths:
      - ".github/workflows/**"
      - ".github/agent-runtime/**"
      - ".github/agent-pipeline/**"
      - ".github/security-audit/**"
      - ".claude/skills/**"
permissions:
  contents: read
jobs:
  doctor:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - run: npx --yes @mnaimfaizy/agent-kit@1.0.0-alpha.12 doctor --ci
```

Pin the CLI version as you pin actions; any CLI version checks any tag from `v1.0.0-alpha.11`. Tags before that have no `kit-owned-paths.txt`, and the CLI refuses them: follow that tag's own `docs/adopt.md` instead.

## Troubleshooting

| Symptom                                                                                       | Cause and fix                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run fails in 0s: "This run likely failed because of a workflow file issue"                    | The pinned tag's reusable workflow is invalid (`v1.0.0-alpha.1`/`alpha.2`), or your Caller YAML is. Pin `v1.0.0-alpha.3`+ and run `actionlint` on the Caller.                                           |
| "The nested job … is requesting '…', but is only allowed '…'"                                 | Your Caller's `permissions:` grant less than the reusable workflow needs. Copy the block from the example or [reference.md](reference.md).                                                              |
| Jobs show as skipped                                                                          | The Kill switch is on: the variable is unset or not exactly `true`. Or the label name doesn't match the Caller's `if:`.                                                                                 |
| "Actor is not allowlisted."                                                                   | The login that added the label (or dispatched the run) is not in `allowlist_actors`. Scheduled runs use the last actor to edit the schedule.                                                            |
| Audit: "advisories token missing" / "rejected by GitHub"                                      | `AGENT_KIT_ADVISORIES_TOKEN` unset, expired, or revoked. Rotate it.                                                                                                                                     |
| Audit: "advisories token lacks Repository security advisories: write"                         | The PAT is live but not scoped for advisories. Give it **Repository security advisories: Read and write** on this repository.                                                                           |
| Audit: "Publish failed after 3 attempts"                                                      | The token lost access mid-run, or GitHub was down. With `notify_email` on, the full report was emailed; fix the token and re-run.                                                                       |
| Audit: "Dependabot alerts fetch failed" / "not set"                                           | Informational. Add `AGENT_KIT_DEPENDABOT_ALERTS_TOKEN` if you want alert grounding.                                                                                                                     |
| Implement: "No verified plan found from trusted author with required marker."                 | The plan comment must start with `planner_marker` and be authored by `trusted_plan_author` (default `github-actions[bot]`). Edited or copied plans don't count.                                         |
| Implement: PR opened but CI didn't start                                                      | The PR came from the job-token fallback, not the Claude App. Install the [Claude GitHub App](https://github.com/apps/claude).                                                                           |
| Review on a fork PR does nothing                                                              | By design: fork PRs get no secrets. Do not switch the Caller to `pull_request_target`.                                                                                                                  |
| "… settings must run the hook(s) from \$RUNNER_TEMP/read-confinement/ and end in \|\| exit 2" | The copied `.github/agent-runtime/` is older than the workflow pin. Re-copy it from the same tag (step 3).                                                                                              |
| "The staged read-confinement hook did not refuse an out-of-tree read."                        | The hook copied from your checkout cannot run. Re-copy `.github/agent-runtime/` from the tag, and check that no `.gitattributes` rule rewrites `*.mjs` files.                                           |
| Implement: "The staged Bash guard did not refuse a commit that reads a file."                 | The push guard copied from your checkout is older than the workflow pin. Re-copy `.github/agent-runtime/` from the same tag.                                                                            |
| Implement: "The staged write-confinement hook did not refuse a write inside .git."            | The write hook copied from your checkout is missing or cannot run. Re-copy `.github/agent-runtime/` from the same tag as the workflow pin.                                                              |
| Implement: "The checkout's git configuration has keys or hooks outside the allowlist …"       | Something before the agent (a setup step, a custom checkout) wrote a git config key or hook the allowlist in `check-git-config.mjs` does not expect. The log names it; remove it before the agent runs. |
| `test -f …` fails in "Validate caller-owned paths exist"                                      | A Threat pack path, the audit prompt, or the copied skill is missing. Re-check steps 3 and 7.                                                                                                           |

## Upgrading

Read the [CHANGELOG](../CHANGELOG.md) entries between your tag and the new one first; Major bumps require Caller changes.

**With the CLI** (from the CLI's `v1.0.0-alpha.13`; your current pins must be `v1.0.0-alpha.11` or later), on a branch with no uncommitted changes in the Kit-owned paths:

```bash
npx @mnaimfaizy/agent-kit upgrade --tag <new-tag>
```

It does steps 1 to 3 below for you and changes only local files: it replaces each Kit-owned path whole from the new tag, deletes any path the new tag no longer lists, and rewrites the `@<tag>` of every Agent-kit `uses:` pin (nothing else in your workflows). It then prints the `examples/` diff between the two tags, for step 4, and runs the [`doctor --ci`](#check-the-setup-with-doctor) file and pin checks. It refuses, before changing anything, when the pins disagree, when the old tag has no `kit-owned-paths.txt`, or when a path it would replace has uncommitted changes (`--force` discards them). Ignored files inside those paths are deleted with them; the plan lists them. It asks before writing; `--yes` skips the question, and is required when there is no terminal. Review `git diff`, then commit.

**By hand:**

1. Re-run step 3 with the new tag. It replaces each Kit-owned path whole, so files the kit removed are gone too.
2. Delete any Kit-owned path the old tag's `kit-owned-paths.txt` lists and the new one does not.
3. Bump every `uses: …@<tag>` to the new tag in the same commit.
4. Diff your Callers against the new `examples/` for new or renamed inputs and secrets.

Dependabot can open step 3's pin bumps for stable tags; see [Adopt](adopt.md#dependabot-for-stable-workflow-pins). It does not re-copy files, so the [`doctor --ci` check](#check-the-setup-with-doctor) fails on its pull request until the Kit-owned paths match the new tag. The failure names the command to run on that branch, `npx @mnaimfaizy/agent-kit@<version> upgrade --tag <tag>`: with the pins already on the new tag, it re-copies the Kit-owned paths and leaves the pins alone. Add `--from <previous-tag>` so it also deletes paths only the previous tag listed and prints the `examples/` diff; without it, upgrade cannot tell which tag the files came from.
