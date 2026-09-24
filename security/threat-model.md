# Agent-kit threat model

Threat pack for the dogfood security audit of this repository. Scope is the kit itself: reusable workflows, their helper scripts, the read-confinement hook, and the Portable skills. Consumer-side threats (their product code, their secrets) are out of scope.

> Draft. Review and adjust before enabling the dogfood audit.

## Assets

| Asset                       | Where                                       | Why it matters                                                    |
| --------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`   | Agent steps of every reusable workflow      | Model access billed to the owner; exfiltration = spend + abuse    |
| Advisories token            | Audit Gate + publish steps only             | Writes draft security advisories; must never reach the agent      |
| Dependabot alerts token     | Audit alerts-fetch step only                | Reads private alert data                                          |
| Job token (`github.token`)  | gh calls in every reusable workflow         | Scoped by Caller permissions; issue/PR write in pipeline jobs     |
| Claude GitHub App token     | Implement agent step                        | Can push branches and open PRs                                    |
| Security findings           | Report file, session transcript, draft GHSA | Public-log rule: never in Actions logs, artifacts, or public text |
| Workflow + prompt integrity | `.github/`, `.claude/skills/`, `CLAUDE.md`  | Whoever edits these steers every Consumer on the next tag         |
| Release tags                | `v*` tags                                   | Consumers pin them; a moved or poisoned tag ships to all Callers  |

## Trust boundaries

1. **Issue / PR text → agent.** Untrusted. Fenced in the brief; only the Verified plan is actionable for implement.
2. **PR head → review/audit runtime.** Untrusted. Instructions, skills, and the read-confinement hook are restored from the PR base before the agent runs.
3. **Agent workspace → credentialed steps.** The agent can write the workspace; later credentialed steps must only run scripts staged from a trusted commit and digest-checked.
4. **Agent → runner filesystem.** Read/Glob/Grep are confined to the workspace by the PreToolUse hook; `.git/` reads are denied.
5. **Caller → reusable workflow.** Caller-owned inputs (`scan_command`, `verify_commands`, `setup_commands`, `extra_allowed_tools`) run with job privileges; they are trusted but must not be derivable from issue/PR text.
6. **Maintainer → tag.** Only the default branch is tagged; tags are never moved.

## Attack paths to walk

- **Prompt injection** via issue body, comments, PR diff, or file contents that makes the agent: run a denied tool, write outside the workspace, print findings to stdout, open a non-draft PR, or approve/merge.
- **Self-modifying PR**: a PR that edits a reusable workflow, prompt, skill, `CLAUDE.md`, `.claude/`, or the hook so its own review/audit runs weakened instructions.
- **Token exposure**: any secret reachable from an agent step's env, `.git/config` (`persist-credentials`), gh config dir, or a file the agent can read.
- **Staged-script bypass**: workspace copy of a credentialed script executed instead of the staged, digest-checked copy.
- **Tool grant widening**: `extra_allowed_tools` grammar escape, Bash prefix rules that admit writes (`--output=`), `Bash(gh:*)`.
- **Expression injection**: `${{ }}` interpolating attacker-influenced values directly into `run:` scripts.
- **Trigger loops / privilege mix-ups**: label not consumed, `pull_request_target` introduced, fork PRs receiving secrets, allowlist bypass.
- **Supply chain**: third-party actions not pinned by SHA; mutable Docker tags; Companion skills pulled unpinned into the runtime.
- **Public-log rule breach**: report fields echoed without closed-pattern validation; artifacts uploaded; counts comment carrying detail.

## Out of scope

- Consumer product code and Consumer Threat packs.
- The Copilot archive while inert (not under `.github/workflows/`).
- GitHub platform and Anthropic service vulnerabilities.
