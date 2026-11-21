---
status: proposed
---

# Stage settings are named for the kit, not the harness, and the harness default lives in the reusable workflow

Once a Stage can run on a Harness other than Claude Code, `CLAUDE_PLAN_MODEL=gpt-5.5` reads wrong. So every repository variable a Consumer sets regardless of harness moves from `CLAUDE_` to `AGENT_KIT_`, and keeps ADR 0009's `<STAGE>_<SETTING>` order: Stage model, effort and Kill switch (deep scan included), the flow switches (`AGENT_KIT_AGENT_FLOW_ENABLED` and the others), the globals `AGENT_KIT_MODEL` and `AGENT_KIT_EFFORT`, and `AGENT_KIT_REVIEW_RESPONSE_MODE`. Names that configure Claude Code itself (`CLAUDE_CODE_VERSION`, the `CLAUDE_CODE_*` environment) stay. Each Stage gains `AGENT_KIT_<STAGE>_HARNESS`, which falls back to `AGENT_KIT_HARNESS` and then to `claude-code`. It is passed to a new optional `harness` input and checked against a fixed list (`claude-code`, `codex`, `gemini`, `opencode`, `cursor`) before the agent starts.

A model now resolves in the Caller as the Stage's variable, then `AGENT_KIT_MODEL`, then `''`. When `model` is empty, the reusable workflow fills in the default for that Stage's harness. This amends ADR 0009, which kept the kit default in the Caller: a Caller that hardcodes a Claude model id would give that id to a Codex Stage. Effort already resolves to `''`.

Secret inputs keep their provider's name, because a credential belongs to one provider and a neutral name would hide which one it is. `claude_code_oauth_token` and `anthropic_api_key` stay as they are. Each further provider gets an input named after itself (`openai_api_key` and the like). Every model credential becomes `required: false`, and a step fails the run when the chosen harness's credential was not passed.

## Considered Options

- **Keep `CLAUDE_*`.** Rejected. The name would misstate the setting for every non-Claude Stage, for good.
- **`AGENT_<STAGE>_<SETTING>`.** Rejected. It is shorter but could clash with variables a Consumer already has.
- **One-release fallbacks (`vars.AGENT_KIT_X || vars.CLAUDE_X`).** Rejected for the same reason ADR 0009 rejected them: the Callers are Consumer copies, so the chains would never go away. This is a clean cut in beta, per ADR 0010. It needs no fallback anyway, because the reusable workflows' inputs (`model`, `effort`, `kill_switch`, `response_mode`) carry no `CLAUDE_` and do not change, so an existing Caller keeps working against a new tag.
- **Per-harness globals (`AGENT_KIT_CODEX_MODEL`).** Rejected. Each new harness would add more variables, and a Stage model already covers a mixed setup.
- **A single `harness_credential` secret.** Rejected. It hides the provider, and one repository may need two credentials at once.

## Consequences

- Copying the new example Caller turns a repository's Agent flow off until `AGENT_KIT_AGENT_FLOW_ENABLED` is set, the same way ADR 0009's rename did. That includes this repository's dogfood.
- Every rename goes into the Deprecation register and doctor's `RENAMED_VARIABLES`, so the existing "still set under the old name" warning covers them.
- Doctor stops failing on a missing `claude_code_oauth_token`, because that input is no longer required. Reporting the credential for each Stage's resolved harness belongs to the per-harness doctor work.
