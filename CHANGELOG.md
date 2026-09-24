# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

## [1.0.0-alpha.2] - 2026-09-24

### Changed

- Plan, implement, review, and security-audit reusable workflows now run Claude Code with the controls landed on the Issuebridge reference Consumer: SHA-pinned action, job-token GitHub auth for every job except the implementer, `persist-credentials: false`, a PreToolUse hook that confines Read/Grep/Glob to the workspace, reviewed tool allowlists, staged credentialed audit scripts, and an advisory-token preflight before the audit agent runs.
- Review is a pull-request job (`pr_number`, `head_sha`, `base_sha`, `base_ref`). Callers pass `claude_code_oauth_token`. The audit Caller also passes `github_token`.

## [1.0.0-alpha.1] - 2026-08-19

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
