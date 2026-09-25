# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Security

- Plan and security audit deny `Bash` outright. Leaving it off `--allowedTools` did not withhold it: Claude Code auto-approves read-only commands inside the workspace. Hardening only; the auto-approved commands reach nothing the agents' Read, Glob, and Grep tools could not.

### Changed

- The security audit's token preflight no longer needs a draft advisory to exist. It probes the create-advisory endpoint with an empty body, which passes only for a token allowed to create advisories and never creates one. The one-draft seeding step is gone from setup.
- Publishing the draft advisory retries three times. If it still fails and `notify_email` is on, the full report is emailed with a `[publish failed]` subject instead of being lost; the run still fails.

### Docs

- Getting started and the security model now say to protect the default branch and release tags with rulesets before granting `extra_allowed_tools` that run repository code, and that permission rules and hooks in a committed `.claude/settings.json` apply to the CI agents.

## [1.0.0-alpha.6] - 2026-09-24

Security release for [GHSA-pwx3-m47m-qfm5](https://github.com/mnaimfaizy/agent-kit/security/advisories/GHSA-pwx3-m47m-qfm5) and [GHSA-8787-cwm5-fvcj](https://github.com/mnaimfaizy/agent-kit/security/advisories/GHSA-8787-cwm5-fvcj): hardens read confinement, the agents' tool grants, and which job runs agent-authored code. **Consumer action required** — see the first items.

### Consumer action

- **Required:** re-copy `.github/agent-runtime/` and `.github/agent-pipeline/` from this tag. Plan, implement, review, and audit run the read-confinement hook from a read-only copy under `$RUNNER_TEMP` and fail with a message if `read-confinement.settings.json` still runs it from the workspace. `open-draft-pr.sh` takes the head branch as a third argument.
- **May be required:** implement runs `setup_commands` twice — before the agent, and again in the new `verify` job before `verify_commands` — so they should install the toolchain and be safe to repeat. `verify_commands` run with `bash -c`, not a login shell; move any profile-based setup into `setup_commands`.
- **May be required:** security audit `full` mode refuses a `head_sha` or `base_sha` and audits the commit it was dispatched on. Use `mode: pr` for pull requests.
- **May be required:** the implement job starts GitHub's MCP server container, so its runner needs Docker (GitHub-hosted `ubuntu-latest` has it). An SMTP host whose certificate the runner does not trust now fails the best-effort email step instead of receiving credentials.

### Security

- The read-confinement hook judges a path with symlinks resolved, runs from a read-only staged copy checked by digest after each agent, refuses `.git` for Read, Grep, and Glob, and now also covers the implementer.
- No agent is granted `git diff` / `git log` / `git show`, `gh pr comment`, or `gh pr create`; all are denied outright. The reviewer reads a precomputed diff; the implementer opens its draft PR with `mcp__github__create_pull_request`.
- Implement runs `verify_commands`, which execute agent-authored code, in a separate `verify` job with `contents: read` and no `id-token`, on the agent's pushed branch. Only the implement job holds write and OIDC credentials, and after the agent it runs only checks. The draft-PR fallback and label cleanup run in their own jobs without `id-token`, from the trusted commit.
- Security audit `full` mode no longer checks out a Caller-named head.
- The audit email notifier verifies the SMTP server's certificate and hostname, and runs Python isolated (`python3 -I`) from `$RUNNER_TEMP` so workspace files cannot shadow the standard library.

### Changed

- The review and audit briefs fence the PR's changed-file names as untrusted data.
- The advisory publisher writes the report body to a private `mktemp` file under `$RUNNER_TEMP` and removes it on exit.
- Caller input descriptions and `docs/security-model.md` state that `verify_commands`, `setup_commands`, `scan_command`, and code-running `extra_allowed_tools` entries are code the job runs, must never be built from issue or PR text, and that code-running extra grants act with the Claude App token.

### Fixed

- Implement's draft-PR fallback detects an existing PR with `gh pr list --head` and no longer posts a bogus "could not open draft PR" comment beside the agent's PR.

## [1.0.0-alpha.5] - 2026-09-24

Maintenance release: only this repository's own `CODEOWNERS` contract test changed. Nothing Consumer-facing changed (reusable workflows, runtime files, skills, and Caller inputs are the same as in alpha.4).

### Changed

- `scripts/codeowners-contract.test.py` fails on a CODEOWNERS rule without a leading `/`, and its path failure message names the missing anchor as a cause.
- `scripts/codeowners-contract.test.py` gives the same result for wildcard patterns on every supported Python version: a trailing-slash wildcard must match a directory, and the invalid-pattern handler is tested on every version.

## [1.0.0-alpha.4] - 2026-09-24

Adds Opus 5.5 support and fixes found by the first dogfood runs. No required Caller changes.

### Added

- Example Callers pass `model: ${{ vars.CLAUDE_MODEL || 'claude-opus-5' }}`, so the model is set with a repository variable instead of an edit to the Caller.
- `scripts/codeowners-contract.test.py`: CI now fails when a `.github/CODEOWNERS` rule points at a path that no longer exists, or names an owner that is not a valid `@handle` / `@org/team`.

### Changed

- `anthropics/claude-code-action` bumped from the 2026-08-11 pin (Claude Code 2.1.228) to v1.0.233, which is needed for `claude-opus-5-5`.

### Fixed

- Implement removes its `implementer-brief.md` scratch file before the Caller's `verify_commands`, so whole-tree lint/format checks no longer fail on it.
- Implementer PRs (agent-opened and fallback) include `Closes #<issue>`, so review finds the Verified plan and runs its Spec axis.

## [1.0.0-alpha.3] - 2026-09-24

First usable pre-release. `v1.0.0-alpha.1` and `v1.0.0-alpha.2` are **broken**: GitHub rejects their reusable workflows ("Invalid workflow file"), so no Caller pinned to them can run. Upgrade to this tag.

### Fixed

- Reusable workflows no longer declare a `github_token` secret (a reserved name that made every file invalid). They use `github.token`, limited by the Caller's `permissions:`.
- Security audit no longer requests the invalid `vulnerability-alerts` permission.
- Implement passes `verify_commands` through `env:` instead of splicing it into a single-quoted shell string, so commands containing quotes work.
- `scripts/cut-release.sh --publish` pushes the annotated tag before creating the GitHub Release.

### Changed

- **Callers:** remove `github_token:` from every `secrets:` block, and remove `vulnerability-alerts: read` from the audit Caller's `permissions:`.
- Dependabot alert grounding in `full` mode now needs the optional `dependabot_alerts_token` secret (fine-grained PAT, Dependabot alerts: read); without it the step is skipped.
- `actions/checkout` is pinned by commit SHA.
- Examples pin `@v1.0.0-alpha.3` and read their Kill switch from the `CLAUDE_PIPELINE_ENABLED` / `CLAUDE_SECURITY_AUDIT_ENABLED` repository variables.

### Added

- `docs/getting-started.md`, generated `docs/reference.md`, `CONTRIBUTING.md`, `CONTEXT.md` glossary.
- CI (tests, ruff, prettier, shellcheck, actionlint, link checks), pre-commit, Dependabot.
- Workflow-validity contract tests for what GitHub rejects at load time but actionlint misses.
- Dogfood Callers that run this repository's own flows (off by default) and an Agent-kit Threat pack.

## [1.0.0-alpha.2] - 2026-09-24 [BROKEN — use 1.0.0-alpha.3]

### Changed

- Plan, implement, review, and security-audit reusable workflows now run Claude Code with the controls landed on the Issuebridge reference Consumer: SHA-pinned action, job-token GitHub auth for every job except the implementer, `persist-credentials: false`, a PreToolUse hook that confines Read/Grep/Glob to the workspace, reviewed tool allowlists, staged credentialed audit scripts, and an advisory-token preflight before the audit agent runs.
- Review is a pull-request job (`pr_number`, `head_sha`, `base_sha`, `base_ref`). Callers pass `claude_code_oauth_token`. The audit Caller also passes `github_token`.

## [1.0.0-alpha.1] - 2026-08-19 [BROKEN — use 1.0.0-alpha.3]

### Added

- Public Agent-kit identity (README, MIT, SECURITY.md).
- Four portable skills: `code-review`, `security-audit`, `security-finding-triage`, `security-response`.
- Security-audit reusable workflow and Caller example.
- Plan-implement-review reusable workflows and Caller example.
- Adopt, Releases, security-model, and flow documentation.
- Copilot inert archive and restore path.
- Companion library pointer (Matt Pocock's skills) and Issuebridge reference Consumer checklist.
- Maintainer cut tooling: whole-kit snapshot manifest, verification script, and `cut-release.sh`.
- First public whole-kit snapshot (workflows, skills, docs, Copilot archive).

Beta, rc, and stable cuts **require** a `CHANGELOG.md` section and a GitHub Release body. See `docs/cutting-releases.md`.
