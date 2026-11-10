<div align="center">
  <img src="docs/assets/logo.svg" width="128" height="128" alt="Agent-kit logo">
  <h1>Agent-kit</h1>
</div>

<p align="center">
  <a href="https://github.com/mnaimfaizy/agent-kit/actions/workflows/ci.yml"><img src="https://github.com/mnaimfaizy/agent-kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/mnaimfaizy/agent-kit/actions/workflows/links.yml"><img src="https://github.com/mnaimfaizy/agent-kit/actions/workflows/links.yml/badge.svg" alt="External links"></a>
  <a href="https://github.com/mnaimfaizy/agent-kit/commits/main"><img src="https://img.shields.io/github/last-commit/mnaimfaizy/agent-kit" alt="Last commit"></a>
  <br>
  <a href="https://github.com/mnaimfaizy/agent-kit/releases"><img src="https://img.shields.io/github/v/release/mnaimfaizy/agent-kit?include_prereleases&sort=semver&label=release" alt="Release"></a>
  <a href="https://www.npmjs.com/package/@mnaimfaizy/agent-kit"><img src="https://img.shields.io/npm/v/%40mnaimfaizy%2Fagent-kit?label=npm%20cli" alt="npm"></a>
  <a href="cli/package.json"><img src="https://img.shields.io/node/v/%40mnaimfaizy%2Fagent-kit?label=node" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <br>
  <a href="https://www.conventionalcommits.org/"><img src="https://img.shields.io/badge/Conventional%20Commits-1.0.0-fe5196?logo=conventionalcommits&logoColor=white" alt="Conventional Commits"></a>
  <a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/runs-Claude%20Code-d97757" alt="Runs Claude Code"></a>
</p>

