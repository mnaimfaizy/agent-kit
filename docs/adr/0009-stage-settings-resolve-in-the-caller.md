---
status: accepted
---

# Each Stage's model, effort and Kill switch resolve in the Caller, under one naming pattern

Each Stage (plan, implement, review, review response, security audit) gets its own model, effort and Kill switch, so a Consumer can put a cheaper model or a lower effort on the Stages that don't need more. The Caller resolves every setting from repository variables named `CLAUDE_<STAGE>_<SETTING>`, with the tokens `PLAN`, `IMPLEMENT`, `REVIEW`, `REVIEW_RESPONSE` and `SECURITY_AUDIT`. A model resolves as the Stage's variable, then `CLAUDE_MODEL`, then the kit default. Effort resolves as the Stage's variable, then `CLAUDE_EFFORT`, then nothing: with no value, `--effort` is left off so the model's own default applies, because the kit would otherwise be guessing a level for models whose defaults differ and change. The reusable workflows take `model` and `effort` as inputs and check both against a strict pattern before the agent starts, because both are pasted into `claude_args`.

## Kill switches default the opposite way on purpose

A flow's own switch must be exactly `true` for the flow to run: `CLAUDE_AGENT_FLOW_ENABLED` (the master switch for the Agent flow), `CLAUDE_SECURITY_AUDIT_ENABLED` and `CLAUDE_REVIEW_RESPONSE_ENABLED`. A Stage switch inside the Agent flow (`CLAUDE_PLAN_ENABLED`, `CLAUDE_IMPLEMENT_ENABLED`, `CLAUDE_REVIEW_ENABLED`) can only turn its Stage off, with `false`, and counts as on when unset. A Stage of the Agent flow runs only when both allow it. Both kinds end in `_ENABLED`. This keeps the safe default (no flow runs until a person turns it on) and lets a Consumer that never sets a Stage switch keep the behaviour of having one switch for the whole flow. Review response stays outside the master switch: it is its own First-class flow with its own Trigger label, and it works on pull requests the Agent flow didn't open.

## Considered Options

- **Keep `CLAUDE_MODEL_<FLOW>` and add `CLAUDE_EFFORT_<FLOW>`.** Rejected. Switches were already `CLAUDE_<FLOW>_ENABLED`, so this would keep two patterns forever.
- **`CLAUDE_PIPELINE_<STAGE>_<SETTING>`.** Rejected. It puts the word the glossary avoids into every name.
- **Old names as fallbacks in the Callers.** Rejected. A Caller is the Consumer's own copy, so an old Caller keeps working on old variables until it is replaced. Fallback chains would never be removed. The rename is a clean cut while the kit is still in beta, and `doctor` warns when an old variable is still set but the Caller reads the new one.
- **Stage switches that are off by default, or a `_DISABLED` suffix.** Rejected. The first would turn every existing Agent flow off. The second is a negative switch.
- **A table of which models support which effort levels.** Rejected. It would go stale with every model release. The CLI rejects a pairing it doesn't support, and the workflow log shows why.

## Consequences

- Renaming the master switch turns a repository's Agent flow off until `CLAUDE_AGENT_FLOW_ENABLED` is set, because an unset master switch means off. That includes this repository's dogfood.
