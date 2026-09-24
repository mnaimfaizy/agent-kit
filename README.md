# Agent-kit

[![CI](https://github.com/mnaimfaizy/agent-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/mnaimfaizy/agent-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A kit of agent skills and reusable GitHub Actions workflows that runs [Claude Code](https://docs.anthropic.com/en/docs/claude-code) inside your repository. You adopt it by tag. Your repository (the **Consumer**) keeps everything product-specific.

It ships two **First-class flows**:

| Flow                          | What it does                                                                                                                               | Trigger (in your Caller)                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **Security audit**            | Threat-led Medium+ audit of the whole repo (`full`) or a PR diff (`pr`). Findings go only to a private draft security advisory.            | Schedule, manual dispatch, or a PR label                               |
| **Plan → implement → review** | Plans an issue, implements the Verified plan as a draft PR, reviews PRs on three axes (Standards, Spec, Correctness). Nothing auto-merges. | `agent:plan` / `agent:implement` issue labels, `agent:review` PR label |

Every flow is gated by a **Kill switch**, an **Allowlist**, and a consumed **Trigger label**, and treats issue/PR text as untrusted data. See [docs/security-model.md](docs/security-model.md).

> **Status:** pre-release (`1.0.0-alpha`). `v1.0.0-alpha.1` and `v1.0.0-alpha.2` are **broken** (GitHub rejects their workflow files); use `v1.0.0-alpha.3` or later.

## Quickstart

Full walkthrough: **[docs/getting-started.md](docs/getting-started.md)**. Short version:

1. **Pick a tag.** Use the latest from [Releases](https://github.com/mnaimfaizy/agent-kit/releases), e.g. `v1.0.0-alpha.3`.
2. **Copy the runtime files from that same tag** into your repository:

   ```bash
   TAG=v1.0.0-alpha.3
   git clone --depth 1 --branch "$TAG" https://github.com/mnaimfaizy/agent-kit.git /tmp/agent-kit
   mkdir -p .claude/skills .github
   cp -R /tmp/agent-kit/.claude/skills/. .claude/skills/
   cp -R /tmp/agent-kit/.github/agent-runtime /tmp/agent-kit/.github/agent-pipeline /tmp/agent-kit/.github/security-audit .github/
   ```

3. **Add secrets:** `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), plus `AGENT_KIT_ADVISORIES_TOKEN` for the audit.
4. **Copy a Caller** from [`examples/`](examples) into `.github/workflows/`, set your login in `allowlist_actors`, and keep the `@<tag>` pin equal to step 1.
5. **Turn it on:** set the repository variable `CLAUDE_PIPELINE_ENABLED` and/or `CLAUDE_SECURITY_AUDIT_ENABLED` to `true`.

## What ships

| Path                                 | Purpose                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/*-reusable.yml`   | Reusable job bodies. Consumers reference these with `uses:`; never copy them.                                    |
| `.github/agent-runtime/`             | PreToolUse hook confining Read/Grep/Glob to the workspace. Copy.                                                 |
| `.github/agent-pipeline/`            | Planner prompt, implementer instructions, draft-PR fallback script. Copy.                                        |
| `.github/security-audit/`            | Audit prompt, advisory publisher, optional email notifier. Copy.                                                 |
| `.claude/skills/`                    | Four **Portable skills**: `code-review`, `security-audit`, `security-finding-triage`, `security-response`. Copy. |
| `examples/`                          | Caller templates to copy and edit.                                                                               |
| `.github/workflows-archive/copilot/` | Inert **Copilot archive** — an alternative runner, never live alongside Claude.                                  |

Not vendored: Consumer Threat pack (threat model + findings ledger), product playbooks, Companion skills (`implement`, `tdd`, `wayfinder`, …), subagent definitions.

## Companion library

For procedure skills such as `implement`, `tdd`, and `wayfinder`, adopt **[Matt Pocock's skills](https://github.com/mattpocock/skills)** separately — copy from that repo or use its Claude plugin. That library is not on the Agent-kit Release line; this README does not pin a version for it.

## Documentation

| Doc                                                        | For                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md)                 | Step-by-step first adoption, secrets, variables, labels, troubleshooting      |
| [Adopt](docs/adopt.md)                                     | Split contract: tag-pinned `uses:` + same-tag file copy; upgrades; Dependabot |
| [Security audit](docs/security-audit.md)                   | `full` / `pr` modes, private delivery, Threat pack                            |
| [Plan → implement → review](docs/plan-implement-review.md) | Labels, Verified plan, implementer and reviewer contracts                     |
| [Workflow reference](docs/reference.md)                    | Every input, secret, and required permission (generated)                      |
| [Security model](docs/security-model.md)                   | Public-log rule, trust boundaries, runner controls                            |
| [Releases](docs/releases.md)                               | Whole-kit SemVer, pre-release stages, changelog policy                        |
| [Cutting releases](docs/cutting-releases.md)               | Maintainers: how to tag a release                                             |
| [Copilot restore](docs/copilot-restore.md)                 | Swapping the runner to the inert Copilot archive                              |
| [Issuebridge](docs/issuebridge.md)                         | Reference Consumer target state + stand-up checklist                          |
| [CONTEXT.md](CONTEXT.md)                                   | Glossary of the terms used across these docs                                  |
| [CHANGELOG.md](CHANGELOG.md)                               | Release history                                                               |

Distribution is tags only: no Marketplace listing, no binaries, and no skills zip.

## Contributing

Local setup, checks, dogfood flows, and release steps: **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Security

Report kit vulnerabilities privately through GitHub Security Advisories. Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
