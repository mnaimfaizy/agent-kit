---
status: proposed
---

# Every Stage runs through Agent-kit's Launcher

Every Stage, on every harness, Claude Code included, is started by one **Launcher** that Agent-kit owns. The Launcher lives in the npm CLI. The reusable workflows install the pinned `agent-kit` CLI and call it, the way the Deep scan's CI path already runs `agent-kit deep-scan`, so the workflows and a maintainer's machine share one set of harness adapters. The workflow keeps the trusted steps around the agent; the Launcher starts the harness, hands it the brief and collects the result.

In CI the Launcher also runs the model proxy core from [ADR 0023](0023-a-deep-scan-runs-only-on-a-harness-a-model-proxy-can-front.md) with the Stage's provider profile, so on every harness the proxy can front, the agent holds only a placeholder and never the real model credential, and the profile's body filter refuses server-side tools. Cursor CLI, which the proxy cannot front, holds its own key and is never offered for a security Stage.

The model credentials each harness accepts in CI, completing [ADR 0022](0022-stage-settings-are-named-for-the-kit-not-the-harness.md):

| Harness | Accepted credential |
|---|---|
| Claude Code | `claude_code_oauth_token` or `anthropic_api_key` |
| Codex CLI | `openai_api_key` |
| Gemini CLI | `gemini_api_key` |
| opencode | the key of a provider that has a profile |
| Cursor CLI | `cursor_api_key` |

`anthropics/claude-code-action` is transitional. A Stage keeps its Claude Code path on the action until the Launcher's Claude Code adapter reaches `verified` for that Stage, and then the action is dropped from it. Nothing changes for a Consumer on Claude Code until then.

Decided in [CI runner for non-Claude harnesses](https://github.com/mnaimfaizy/agent-kit/issues/443), on the map [Wayfinder: Stages run on a Consumer-chosen harness](https://github.com/mnaimfaizy/agent-kit/issues/438).

## Considered Options

- **Keep `claude-code-action` as the permanent Claude path, with the Launcher beside it.** Rejected. Every non-Claude harness needs Agent-kit's own GitHub layer anyway (no other harness's action supplies it), so this keeps two GitHub layers and two trust models for good.
- **Use each harness's official action where one exists** (`openai/codex-action`, `google-github-actions/run-gemini-cli`). Rejected. They are runners only, with no trigger, token, progress comment or review tools, so they add a third shape; and `run-gemini-cli` copies the whole prompt into the job summary, which breaks the Public-log rule for a security audit.
- **Sandcastle as a dependency.** Rejected; its `AgentProvider` shape is the reference instead. It is pre-1.0, it always turns the harness's own permissions off and treats its sandbox as the only boundary, and it has no network cut, while Agent-kit's Stages need both those and [ADR 0005](0005-review-responder-holds-no-write-credential.md).
- **The real model key in the agent's environment in CI**, as today. Rejected for every harness the proxy can front: the proxy core already exists for the Deep scan, and `codex-action`'s key proxy shows the same pattern.
- **Codex workload identity (GitHub OIDC) and ChatGPT sign-in, Gemini on Vertex AI.** Left out of v1, matching ADR 0023.

## Consequences

- How the agent is kept from the Launcher's process and its real key on a CI runner (a separate user, a container, dropping sudo) is decided in [Trust enforcement on every harness](https://github.com/mnaimfaizy/agent-kit/issues/444).
- The Launcher's Stage subcommand and what an adapter plugs into are decided in [Harness adapter contract](https://github.com/mnaimfaizy/agent-kit/issues/447); what the Launcher's GitHub layer supplies, in [GitHub layer for non-Claude Stages](https://github.com/mnaimfaizy/agent-kit/issues/449).
- When each Stage leaves `claude-code-action`, and the evidence for its Claude Code adapter reaching `verified`, belong to [Rollout order and starting Support Levels](https://github.com/mnaimfaizy/agent-kit/issues/448).
- A reusable workflow pins the CLI it installs to its own release, as `deep-scan-reusable.yml` does.
