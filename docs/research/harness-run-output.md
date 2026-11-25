# What a harness run hands back for a Run Record

Research for [#484](https://github.com/mnaimfaizy/agent-kit/issues/484) (map [#480](https://github.com/mnaimfaizy/agent-kit/issues/480)). It asks what each harness's machine-readable output carries that a **Run Record** (counts, ids, times, outcomes, never prose) could be built from: model, turns, duration, tokens in and out, cost in USD, tool calls by tool, permission denials and hook blocks, and outcome with failure reason. Then whether tokens and cost should come from the model proxy of [#454](https://github.com/mnaimfaizy/agent-kit/issues/454) (ADR [0023](../adr/0023-a-deep-scan-runs-only-on-a-harness-a-model-proxy-can-front.md)) for every harness alike.

- **Read on:** 2026-11-25. Versions read: Claude Agent SDK **0.3.331** (bundles Claude Code **2.1.331**, `claudeCodeVersion` in its `package.json`); `anthropics/claude-code-action` at `main` **e5c0fcd4** (2026-11-24); Codex CLI **rust-v0.172.0** (2026-11-24); Gemini CLI **v0.71.1** (2026-11-24); opencode **v2.4.1** (2026-11-23); Cursor CLI from its docs page, which names no version.
- **Sources:** primary only: each vendor's docs and, where the docs are silent, its source at the tag above (marked **from source**). No harness was run on this machine.
- **UNCONFIRMED** marks what no primary source states. All are listed at the end.

## 1. Claude Code

### Where the output is

- **Headless:** `claude -p --output-format json` prints one result object; `stream-json` prints newline-delimited messages, and the docs say to find each `result` message "by `type`, because a message such as a task notification can follow a result" ([headless](https://code.claude.com/docs/en/headless)). `--verbose` is needed for `stream-json` ([CLI reference](https://code.claude.com/docs/en/cli-reference)).
- **`claude-code-action`:** the `execution_file` output is "Path to the Claude Code execution output file" ([action.yml](https://github.com/anthropics/claude-code-action/blob/e5c0fcd41850/action.yml)). **From source**, it is every `SDKMessage` of the run, in order, written as one pretty-printed JSON **array** (`JSON.stringify(messages, null, 2)`) to `$RUNNER_TEMP/claude-execution-output.json`, also on a thrown error ([execution-file.ts](https://github.com/anthropics/claude-code-action/blob/e5c0fcd41850/base-action/src/execution-file.ts), [run-claude-sdk.ts](https://github.com/anthropics/claude-code-action/blob/e5c0fcd41850/base-action/src/run-claude-sdk.ts)). So it holds the same messages as `stream-json`, the result message included. That is what `security-audit-reusable.yml` reads today with `jq -rs 'flatten | map(select(.type == "result")) | last'`. The action's other outputs are `conclusion` (`success`/`failure`), `branch_name`, `github_token`, `session_id`, `structured_output` ([action.yml](https://github.com/anthropics/claude-code-action/blob/e5c0fcd41850/action.yml)).
- The array also carries assistant text, thinking, tool inputs and tool results, so the file is prose and stays private (as the audit workflow already treats it). A Run Record takes only the fields below.

### The fields (all from the SDK types, [`sdk.d.ts` in 0.3.331](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), documented at [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript))

**`result` message** (`SDKResultSuccess` / `SDKResultError`):

| Field | Meaning |
|---|---|
| `subtype` | `success`, or `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries` |
| `is_error`, `api_error_status`, `stop_reason`, `terminal_reason` | outcome. `terminal_reason` is one of `completed`, `max_turns`, `budget_exhausted`, `hook_stopped`, `stop_hook_prevented`, `api_error`, `model_error`, `prompt_too_long`, `aborted_streaming`, `aborted_tools`, `blocking_limit`, … (19 values) |
| `errors: string[]` (error results) | failure messages: **prose**, keep out of the record |
| `startup_failure_reason` (error results) | closed enum such as `config_file_invalid`, `proxy_invalid`, `sandbox_required_unavailable` |
| `num_turns` | turns |
| `duration_ms`, `duration_api_ms` | wall time and time in API calls |
| `total_cost_usd` | cumulative estimated cost |
| `usage` | Messages-API usage object, but "MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls" |
| `modelUsage: Record<model, ModelUsage>` | per model: `inputTokens`, `outputTokens`, `thinkingTokens?`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `cacheCreationEphemeral5mInputTokens?`, `cacheCreationEphemeral1hInputTokens?`, `webSearchRequests`, `costUSD`, `contextWindow`, `maxOutputTokens`, `canonicalModel?`, `provider?`, `costBasis?` (`list`/`managed`/`unknown`). The type calls it "The correct field for token/cost accounting" (subagents and compaction included) |
| `permission_denials: SDKPermissionDenial[]` | each `{ tool_name, tool_use_id, tool_input }` |
| `result` (success) | final text: **prose** |
| `session_id`, `uuid` | ids |

**Cost is an estimate.** "The `total_cost_usd` and `costUSD` fields are client-side estimates, not authoritative billing data", computed "from a price table bundled at build time" unless a `modelPricing` table applies ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)). `costBasis: 'unknown'` means "no pricing row and no built-in price matched the model ID, so costUSD is a guess" (`sdk.d.ts`).

**Other messages:**

- `system`/`init`: `model`, `tools`, `mcp_servers[{name,status}]`, `permissionMode`, `apiKeySource`, `claude_code_version`, `cwd`, `skills`, `plugins`, `session_id` (`SDKSystemMessage`; [headless](https://code.claude.com/docs/en/headless#read-session-metadata)).
- `assistant`: `message` is a Messages-API `Message` (`id`, `model`, `content` blocks including `tool_use` with `name`, `usage`), plus `parent_tool_use_id` (non-null inside a subagent) (`SDKAssistantMessage`). **Tool calls by tool** are counted from these `tool_use` blocks' `name`; there is no per-tool count field. Per-step usage repeats across assistant messages that share one `message.id` and must be counted once ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)).
- `system`/`permission_denied` (stream only): `tool_name`, `tool_use_id`, `agent_id?`, `decision_reason_type?` (e.g. `classifier`, `mode`, `rule`), `decision_reason?` and `message` (prose) (`SDKPermissionDeniedMessage`). "With `--output-format stream-json`, denials appear as `permission_denied` system messages, and the final result message lists them in `permission_denials`" ([headless](https://code.claude.com/docs/en/headless#turn-off-permission-prompts-in-unattended-runs)).
- `system`/`hook_started`, `hook_progress`, `hook_response`: `hook_response` has `hook_name`, `hook_event`, `exit_code?`, `outcome` (`success`/`error`/`cancelled`), and `output`/`stdout`/`stderr` (prose) (`SDKHookResponseMessage`). Only `SessionStart` and `Setup` hook events are emitted by default; others need `--include-hook-events` (CLI) or `includeHookEvents` (SDK) ([CLI reference](https://code.claude.com/docs/en/cli-reference)). **From source**, `claude-code-action` does not set `includeHookEvents` ([parse-sdk-options.ts](https://github.com/anthropics/claude-code-action/blob/e5c0fcd41850/base-action/src/parse-sdk-options.ts)), so a Stage's execution file has no `PreToolUse` hook events unless `claude_args` passes the flag.
- `system`/`api_retry`: `attempt`, `max_retries`, `error_status`, `error` (closed category such as `rate_limit`, `overloaded`) ([headless](https://code.claude.com/docs/en/headless#handle-api-retries)).

**Hook blocks:** whether a `PreToolUse` hook's deny lands in `permission_denials` is not stated in the [hooks](https://code.claude.com/docs/en/hooks) page or the types: **UNCONFIRMED**. A hook that stops the run shows as `terminal_reason: hook_stopped` / `stop_hook_prevented`.

### Redacted sample shape

```jsonc
// system/init (first line of stream-json; element 0 of execution_file)
{"type":"system","subtype":"init","session_id":"<uuid>","model":"claude-<model>","permissionMode":"dontAsk",
 "tools":["Read","Grep","Glob","Edit"],"mcp_servers":[{"name":"github","status":"connected"}],
 "apiKeySource":"ANTHROPIC_API_KEY","claude_code_version":"2.1.331","cwd":"<path>", "...":"..."}
// assistant (one per content block when streamed)
{"type":"assistant","parent_tool_use_id":null,"session_id":"<uuid>","uuid":"<uuid>",
 "message":{"id":"msg_<id>","model":"claude-<model>","content":[{"type":"tool_use","id":"toolu_<id>","name":"Read","input":"<redacted>"}],
            "usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
// system/permission_denied (stream-json only)
{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_<id>",
 "decision_reason_type":"rule","message":"<redacted>","session_id":"<uuid>","uuid":"<uuid>"}
// result (last result line; last result element of execution_file)
{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","terminal_reason":"completed",
 "num_turns":0,"duration_ms":0,"duration_api_ms":0,"total_cost_usd":0.0,
 "usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},
 "modelUsage":{"claude-<model>":{"inputTokens":0,"outputTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,
                                  "webSearchRequests":0,"costUSD":0.0,"contextWindow":0,"maxOutputTokens":0,"costBasis":"list"}},
 "permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_<id>","tool_input":"<redacted>"}],
 "result":"<redacted prose>","session_id":"<uuid>","uuid":"<uuid>"}
```

## 2. Codex CLI (`codex exec --json`)

`--json` prints "newline-delimited JSON events instead of formatted text" ([CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)). "Event types include `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error`", with a sample ([Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)). Exact shapes **from source** ([exec_events.rs](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/exec/src/exec_events.rs)):

- `thread.started { thread_id }`; `turn.started {}`; `turn.completed { usage }`; `turn.failed { error: { message } }`; `error { message }` ("unrecoverable"); `item.started|updated|completed { item: { id, type, … } }`.
- `usage`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, per turn.
- Item `type`: `agent_message`, `reasoning`, `command_execution` (`command`, `aggregated_output`, `exit_code`, `status` = `in_progress|completed|failed|declined`), `file_change` (`changes[{path,kind}]`, `status`), `mcp_tool_call` (`server`, `tool`, `arguments`, `result`, `error`, `status`), `collab_tool_call` (`tool` = `spawn_agent|send_input|wait|close_agent`), `web_search`, `todo_list`, `error`.

Missing: **model** (no event names it), **cost**, **duration**, a **turn count** in the agentic sense (a "turn" here is one prompt, so `codex exec` has one), and **permission denials** other than a `command_execution` with `status: "declined"`. The failure reason is a free-text `message`: prose.

## 3. Gemini CLI (`gemini -p … --output-format json|stream-json`)

The docs give the outline ([headless](https://github.com/google-gemini/gemini-cli/blob/v0.71.1/docs/cli/headless.md)): `json` returns `response`, `stats`, `error?`; `stream-json` emits `init` ("session ID, model"), `message`, `tool_use`, `tool_result`, `error`, `result` ("aggregated statistics and per-model token usage"). Exit codes: `0` success, `1` general or API error, `42` input error, `53` "Turn limit exceeded". Exact shapes **from source** ([output/types.ts](https://github.com/google-gemini/gemini-cli/blob/v0.71.1/packages/core/src/output/types.ts), [uiTelemetry.ts](https://github.com/google-gemini/gemini-cli/blob/v0.71.1/packages/core/src/telemetry/uiTelemetry.ts)):

- **`json`:** `{ session_id?, response?, stats?: SessionMetrics, error?: { type, message, code? }, warnings? }`. `SessionMetrics`:
  - `models[<model>].api { totalRequests, totalErrors, totalLatencyMs, errorsByType? }`
  - `models[<model>].tokens { input, prompt, candidates, total, cached, thoughts, tool }`
  - `tools { totalCalls, totalSuccess, totalFail, totalDurationMs, totalDecisions { accept, reject, modify, auto_accept }, byName[<tool>] { count, success, fail, durationMs, decisions{…} } }`
  - `files { totalLinesAdded, totalLinesRemoved }`
- **`stream-json`:** every event has `type`, `timestamp`. `init { session_id, model }`; `tool_use { tool_name, tool_id, parameters }`; `tool_result { tool_id, status: success|error, output?, error? }`; `error { severity, message }`; `result { status: success|error, error?, stats? { total_tokens, input_tokens, output_tokens, cached, input, duration_ms, tool_calls, models[<model>] {…tokens} } }`.

Missing: **cost**, a **turn count** (only exit code `53` says the cap was hit), and **overall duration** in `json` mode (it has API latency per model and tool time; `stream-json`'s `result.stats.duration_ms` has it). Denials are counts (`totalDecisions.reject`, per tool in `byName`), with no hook-block field. `stream-json`'s per-tool counts must be tallied from `tool_use` events.

## 4. opencode 2.x (`opencode run --format json`)

The docs say only "Emit newline-delimited JSON for scripts" ([CLI commands](https://opencode.ai/docs/cli/commands)). **From source** ([noninteractive.ts](https://github.com/anomalyco/opencode/blob/v2.4.1/packages/cli/src/run/noninteractive.ts)), each line is `{ type, timestamp, sessionID, … }` with `type`:

- `step_start { part: { id, messageID, snapshot } }` and `step_finish { part: { reason, snapshot, cost, tokens } }`, one pair per model step. `tokens` is `TokenUsage.Info { input, output, reasoning, cache { read, write } }` ([token-usage.ts](https://github.com/anomalyco/opencode/blob/v2.4.1/packages/schema/src/token-usage.ts)); `cost` is `Money.USD`; `reason` is the step's `finish` reason ([session-event.ts](https://github.com/anomalyco/opencode/blob/v2.4.1/packages/schema/src/session-event.ts), `session.step.ended`).
- `tool_use { part: { tool, id, state: { status: completed|error, input, output|error, time {start,end} } } }`.
- `text`, `reasoning` (only with thinking on): prose.
- `error { error: { type, message } }`, with `type` such as `aborted` or `unknown`; `retry`; `background_wait`.

Missing: **model** (the step's model is printed only in text mode, `> agent · model`), **turn count** (count `step_finish` lines, which are model steps), **overall duration** (from `timestamp`s), and **permission denials**: in a non-`--auto` run a permission request is auto-rejected and announced with `UI.println` text, not a JSON event. How opencode prices `cost` for a provider behind the proxy is not checked: **UNCONFIRMED**.

## 5. Cursor CLI (`-p --output-format json|stream-json`)

From [output format](https://cursor.com/docs/cli/reference/output-format): `json` is one `result` object `{ type, subtype: "success", is_error, duration_ms, duration_api_ms, result, session_id, request_id? }`, and `duration_api_ms` is "currently equal to `duration_ms`"; on failure no JSON object is printed. `stream-json` adds `system`/`init { apiKeySource, cwd, session_id, model, permissionMode }`, `user`, `assistant`, and `tool_call` `started`/`completed` keyed by tool kind (`readToolCall`, `writeToolCall`, or `function { name, arguments }`).

Missing: **tokens**, **cost**, **turns**, **permission denials**, **hook blocks**, and any failure reason in JSON. `model` is a display name.

## 6. What the model proxy sees

A proxy that forwards the provider API reads the response usage itself. No provider returns money.

- **`anthropic` profile** (Messages API): `usage { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, server_tool_use { web_search_requests } }` and `model`. When streamed, `message_start` carries the initial usage and "the token counts shown in the `usage` field of the `message_delta` event are *cumulative*" ([streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)).
- **`openai` profile** (Responses API, which Codex uses: `wire_api = "responses"`, [Codex docs](https://developers.openai.com/codex/llms-full.txt)): `usage { input_tokens, input_tokens_details { cached_tokens, cache_write_tokens }, output_tokens, output_tokens_details { reasoning_tokens }, total_tokens }`; the stream ends with `response.completed { response }` carrying it ([openai-python `ResponseUsage`](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_usage.py), [`ResponseCompletedEvent`](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_completed_event.py)).
- **`gemini-api` profile:** `usageMetadata { promptTokenCount, cachedContentTokenCount, candidatesTokenCount, toolUsePromptTokenCount, thoughtsTokenCount, totalTokenCount, … }`, `modelVersion`, `responseId`, and no cost field ([generateContent reference](https://aistudio.google.com/api-reference/generate-content)). Which streamed chunk carries `usageMetadata` was not in the part of the page read: **UNCONFIRMED**.
- The proxy also knows the **model id** (ADR 0023: a profile names "where the model id and the declared limit sit"), the **number of model requests**, and each request's time.

## 7. The table

Field → source. ✗ means the harness's machine-readable output does not carry it. "Launcher" means the Launcher already knows it from the launch plan or the process.

| Field | Claude Code (`stream-json` / `execution_file`) | Codex CLI `exec --json` | Gemini CLI `json` / `stream-json` | opencode 2.x `run --format json` | Cursor CLI | Model proxy |
|---|---|---|---|---|---|---|
| Model | `system/init.model`; `modelUsage` keys | ✗ (Launcher) | `init.model`; `stats.models` keys | ✗ (Launcher) | `init.model` (display name) | request/response model id |
| Turns | `result.num_turns` | ✗ (one `turn` per prompt) | ✗ (exit `53` on cap only) | ✗ (count `step_finish`) | ✗ | model request count (not turns) |
| Duration | `result.duration_ms`, `duration_api_ms` | ✗ (Launcher wall clock) | `result.stats.duration_ms` (stream); per-model `totalLatencyMs` | ✗ (from `timestamp`s) | `duration_ms` | per-request time |
| Tokens in/out | `result.modelUsage[m].inputTokens/outputTokens` + cache fields | `turn.completed.usage.*` | `stats.models[m].tokens.*` / `result.stats.*_tokens` | `step_finish.part.tokens.*` (sum) | ✗ | **yes, every profile** |
| Cost USD | `result.total_cost_usd`, `modelUsage[m].costUSD` (estimate) | ✗ | ✗ | `step_finish.part.cost` (sum; pricing source unchecked) | ✗ | ✗ (no API returns cost) |
| Tool calls by tool | count `assistant` `tool_use` blocks by `name` | count `item.completed` by `item.type` (+ `mcp_tool_call.tool`) | `stats.tools.byName[t].count` (json); count `tool_use` (stream) | count `tool_use` by `part.tool` | count `tool_call/started` by kind | ✗ (only by reading response bodies) |
| Permission denials | `result.permission_denials[]`; `system/permission_denied` | `command_execution.status = "declined"` | `stats.tools.totalDecisions.reject` | ✗ (stderr text only) | ✗ | ✗ |
| Hook blocks | `hook_response` only with `--include-hook-events`; `terminal_reason: hook_stopped`; PreToolUse deny in `permission_denials`: UNCONFIRMED | ✗ | ✗ | ✗ | ✗ | ✗ |
| Outcome | `result.subtype`, `is_error`, `terminal_reason`, exit code | `turn.completed` vs `turn.failed`/`error`, exit code | `result.status`, `error.type`, exit codes 0/1/42/53 | `error.type`, exit code | `is_error`; no JSON on failure | ✗ (only upstream status codes) |
| Failure reason (closed) | `subtype`, `terminal_reason`, `startup_failure_reason`, `api_retry.error` | ✗ (prose `message` only) | `error.type`, exit code | `error.type` (`aborted`, `unknown`) | ✗ | upstream HTTP status, cap hit |
| Session id | `session_id` | `thread_id` | `session_id` | `sessionID` | `session_id` | per-run caller secret |

## 8. Conclusion: tokens from the proxy, cost from no one

- **Tokens: yes, from the proxy, for every harness the proxy fronts.** It is the only source that is the same on Claude Code, Codex, Gemini CLI, opencode and a Custom harness, it already reduces usage for the cap ("a usage reducer that counts each token once", ADR 0023), and it counts what a harness's own totals may leave out or double (Claude's `usage` is main-loop only; per-step usage repeats across messages sharing one id). Record input, output, cache-read, cache-write and reasoning tokens per model, as the reducer counts them. A harness's own figure is at most a cross-check.
- **Cursor CLI** has no proxy (ADR 0023 refuses it for that reason) and reports no tokens, so its Run Record has tokens and cost **absent**, not zero.
- **Cost: from neither, as a measured value.** No provider API returns money, and the proxy has no price table, which ADR 0023 rejected because it "would go stale with every release". Only Claude Code and opencode compute one, from their own price tables, and Claude Code calls it an estimate that can be a "guess" when the model id is unpriced (`costBasis: 'unknown'`), as a model id routed through a proxy can be. So the Run Record should store tokens and leave cost out, or store a harness's estimate labelled as such with its source (`costBasis`). A report can price tokens later, at read time.
- **Turns, tool calls, denials, outcome stay with the harness** (or the Launcher), and differ per harness: Claude Code carries nearly all of them; Gemini CLI carries counts; Codex and opencode need counting over events; Cursor carries almost none. The proxy's request count is a uniform "model calls" figure, not turns.
- **Tension with #454.** The spec says the transcript "is stored raw in the private sink (ADR 0021) and never parsed". Every per-harness field above lives in that same stream. Reading them would need a per-adapter count-only reducer that keeps names, counts and closed enums, and drops `result`, `message`, `errors`, tool inputs and outputs. Or the Run Record takes only what the Launcher and proxy know (model, wall clock, tokens, exit code, result-file validity) and leaves the rest out. That choice is for the spec, not this research.

## UNCONFIRMED

1. Whether a Claude Code `PreToolUse` hook deny is listed in `permission_denials` / `permission_denied`.
2. How opencode prices `step_finish.cost` for a model behind the proxy.
3. Which streamed Gemini API chunk carries `usageMetadata`.
