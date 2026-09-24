# Security model

## Public-log rule

Security finding bodies must never appear in:

- GitHub Actions logs
- uploaded artifacts
- public issue or PR text

## Private delivery

The required sink for successful security-audit runs is a draft GitHub Security Advisory (GHSA). Optional email notifications are additive.

## Consumer ownership

Consumers own their threat pack paths, allowlists, kill switch controls, advisory token, and optional scanner wiring.

## Agent pipeline gates

Plan/implement/review reusable jobs require kill switch + allowlist + trigger-label consumption.

## Verified plan

Implement must use only a verified plan produced by the trusted plan job (trusted author + marker-at-start). Issue/PR text remains untrusted input.

## Trust boundaries

This repository's own [threat model](../security/threat-model.md) lists the assets, trust boundaries, and attack paths the dogfood audit walks. Consumers keep their own Threat pack.

## Runner seam

Runner seam is explicit and narrow:

- v1 live path is Claude Code in GitHub Actions reusable jobs.
- Copilot is an inert restore path (separate docs/contracts), not a second live first-class runner.
- No provider adapter layer is required in v1.

## Workflow controls

- Plan, review, and audit pass the job token into Claude. Only the implementer uses the Claude GitHub App (`id-token: write`, no `github_token` on that step).
- Checkouts set `persist-credentials: false`.
- A PreToolUse hook in `.github/agent-runtime/` denies Read/Grep/Glob outside the workspace, judged on the path with symlinks resolved. Review and audit restore that hook from the pull request base. Before the agent starts, each job copies the hook and its settings read-only to `$RUNNER_TEMP`, outside the workspace, and runs that copy; a digest check after the agent fails the job before anything is published.
- The implementer loads the same hook. Read confinement covers the Read/Grep/Glob tools only: an `extra_allowed_tools` entry that runs repository code (a test runner, a package manager, a formatter that loads plugins) lets the implementer read anything the runner user can, including the credentials in its own environment. Grant those only for repositories whose issue authors you trust.
- No agent is granted `git diff`, `git log`, or `git show`: a `Bash(git …:*)` rule matches a command prefix, not its flags, and those subcommands can write a file outside the workspace. Review and implement deny them outright. The reviewer reads a diff and commit list precomputed into its brief. Caller `verify_commands` run in a non-login shell.
- No agent holds `gh pr comment` or `gh pr create`: their `--body-file` reads any file the runner user can into a public post. The reviewer posts through its tracking comment and the inline-comment tool. The implementer opens its draft PR with the GitHub MCP server's `create_pull_request` tool, which takes the body as text and still acts as the Claude GitHub App.
- The Dependabot alerts token (optional) is used by one fetch step only and is not in the agent step.
- Caller-owned command inputs (`verify_commands`, `setup_commands`, `scan_command`) reach the shell through `env:` or a dedicated step, never spliced into another script.
- Third-party actions and container images are pinned by commit SHA or digest; `anthropics/claude-code-action` is bumped by hand.
- The audit agent has no Bash grant. Credentialed publish and email scripts are copied from a trusted commit to a directory outside the workspace and run only after a digest check. The advisory token is preflighted before the agent starts and is not in the agent step.
- `anthropics/claude-code-action` is pinned to a commit SHA.

## Private and org support

Public, private, and organization repositories use the same reusable security-audit job and same private sink.