A kit of agent skills and reusable GitHub Actions workflows that runs [Claude Code](https://docs.anthropic.com/en/docs/claude-code) inside your repository. You adopt it by tag. Your repository (the **Consumer**) keeps everything product-specific.

It ships two **First-class flows**:

| Flow                          | What it does                                                                                                                               | Trigger (in your Caller)                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **Security audit**            | Threat-led Medium+ audit of the whole repo (`full`) or a PR diff (`pr`). Findings go only to a private draft security advisory.            | Schedule, manual dispatch, or a PR label                               |
| **Plan → implement → review** | Plans an issue, implements the Verified plan as a draft PR, reviews PRs on three axes (Standards, Spec, Correctness). Nothing auto-merges. | `agent:plan` / `agent:implement` issue labels, `agent:review` PR label |

Every flow is gated by a **Kill switch**, an **Allowlist**, and a consumed **Trigger label**, and treats issue/PR text as untrusted data. See [docs/security-model.md](docs/security-model.md).

> **Status:** pre-release (`1.0.0-beta`). `v1.0.0-alpha.1` and `v1.0.0-alpha.2` are **broken** (GitHub rejects their workflow files); use `v1.0.0-alpha.3` or later.

## Quickstart

Full walkthrough, including prerequisites: **[docs/getting-started.md](docs/getting-started.md)**.

**With the CLI** (Node.js 22 or later and `git`), from a clean checkout of your repository:

```bash
npx @mnaimfaizy/agent-kit init --tag v1.0.0-beta.2
```

It copies the Kit-owned paths, writes the Caller workflows and a Threat pack skeleton, and prints the secrets, labels and Kill switch steps as `gh` commands for you to run. It writes only local files and commits nothing. See [The CLI](#the-cli).

**By hand**, the short version:

1. **Pick a tag.** Use the latest from [Releases](https://github.com/mnaimfaizy/agent-kit/releases), e.g. `v1.0.0-beta.2`.
2. **Copy the Kit-owned paths from that same tag** into your repository. The loop reads [`kit-owned-paths.txt`](kit-owned-paths.txt) from the tag, deletes each path, then copies it fresh, so files the kit removes don't linger after an upgrade. Your own skills in `.claude/skills/` are left alone.

   ```bash
   TAG=v1.0.0-beta.2
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

   Tags up to `v1.0.0-alpha.10` have no `kit-owned-paths.txt`; for those, copy the paths [Adopt](docs/adopt.md#copy-kit-owned-paths-from-the-same-tag) lists.

3. **Add secrets:** `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), plus `AGENT_KIT_ADVISORIES_TOKEN` for the audit.
4. **Copy a Caller** from [`examples/`](examples) into `.github/workflows/`, set your login in `allowlist_actors`, and keep the `@<tag>` pin equal to step 1.
5. **Turn it on:** set the repository variable `CLAUDE_PIPELINE_ENABLED` and/or `CLAUDE_SECURITY_AUDIT_ENABLED` to `true`.

## The CLI

[`@mnaimfaizy/agent-kit`](https://www.npmjs.com/package/@mnaimfaizy/agent-kit) adopts, checks and upgrades the kit in a Consumer. The package holds only code: kit files are always read from the git tag your `uses:` pins name. Its version matches the Release line.

| Command               | What it does                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init --tag <tag>`    | First adoption: copies the Kit-owned paths, writes the Callers and the Threat pack skeleton, prints the GitHub-side steps as `gh` commands.                  |
| `doctor`              | Read-only check of Kit-owned paths, pins, secrets, variables, labels, the Claude GitHub App and rulesets. `--ci` checks only paths and pins, for a PR check. |
| `upgrade --tag <tag>` | Replaces each Kit-owned path from the new tag and rewrites the `@<tag>` of every Agent-kit pin, then prints the `examples/` diff to apply by hand.           |

Run each with `npx @mnaimfaizy/agent-kit <command>`. `init` and `upgrade` ask before writing, change only local files and commit nothing. Details: [cli/README.md](cli/README.md), [checking a setup with `doctor`](docs/getting-started.md#check-the-setup-with-doctor) and [upgrading](docs/getting-started.md#upgrading).

## What ships

| Path                                 | Purpose                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/*-reusable.yml`   | Reusable job bodies. Consumers reference these with `uses:`; never copy them.                                                                       |
| `.github/agent-runtime/`             | PreToolUse hooks confining reads to the workspace and the implementer's writes and pushes, plus a git-config check. Copy.                           |
| `.github/agent-pipeline/`            | Planner prompt, implementer instructions, draft-PR fallback script. Copy.                                                                           |
| `.github/security-audit/`            | Audit prompt, advisory publisher, PR counts comment, optional email notifier. Copy.                                                                 |
| `.claude/skills/`                    | **Portable skills**: `code-review`, `security-audit`, `security-finding-triage`, `security-response`, `explainer`, `instruction-drift-audit`. Copy. |
| `kit-owned-paths.txt`                | The list of paths above that you copy from a tag and replace whole on upgrade.                                                                      |
| `examples/`                          | Caller templates and setup presets to copy and edit.                                                                                                |
| `cli/`                               | Source of the `@mnaimfaizy/agent-kit` npm CLI. Run with `npx`; never copy.                                                                          |
| `.github/workflows-archive/copilot/` | Inert **Copilot archive** — an alternative runner, never live alongside Claude.                                                                     |

Not vendored: Consumer Threat pack (threat model + findings ledger), product playbooks, Companion skills (`implement`, `tdd`, `wayfinder`, …), subagent definitions.

## Use one skill without adopting the kit

Each Portable skill can be installed on its own, pinned to a release tag, with the `npx skills` CLI: `npx skills add mnaimfaizy/agent-kit#<tag> --skill <name>`. Which skills work from your own skills directory and which need a repository, and the exact command for each: **[Install individual skills](docs/install-skills.md)**. If you adopt the kit, skip it: adoption already copies every skill.

## Companion library

For procedure skills such as `implement`, `tdd`, and `wayfinder`, adopt **[Matt Pocock's skills](https://github.com/mattpocock/skills)** separately — copy from that repo or use its Claude plugin. That library is not on the Agent-kit Release line; this README does not pin a version for it.

## Documentation

| Doc                                                        | For                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md)                 | Step-by-step first adoption, secrets, variables, labels, troubleshooting      |
| [Adopt](docs/adopt.md)                                     | Split contract: tag-pinned `uses:` + same-tag file copy; upgrades; Dependabot |
| [Install individual skills](docs/install-skills.md)        | One Portable skill at a time with `npx skills`, without adopting the kit      |
| [Security audit](docs/security-audit.md)                   | `full` / `pr` modes, private delivery, Threat pack                            |
| [Plan → implement → review](docs/plan-implement-review.md) | Labels, Verified plan, implementer and reviewer contracts                     |
| [Workflow reference](docs/reference.md)                    | Every input, secret, and required permission (generated)                      |
| [Security model](docs/security-model.md)                   | Public-log rule, trust boundaries, runner controls                            |
| [Repository hardening](docs/repository-hardening.md)       | Rulesets for the default branch, release branches and release tags            |
| [CLI](cli/README.md)                                       | `init`, `doctor` and `upgrade` in full                                        |
| [Releases](docs/releases.md)                               | Whole-kit SemVer, pre-release stages, changelog policy                        |
| [Cutting releases](docs/cutting-releases.md)               | Maintainers: how to tag a release                                             |
| [Copilot restore](docs/copilot-restore.md)                 | Swapping the runner to the inert Copilot archive                              |
| [Issuebridge](docs/issuebridge.md)                         | Reference Consumer target state + stand-up checklist                          |
| [Decision records](docs/adr/)                              | Why the CLI ships on npm and skills install with `npx skills`                 |
| [GLOSSARY.md](GLOSSARY.md)                                 | Glossary of the terms used across these docs                                  |
| [CHANGELOG.md](CHANGELOG.md)                               | Release history                                                               |

Distribution is tags only, including skill installs: no Marketplace listing, no binaries, and no skills zip.

## Contributing

Local setup, checks, dogfood flows, and release steps: **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Security

Report kit vulnerabilities privately through GitHub Security Advisories. Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
