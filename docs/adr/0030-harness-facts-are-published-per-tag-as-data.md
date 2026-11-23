---
status: proposed
---

# Harness facts are published per tag as data, and every Caller passes every model secret

`agent-kit doctor` and `agent-kit init` need to know things about each harness: the secrets it accepts, which one is preferred and where to get it, the effort values it accepts (or that it has no effort setting), and the Support Level of each harness and Stage pair ([ADR 0028](0028-a-security-stage-runs-only-on-a-harness-with-a-recorded-run.md)). Those facts have to be the ones of the Callers' **pinned tag**, not of whichever CLI version is installed. Adapters are code ([ADR 0027](0027-a-harness-adapter-returns-a-launch-plan-as-data.md)), and doctor never runs code it fetched from a tag.

So every kit tag ships one generated file, `harnesses.json`, holding those facts for every built-in harness. The Support Level table of ADR 0028 is that same file. A contract test keeps it equal to the adapters. Preflight, the docs, doctor and `init` all read it; doctor and `init` read it from the pinned tag's snapshot, the same way doctor already reads the reusable workflows. The JSON Schema for a Custom harness file ships beside it, so a Custom harness is checked against the pinned tag's schema too.

A tag without `harnesses.json` predates harness choice. Doctor lists its harness checks as skipped and warns about any `AGENT_KIT_*_HARNESS` variable as ignored; `init` accepts only `claude-code` with such a tag.

Every example Caller job passes **every** provider secret input (`claude_code_oauth_token`, `anthropic_api_key`, `openai_api_key`, `gemini_api_key` and any later one), each optional ([ADR 0022](0022-stage-settings-are-named-for-the-kit-not-the-harness.md)). A Stage changes harness by one repository variable and one secret, never by a Caller edit.

Decided in [Doctor and init per harness](https://github.com/mnaimfaizy/agent-kit/issues/452), on the map [Wayfinder: Stages run on a Consumer-chosen harness](https://github.com/mnaimfaizy/agent-kit/issues/438).

## Considered Options

- **Doctor uses the installed CLI's own adapters**, warning when the CLI version differs from the pin. Rejected. A Consumer who upgrades the CLI before the pin would be checked against facts their runs do not use.
- **Doctor imports the adapters from the pinned snapshot.** Rejected. It runs code fetched from a tag in the process that holds a `gh` login.
- **A separate Support Level table beside the harness facts.** Rejected. Two files would have to agree, and preflight reads both anyway.
- **Each Caller passes only the chosen harness's secret.** Rejected. Changing harness would mean editing a Consumer copy, and the harness is a variable precisely so it changes without one.

## Consequences

- `harnesses.json` is a published contract. Its shape can only grow, because an older CLI reads a newer tag's file and a newer CLI reads an older one.
- The job that receives every model secret is the trusted Launcher job; the agent still holds a placeholder ([ADR 0024](0024-every-stage-runs-through-agent-kits-launcher.md)), so passing unused secrets widens nothing the agent sees.
- `init` holds no text specific to one harness: its Secrets step and its refusals come from the file.
