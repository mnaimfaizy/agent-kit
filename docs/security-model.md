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
- A PreToolUse hook in `.github/agent-runtime/` denies Read/Grep/Glob outside the workspace, judged on the path with symlinks resolved, and for Glob on the pattern too: an absolute pattern, a `..` segment, or a literal prefix that resolves outside is refused. Review and audit restore that hook from the pull request base, after rewriting the checkout with the content-changing git attributes pinned off, so a pull request's `.gitattributes` cannot re-encode what is restored. Before the agent starts, each job copies the hook and its settings read-only to `$RUNNER_TEMP`, outside the workspace, runs that copy, and fails unless it refuses an out-of-tree read; a digest check after the agent fails the job before anything is published. The settings run every hook with `|| exit 2`, because Claude Code treats a hook that crashes as a non-blocking error: a hook that cannot decide blocks the call. The diffs precomputed for review and audit ignore the pull request's attributes (`--text --no-ext-diff --no-textconv`), so no change shows as binary.
- The Claude GitHub App holds `workflows: write`, and a same-repository PR runs the branch's own workflow files with repository secrets. The implementer is denied edits under `.github/workflows/` and `.github/actions/`, and a second staged hook refuses any push whose branch changes those paths, before the push. The push must run as its own command, so no commit can land after the check. The hook judges pushes through the action's wrapper only: code run through `extra_allowed_tools` acts with the App token and is outside it, which is one more reason to grant such entries only for trusted issue authors.
- The implementer loads the same read-confinement hook. Read confinement covers the Read/Grep/Glob tools only: an `extra_allowed_tools` entry that runs repository code (a test runner, a package manager, a formatter that loads plugins) lets the implementer read anything the runner user can, including the credentials in its own environment, and act with the Claude GitHub App token. Grant those only for repositories whose issue authors you trust, and protect the default branch and release tags with rulesets the App cannot bypass. The implementer pushes only through the action's wrapper, which takes a branch name and no flags, but code it runs holds the App token.
- Claude Code also loads the checkout's project settings. Review and PR-mode audit restore `.claude/` and `.mcp.json` from the pull request base, so a pull request cannot change them, but permission rules and hooks the Consumer commits to `.claude/settings.json` apply to every agent on top of the reviewed grants.
- An `--allowedTools` entry only pre-approves a tool; leaving one out does not withhold it, because Claude Code auto-approves read-only Bash commands inside the workspace. Plan and audit need no Bash, so they deny it outright.
- No agent is granted `git diff`, `git log`, or `git show`: a `Bash(git …:*)` rule matches a command prefix, not its flags, and those subcommands can write a file outside the workspace. Review and implement deny them outright. The reviewer reads a diff and commit list precomputed into its brief. Caller `verify_commands` run in a non-login shell.
- No agent holds `gh pr comment` or `gh pr create`: their `--body-file` reads any file the runner user can into a public post. The reviewer posts through its tracking comment and the inline-comment tool. The implementer opens its draft PR with the GitHub MCP server's `create_pull_request` tool, which takes the body as text and still acts as the Claude GitHub App.
- The Dependabot alerts token (optional) is used by one fetch step only and is not in the agent step.
- Caller-owned command inputs (`verify_commands`, `setup_commands`, `scan_command`) reach the shell through `env:` or a dedicated step, never spliced into another script. They are code the job runs: a Caller must never build them from issue or PR text, or the job runs that text.
- `verify_commands` run code the implementer wrote, so they run in their own job with `contents: read` and no OIDC token, on the agent's pushed branch. Only the implement job holds write and OIDC credentials, and after the agent it runs only checks. The draft-PR fallback runs from the trusted commit in a job without `id-token`. The implementer is told to open a draft, and a separate job with no checkout converts a same-repository PR from its branch back to draft if it was opened ready for review. It needs only the implement job, so it runs even when verify fails.
- Third-party actions and container images are pinned by commit SHA or digest; `anthropics/claude-code-action` is bumped by hand.
- The audit agent is denied Bash. Credentialed publish and email scripts are copied from a trusted commit to a directory outside the workspace and run only after a digest check. The advisory token is preflighted before the agent starts, with a create request whose empty body can never create an advisory, and is not in the agent step. If publishing fails after retries, the full report goes only to the configured notify mailbox; the routine email is counts-only. The email notifier verifies the SMTP server's certificate and hostname before it upgrades with STARTTLS and logs in.
- `anthropics/claude-code-action` is pinned to a commit SHA.

## Private and org support

Public, private, and organization repositories use the same reusable security-audit job and same private sink.
