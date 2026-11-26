---
status: proposed
---

# A Stage's Run Record counts only what the kit itself runs

Every Stage run of a Factory task, on either Factory engine, writes its own Run Record (`run.kind: "stage"`, schema `run-record/2`). Its numbers come only from parts the kit owns, never from the harness's transcript:

- **The model proxy:** tokens per model (input, output, cache) and `model_requests`, a request count, not "turns".
- **The Guards and the Launcher:** `denials` (refusals the kit's own Guards made), `exit` as an enum (`completed | turn-cap | wall-clock | token-cap | crashed | no-result`), and the duration.

The record has no tool-call count and no cost field, not even a labelled estimate. The raw transcript is never parsed: it goes only to the expiring raw-folder sink when one is configured, and for a security Stage only where the audit already sends it (the private advisory or email).

Decided in [Run Records from Workflow engine Stages](https://github.com/mnaimfaizy/agent-kit/issues/488), on the map [Wayfinder: Agentic Software Factory](https://github.com/mnaimfaizy/agent-kit/issues/480), on the facts in [What a harness run hands back for a Run Record](https://github.com/mnaimfaizy/agent-kit/issues/484).

## Considered Options

- **A per-adapter reducer over each harness's stream, keeping only counts.** Rejected. It means five parsers of formats the kit does not control (Claude Code, Codex, Gemini CLI, opencode, Cursor), each giving a different subset. It also breaks the Consumer-chosen-harness spec's rule that the transcript is never parsed, which exists so that agent text cannot steer a trusted step.
- **Turns from the harness.** Rejected. Harnesses define a turn differently, and some report none, so the proxy's request count is the one number that means the same on every harness.
- **Cost as the harness's estimate, labelled with its source.** Rejected. No API returns cost, [ADR 0023](0023-a-deep-scan-runs-only-on-a-harness-a-model-proxy-can-front.md) rejected a price table, and an estimate that exists on one harness only cannot be compared across them. Tokens are the measured fact.
- **An interim path that reads `execution_file`'s `result` message before the Launcher lands.** Rejected. It would be a second source with different fields for the same record, retired as soon as the Launcher lands. Stage records are written only by Stages that run through the Launcher.

## Consequences

- Any budget or spend cap the factory reads from Run Records is in tokens, not money.
- A harness the proxy cannot front writes no token counts (absent, not zero).
- Tool-call counts are gone until the kit runs something that sees each call itself.
