# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Changed

- **Consumer action required:** re-copy `.github/agent-runtime/` from this tag. Plan, review, and audit now copy the read-confinement hook and its settings read-only to `$RUNNER_TEMP` before the agent starts and run that copy, so the hook no longer runs from a file in the workspace. The job fails with a message if `read-confinement.settings.json` still runs the hook from the workspace.
- Plan, review, and audit fail before publishing if the staged hook changed during the agent run.
- The planner and the audit agent deny edits to `.github/agent-runtime/`.

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
