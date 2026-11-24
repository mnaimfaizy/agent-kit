---
status: proposed
---

# A Harness adapter returns a launch plan as data, and a Custom harness is data only

The Launcher ([ADR 0024](0024-every-stage-runs-through-agent-kits-launcher.md)) knows nothing about any one harness. Each harness has a **Harness adapter**, used by both `agent-kit stage <stage>` and `agent-kit deep-scan`. An adapter is one function: given a Stage request (the Stage, model, effort, credential kind, proxy address and brief path) it returns a launch plan, which is plain data. The Launcher does everything with that plan; the adapter starts nothing itself.

An adapter supplies nine things:

1. **Identity.** Its name, one pinned CLI version and the major it supports.
2. **Install layer.** What puts the CLI on the sandbox image.
3. **Model route.** A provider profile from [ADR 0023](0023-a-deep-scan-runs-only-on-a-harness-a-model-proxy-can-front.md) (`anthropic`, `openai`, `gemini-api`), or none plus the vendor's hosts for [ADR 0025](0025-a-stages-guards-are-reached-by-the-launchers-sandbox.md)'s weaker form.
4. **Credentials.** Which kit secrets it accepts, and the environment name and placeholder each becomes in the sandbox.
5. **Launch.** The argv, what goes on stdin, the config files the Launcher writes, and the environment.
6. **Checkout config.** The executable harness-config paths the Launcher removes from the copy.
7. **Instruction files.** The files the harness loads by itself (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`), so the Launcher places the trusted commit's versions.
8. **Stops.** Whether the harness reports a hit turn cap, and how (an exit code or a stderr marker).
9. **Transcript.** Where its raw event stream lands.

It supplies no output parser, no completion logic and nothing about GitHub. The stream is never parsed ([ADR 0026](0026-every-github-write-is-a-trusted-step-working-from-the-stage-result.md)), and completion is the exit plus a valid Stage result.

The adapters the kit ships are code, because a harness's launch can branch (Claude Code takes `--bare` with an API key and `--strict-mcp-config` with a subscription token). A **Custom harness** is never code. It is a Consumer-owned file, `.agent-kit/harnesses/<name>.json`, in the same launch-plan shape with fixed slots (`{model}`, `{effort}`, `{brief}`, `{proxy_url}`). It is read only from the trusted commit and selected with `AGENT_KIT_<STAGE>_HARNESS=custom:<name>`. This extends the fixed harness list of [ADR 0022](0022-stage-settings-are-named-for-the-kit-not-the-harness.md) by that one prefix. A Custom harness:

- must name one of the three provider profiles; it cannot take the weaker form, so a Consumer's file never names hosts the sandbox may reach;
- installs as an npm package and an exact version, which the Launcher turns into the install line; the file holds no commands;
- runs at the `documented` Support Level, and is refused for security audit and Deep scan until a run is recorded.

Rules every adapter follows:

- **Permissions are open inside the sandbox.** The adapter runs its harness with approvals off and every local tool allowed, and switches off only the harness's own web and server-side tools. The sandbox reaches the Guards, and every Stage needs a write tool or a shell to write its Stage result. The per-Stage tool lists retire on the Launcher path. `extra_allowed_tools` stays an input, honoured while a Stage is on `claude-code-action` and ignored with a log line on the Launcher path.
- **The brief is a file.** Every Stage's brief is written into the sandbox, and what the adapter passes on stdin or argv is one short kit-written line telling the agent to read it. No adapter handles brief text, and no argv size cap applies.
- **Model and effort pass through verbatim.** The Consumer writes both in the harness's own words. The adapter supplies the default model and the effort values it accepts. Preflight fails a Stage whose own effort setting is not accepted, or whose harness has no effort setting; an effort inherited from `AGENT_KIT_EFFORT` is dropped with a log line.
- **The kit pins the CLI.** One exact version per harness per kit release, with the harness's updater off and no Consumer override.
- **No Guard table.** Four Guards are reached by the sandbox the same way on every harness. Preflight derives the other two from the model route (key and network) and the checkout-config list (config not loaded).

The `opencode` adapter pins an exact 2.x version (`@opencode/cli`) and always passes `--standalone`, because 2.x otherwise attaches to a shared per-user server that read its environment when it started. opencode 1.x (`opencode-ai`) is not supported; it is a different harness, and a Consumer who needs it describes it as a Custom harness.

Decided in [Harness adapter contract](https://github.com/mnaimfaizy/agent-kit/issues/447), on the map [Wayfinder: Stages run on a Consumer-chosen harness](https://github.com/mnaimfaizy/agent-kit/issues/438).

## Considered Options

- **Adapters as code throughout, Custom harnesses included**, as Sandcastle's `AgentProvider` is. Rejected. A Consumer's adapter code would run in the Launcher's process on the runner, beside the real model key.
- **Adapters as data throughout.** Rejected. The Claude Code adapter already branches on the credential kind, and a data format rich enough to say so would be a small language.
- **A stream parser in the contract** (Sandcastle's `parseStreamLine`). Rejected. Nothing reads the stream: the Stage result is a file and the transcript is stored raw.
- **Per-Stage tool lists kept as defence in depth.** Rejected. Each harness names tools differently, a read-only Stage still has to write its result file, and a list that is not a Guard would read as one.
- **A table that maps the kit's effort names to each harness's.** Rejected for the reason [ADR 0009](0009-stage-settings-resolve-in-the-caller.md) rejected an effort table: it goes stale with every model release.
- **A Consumer-set CLI version.** Rejected. The launch plan and the checkout-config list are written against one version, and a contract test proves that version.
- **The brief on stdin or argv.** Rejected. Cursor CLI and opencode take the prompt as an argument, which caps its size, and the Deep scan already hands the brief over as a file.
- **Free-form install lines in a Custom harness file.** Rejected. They are shell, and the file is meant to hold none.
- **The Custom harness as a workflow input.** Rejected. A launch plan is too large for one. The file does not break ADR 0009: it defines a harness, and the Stage still chooses its harness in the Caller.
- **opencode 1.x.** Rejected. The install documentation and the CI recipe target 2.x, 1.x now prompts its users to upgrade, and the `transport: "http"` setting ADR 0023 relies on is documented only for 2.x.

## Consequences

- opencode 2.x ships breaking minors every week or two, and several environment variables the adapter relies on (`OPENCODE_CONFIG`, `OPENCODE_DISABLE_AUTOUPDATE`) are read by its source but not documented. Each pin bump has to pass the contract tests.
- A harness that is not on npm cannot be a Custom harness; it needs an adapter in the kit.
- A Consumer who relied on `extra_allowed_tools` to narrow a Stage gets no narrowing on the Launcher path. The Guards are what a Stage is held to.
- The Deep scan's Claude Code coupling in `cli/src/deep-scan/{agent,claude-code,credential}.mjs` moves behind the Claude Code adapter: the install layer, the command, the settings file, the credential names and the turn-limit marker.
- `agent-kit doctor` has a new file to check, the Custom harness a Stage names.
