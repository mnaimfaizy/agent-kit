# Copilot restore path (inert archive)

Agent-kit ships a generalized Copilot archive as an optional restore path, not a live first-class runner.

## Archive location

The inert archive is under `.github/workflows-archive/copilot/`.
Those files do not execute until moved into `.github/workflows/` on the default branch.

## Choose-one restore flow

Restore is mutually exclusive with Claude callers:

1. Archive Claude caller workflows first (move them out of `.github/workflows/`).
2. Move Copilot archive YAML into `.github/workflows/`.
3. Enable only Copilot kill-switch variables.

Kill-switch names intentionally differ:

- Claude path: `CLAUDE_PIPELINE_ENABLED`, `CLAUDE_SECURITY_AUDIT_ENABLED`
- Copilot archive path: `AGENT_KIT_COPILOT_PIPELINE_ENABLED`, `AGENT_KIT_COPILOT_SECURITY_AUDIT_ENABLED`

This separation prevents silently enabling both generations.

## Prompt-pack fork

The Copilot archive reads prompts from `.github/workflows-archive/copilot/prompts/`.
It does not read the live Claude prompt pack.

## Contract continuity on restore

After restore, the same first-class-flow contracts still apply:

- gates (kill switch, allowlist, trigger-label consumption)
- trusted verified plan only for implement
- draft PR only, no merge/approve/ready by the implementer
- no workflow edits in implement contract
- review is on-demand three-axis with no auto-fix loop
- security audit keeps private delivery and counts-only public comments

## First-party GitHub alternatives (later)

GitHub Agentic Workflows and Copilot automations are first-party options and may evolve quickly, but they are out of scope for this v1 kit path. This document intentionally does not define them as an Agent-kit import workflow.
