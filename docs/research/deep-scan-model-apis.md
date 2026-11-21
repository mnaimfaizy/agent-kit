# Model APIs behind the Deep scan proxy

Research for [#441](https://github.com/mnaimfaizy/agent-kit/issues/441) (map [#438](https://github.com/mnaimfaizy/agent-kit/issues/438)): for the model provider behind each target harness, what `cli/src/deep-scan/model-proxy.mjs` would have to know to front it as it fronts Anthropic today. That means the upstream host, how auth is sent, which paths to allow, the streaming format, and which usage fields to meter. It also covers whether each CLI sends all of its traffic to a configured base URL.

- **Read on:** 2026-11-22. Docs pages carry no publish date, so a fact from a docs page is dated by the read.
- **Versions read** (latest stable on the read date):
  - **Codex CLI** `rust-v0.171.0` (2026-11-20). Source read at that tag, plus the docs export [`llms-full.txt`](https://developers.openai.com/codex/llms-full.txt).
  - **Gemini CLI** `v0.70.0` (2026-11-19). Source and `docs/` read at that tag, plus `@google/genai` 1.30.0, the SDK version it pins, from `dist/node/index.mjs` on unpkg.
  - **opencode** `v2.3.2` (2026-11-18, `anomalyco/opencode`). Source and docs (`services/site/src/docs/content/`) read at that tag.
  - **Cursor CLI** v2026.11.17, from its [changelog](https://cursor.com/docs/cli/changelog.md). Cursor's CLI is closed source, so only its docs were read.
- **Sources:** primary only (provider API references, CLI docs, CLI source at the tags above). A fact taken from source alone is marked **from source**. **UNCONFIRMED** marks anything no primary source states.

## 0. What the proxy does for Anthropic today (the baseline)

From `cli/src/deep-scan/{model-proxy,credential,agent}.mjs` and the drivers:

| Concern | Today |
| --- | --- |
| Upstream | `https://api.anthropic.com` (`MODEL_API`) |
| Sandbox's view | plain HTTP: `http://<relay>:<port>` on Docker Engine, `http://host.docker.internal:<port>` on Docker Sandboxes (`docker-driver.mjs:277`, `sbx-driver.mjs:347`) |
| Auth | drops `x-api-key`, `authorization`, `cookie`, hop-by-hop headers and `host`. Inserts `x-api-key: <key>`, or `authorization: Bearer <token>` on the subscription path |
| Placeholder | `ANTHROPIC_API_KEY=agent-kit-deep-scan-placeholder`, or a `sk-ant-oat01-…` placeholder token |
| Allowlist | path must match `^/v1/` after strict decoding (no `..`, `//`, `%2f`, double encoding) |
| Refused | `/v1/messages/batches*` and `/v1/complete` (spend the answer's `usage` would not show); absolute-URI (forward-proxy) requests; `CONNECT` |
| Metering | JSON body or SSE `data:` lines. Reads `usage` (or `message.usage`) and sums `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`, taking each field's max per answer since stream usage is cumulative. Forces `accept-encoding: identity` and decodes gzip, deflate or br if it gets them anyway |
| Model check | `MODEL_ID` regex on `--model`. Records the `model` (or `message.model`) each answer names |
| Pinning | `ANTHROPIC_BASE_URL` in the launcher's `--settings`, `--setting-sources user`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1` |

Two things in this baseline matter for every other provider. First, the proxy is **plain HTTP**, so a CLI has to accept an `http://` base URL on a host that is not loopback. Second, the proxy **drops `Upgrade`/`Connection`**, so WebSocket transports cannot pass through it.

## 1. Summary

| Harness | Upstream | Auth the proxy writes | Paths to allow | Stream | Meter | All model traffic to a base URL? | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Codex CLI** (API key) | `https://api.openai.com/v1` | `Authorization: Bearer <key>` | `POST /v1/responses` only (optionally `GET /v1/models`) | SSE `response.*` events. WebSocket if enabled | `response.usage`: `input_tokens + output_tokens` (or `total_tokens`) | Yes, with a custom provider | **Works.** OpenAI ships a proxy of this exact shape |
| **Gemini CLI** (Gemini API key) | `https://generativelanguage.googleapis.com` | `x-goog-api-key: <key>` | `POST /v1beta/models/{m}:streamGenerateContent`, `:generateContent`, `:countTokens` (and `:embedContent` if used) | SSE (`?alt=sse`), one `GenerateContentResponse` per `data:` | `usageMetadata.totalTokenCount` | Yes (`GOOGLE_GEMINI_BASE_URL`) | **Works, with caveats** (http base URL, server-side web tools) |
| **Gemini CLI** (Vertex AI) | `https://aiplatform.googleapis.com` (or regional / REP) | `Authorization: Bearer <OAuth access token>` that the proxy mints from ADC | `POST /v1beta1/projects/{p}/locations/{l}/publishers/google/models/{m}:streamGenerateContent` and siblings | same | same | Yes (`GOOGLE_VERTEX_BASE_URL`) | **Works if the proxy mints and refreshes tokens host-side** |
| **Gemini CLI** (Login with Google) | `https://cloudcode-pa.googleapis.com/v1internal` | OAuth bearer, refreshed against Google OAuth | private `v1internal` API | — | — | Partly (`CODE_ASSIST_ENDPOINT`) | **Not a target**: private API, plus quota, experiments and admin calls |
| **opencode** | whichever provider is configured | that provider's own form | that provider's paths | that provider's | that provider's | Yes per provider (`settings.baseURL`), plus a catalog fetch to switch off | **Works by reusing the per-provider proxy**: Anthropic as today, OpenAI as Codex |
| **Cursor CLI** | Cursor's backend (`api2.cursor.sh`, `api5.cursor.sh`, …) | `CURSOR_API_KEY` (wire form **UNCONFIRMED**) | Cursor's Connect-RPC services | HTTP/2 bidi, with HTTP/1.1 SSE fallback | none the proxy can read | **No**: "all requests are routed through Cursor's servers" | **Cannot work behind a model-API proxy** |

## 2. OpenAI (Codex CLI)

**Base URL and provider.** There are two ways to point Codex elsewhere ([Advanced config](https://learn.chatgpt.com/docs/config-file/config-advanced)):

- `openai_base_url` changes the built-in `openai` provider's base URL.
- A custom `[model_providers.<id>]` takes `base_url`, `env_key`, `wire_api = "responses"`, `http_headers`, `query_params` and the retry and timeout knobs.

`wire_api` now has a single value. **From source** (`codex-rs/model-provider-info/src/lib.rs`): "The Responses API exposed by OpenAI at `/v1/responses`."

Use a custom provider, not `openai_base_url`. **From source**, `create_openai_provider` sets `requires_openai_auth: true` and `supports_websockets: true` for the built-in provider, so with `openai_base_url` Codex would first try the Responses WebSocket transport and offer ChatGPT login. A custom provider defaults to `supports_websockets: false` and takes its key from `env_key`.

The project layer cannot redirect Codex. Codex ignores `openai_base_url`, `chatgpt_base_url`, `model_provider`, `model_providers`, `otel` and `profile(s)` in a repo's `.codex/config.toml`, and prints a warning when it sees them ([Advanced config](https://learn.chatgpt.com/docs/config-file/config-advanced), "Project config files"). The launcher would set them with `-c` or in a user `config.toml` it writes.

**First-party precedent.** `codex-rs/responses-api-proxy` (README, at the tag) is "a strict HTTP proxy that forwards `POST /v1/responses` to the OpenAI API (`https://api.openai.com`)". It reads the key from stdin, rejects every other request with `403`, and is used as:

```
codex exec -c "model_providers.openai-proxy={ name = 'OpenAI Proxy', base_url = 'http://127.0.0.1:PORT/v1', wire_api='responses' }" -c model_provider="openai-proxy" '…'
```

This is the same design as the Deep scan proxy, and it shows Codex runs with `POST /v1/responses` as its only route.

**Auth.** `Authorization: Bearer $OPENAI_API_KEY` ([Responses API reference](https://developers.openai.com/api/reference/resources/responses), curl examples). `codex exec` reads `CODEX_API_KEY`, and a custom provider reads its `env_key`. The placeholder goes there. The proxy keeps dropping `authorization` and writes its own. The built-in provider also adds the `OpenAI-Organization` and `OpenAI-Project` headers from env (**from source**).

**Paths.** **From source** (`codex-rs/codex-api/src/endpoint/`), Codex can call these paths relative to the provider base URL:

- `responses` (POST, the turn; compaction also travels as `compaction_trigger` items here)
- `models` (catalog, best effort: a failed fetch keeps the bundled catalog, `models-manager/src/manager.rs`)
- `memories/trace_summarize`
- `alpha/search` (standalone web search, off for custom providers: `supports_standalone_web_search` defaults to `false`)
- `images/generations` and `images/edits`
- realtime

Allow `POST /v1/responses` and nothing else, as OpenAI's own proxy does. Refuse spend the answer won't show: `/v1/batches`, and `background: true` responses, which are billed when retrieved later. **UNCONFIRMED** whether Codex ever sends `background`; refusing it costs nothing.

**Streaming.** SSE. The final event is `response.completed` (or `response.incomplete`), carrying `response.usage`; a stream that closes without it is an error (**from source**, `codex-api/src/sse/responses.rs`). Responses carry `model` at top level, inside `response` on stream events. The WebSocket transport (`responses_websocket`) is only used when the provider sets `supports_websockets`, and Codex counts `transport.fallback_to_http` when it falls back ([metrics catalog](https://learn.chatgpt.com/docs/config-file/config-advanced#metrics)).

**Usage.** `ResponseUsage` holds `input_tokens`, `input_tokens_details.{cached_tokens, cache_write_tokens}`, `output_tokens`, `output_tokens_details.reasoning_tokens` and `total_tokens`. The `*_details` objects are "a detailed breakdown" of their parent ([reference](https://developers.openai.com/api/reference/resources/responses)), and Codex's own parser treats them the same way (**from source**). **So the meter must count `input_tokens + output_tokens` (or `total_tokens`), not the sum of every field the way `COUNTED_USAGE` does for Anthropic.** Summing cached and reasoning tokens on top would count them twice.

**Other egress** (none of it needed for a run, and all of it is refused once the network is cut):

- Statsig metrics to `https://ab.chatgpt.com/otlp/v1/metrics` (**from source**, `otel/src/config.rs`) and analytics events to `…/backend-api/codex/analytics-events/events`. "By default, Codex periodically sends a small amount of anonymous usage and health data". Switch off with `[analytics] enabled = false` ([metrics](https://learn.chatgpt.com/docs/config-file/config-advanced#metrics)).
- OTel export is off by default.
- The update check (`check_for_update_on_startup`) lives in the TUI only (**from source**, `tui/src/updates.rs`), not in `codex exec`.
- ChatGPT-login token refresh goes to `https://auth.openai.com/oauth/token` (**from source**, `login/src/auth/manager.rs`). That only applies on ChatGPT auth, whose inference base is `https://chatgpt.com/backend-api/codex`.
- Hosted `web_search` runs on OpenAI's side, inside `/v1/responses`. The default is `"cached"`; set `web_search = "disabled"` ([Security](https://learn.chatgpt.com/docs/agent-approvals-security)).

**A ChatGPT-subscription path** (the Codex counterpart of `--credential subscription`) is **not** a drop-in. Inference goes to `chatgpt.com/backend-api/codex/responses` with a short-lived access token, and the refresh uses `auth.openai.com`. The proxy would have to hold the refresh token and refresh host-side. **UNCONFIRMED** whether that is supported for third-party use; leave it out of v1.

## 3. Google (Gemini CLI: Gemini API and Vertex AI)

**Auth types** (**from source**, `packages/core/src/core/contentGenerator.ts`) are `gemini-api-key`, `vertex-ai`, `oauth-personal` (Login with Google / Code Assist), `compute-default-credentials`, `cloud-shell` and a new `gateway`. Detection order: `GOOGLE_GENAI_USE_GCA`, then `GOOGLE_GENAI_USE_VERTEXAI`, then `GOOGLE_GEMINI_BASE_URL` (selects `gateway`), then `GEMINI_API_KEY`. The `gateway` type takes its key from `GEMINI_API_KEY` (or sends an empty `x-goog-api-key`) and talks the Gemini API wire format to the base URL.

**Base URL.** `GOOGLE_GEMINI_BASE_URL` (Gemini API and gateway) and `GOOGLE_VERTEX_BASE_URL` (Vertex) ([configuration reference](https://github.com/google-gemini/gemini-cli/blob/v0.70.0/docs/reference/configuration.md)). Defaults in `@google/genai` 1.30.0:

- Gemini API: `https://generativelanguage.googleapis.com/`, API version `v1beta`.
- Vertex: `https://aiplatform.googleapis.com/` or `https://{location}-aiplatform.googleapis.com/`, API version `v1beta1`. Gemini CLI swaps in `aiplatform.us.rep.googleapis.com` or `aiplatform.eu.rep.googleapis.com` for `GOOGLE_CLOUD_LOCATION=us` or `eu`.

**HTTP caveat.** The docs say the base URL "must use HTTPS unless pointing to `localhost` (or `127.0.0.1` / `[::1]`)". The v0.70.0 source does not enforce that: `validateBaseUrl` only checks that `new URL()` parses, and nothing in the SDK checks the scheme. The Deep scan's `http://<relay-ip>:<port>` or `http://host.docker.internal:<port>` works today, but it breaks the documented contract and could break in any release. Possible answers for a later ticket: an in-sandbox loopback listener (e.g. a `socat` forwarder baked into the image), or TLS on the proxy.

**Auth.** The SDK sends `x-goog-api-key` (**from source**, `GOOGLE_API_KEY_HEADER`). Vertex uses `google-auth-library` and sends `Authorization: Bearer <access token>` minted from ADC, refreshing against Google's OAuth token endpoint. For Vertex behind the proxy, the launcher holds ADC or a service-account key, mints short-lived tokens host-side and writes the bearer. **UNCONFIRMED** whether Gemini CLI accepts Vertex in the sandbox with no ADC at all. It needs `GOOGLE_API_KEY`, or `GOOGLE_CLOUD_PROJECT` plus `GOOGLE_CLOUD_LOCATION`, to pass its check, and a placeholder `GOOGLE_API_KEY` puts the SDK in express mode, which sends `x-goog-api-key` instead of a bearer. The proxy would then have to swap header kinds. Gemini CLI also adds `x-gemini-api-privileged-user-id` (an installation id) when usage statistics are on. The proxy must add `x-goog-api-key` to `DROPPED`, and refuse or strip a `key=` query parameter.

**Paths** (**from source**, SDK): `{model}:generateContent`, `{model}:streamGenerateContent?alt=sse`, `{model}:countTokens` (used by `tokenCalculation.ts` and `baseLlmClient.ts`) and `{model}:embedContent`. For the Gemini API these sit under `/v1beta/models/`. For Vertex they sit under `/v1beta1/projects/{p}/locations/{l}/publishers/google/models/`. An allowlist is `^/v1beta/models/[^/:]+:(streamGenerateContent|generateContent|countTokens)$`, plus the Vertex form. Refuse spend the answer won't show: `:batchGenerateContent`, `/v1beta/batches`, `cachedContents` (storage billed by time) and `/upload/…/files`.

**Streaming.** SSE: each `data:` line is a full `GenerateContentResponse` ([API reference](https://aistudio.google.com/api-reference/generate-content)). The model shows up as `modelVersion` ("The model version used to generate the response"), not `model`, so the "answered with" check must read `modelVersion`.

**Usage.** `usageMetadata` holds `promptTokenCount` (which "includes the number of tokens in the cached content"), `cachedContentTokenCount`, `candidatesTokenCount`, `toolUsePromptTokenCount`, `thoughtsTokenCount` and `totalTokenCount`, documented as "prompt + tool-use prompt + thoughts + response candidates" ([API reference](https://aistudio.google.com/api-reference/generate-content)). **Meter `totalTokenCount`**: adding `cachedContentTokenCount` would count cached tokens twice. The max-per-field rule still works across stream chunks. **UNCONFIRMED** whether every chunk carries cumulative counts or only the last one does; max-per-field is correct in both cases.

**Server-side web tools.** Gemini CLI's `google_web_search` sends `tools: [{googleSearch: {}}]` and its `web_fetch` sends `tools: [{urlContext: {}}]` to the model (**from source**, `config/defaultModelConfigs.ts`). Both run on Google's side, inside an allowed `generateContent` call. Exclude them with `tools.exclude` in the launcher's settings.

**Other egress:**

- Clearcut usage logging to `https://play.googleapis.com/log` (**from source**). `privacy.usageStatisticsEnabled` defaults to `true`; set it to `false`.
- Auto-update and update notifications: `general.enableAutoUpdate` and `general.enableAutoUpdateNotification` default to `true`; set both to `false`.
- OTel telemetry is off by default.
- Experiments, quota and admin-control fetches go only through the Code Assist server (**from source**, `config/config.ts`), so they don't run on API-key or Vertex auth.

**Login with Google** uses the private `cloudcode-pa.googleapis.com/v1internal` API, where `CODE_ASSIST_ENDPOINT` overrides the host, with OAuth refresh. It is out of scope.

## 4. opencode

opencode is not a provider. It routes to the provider the Consumer configures, so the proxy needs no new provider: opencode reuses whichever proxy mode matches.

**Base URL.** Set `providers.<id>.settings.baseURL` "to send a catalog provider through a proxy or compatible endpoint. Its existing package, models, and connection still apply" ([Providers](https://github.com/anomalyco/opencode/blob/v2.3.2/services/site/src/docs/content/providers.mdx), "Endpoint"). The docs' own example uses `"baseURL": "https://llm-proxy.example.com/anthropic"`. Credentials come from the env names in `providers.<id>.env`, so the placeholder goes there. Headers and paths are whatever the provider's runtime package sends: Anthropic's is `x-api-key` and `/v1/messages`, matching today's proxy; OpenAI's is `Authorization: Bearer` and `/v1/responses`, matching §2.

**WebSocket.** "OpenAI, xAI, and supported Azure Responses models can keep one WebSocket connection open per session". Set `settings.transport: "http"` to stay on HTTP. If a socket can't open, "the session continues over HTTP" ([Providers](https://github.com/anomalyco/opencode/blob/v2.3.2/services/site/src/docs/content/providers.mdx), "WebSockets").

**Request encoding.** OpenAI requests are zstd-compressed only on ChatGPT sign-in with no custom `baseURL`; API keys send plain JSON. Pin `settings.encoding: "none"` all the same. The proxy forwards the body as it is, and the upstream would reject a compressed body it doesn't expect.

**Other egress and isolation** (**from source**, `packages/cli/src/server-process.ts`, `services/updater.ts`):

| What | Where | Off with |
| --- | --- | --- |
| Model catalog fetch | `https://models.opencode.ai` | `OPENCODE_DISABLE_MODELS_FETCH=1` (or `OPENCODE_MODELS_PATH` to a bundled file) |
| Update check | — | `"update": "disable"` in global config, or `OPENCODE_DISABLE_AUTOUPDATE=1` |
| Free hosted models (`opencode` provider) | `opencode.ai` | `OPENCODE_DISABLE_FREE_MODELS=1` |
| Plugin installs | npm and git | don't configure plugins |
| Web search | Exa, Firecrawl, Parallel, Tavily or TinyFish ([Web search](https://github.com/anomalyco/opencode/blob/v2.3.2/services/site/src/docs/content/websearch.mdx)) | leave every search key unset |
| Repo config overriding the provider or base URL | `opencode.json` in the scanned repo | `OPENCODE_DISABLE_PROJECT_CONFIG=1`, with the config passed by `OPENCODE_CONFIG` or `OPENCODE_CONFIG_CONTENT` |

No telemetry endpoint turned up in `packages/{core,cli,server}/src` at v2.3.2 (a grep for posthog, telemetry, share hosts). **UNCONFIRMED** that none exists elsewhere. opencode 2 also starts a local background server on loopback; that stays inside the sandbox.

## 5. Cursor CLI

**Cursor does not call providers from the client.** "Your API key is not stored on our servers. It is sent to our backend with every request because all requests are routed through Cursor's servers for final prompt building" ([Bring your own API key](https://cursor.com/help/models-and-usage/api-keys.md)). The CLI authenticates to Cursor with `agent login` or `CURSOR_API_KEY` ([CLI authentication](https://cursor.com/docs/cli/reference/authentication.md)). The CLI docs have no setting for a model base URL. The only mention of an "OpenAI-compatible base URL override" is a data-residency note about custom models, which is server-side ([Privacy and data governance](https://cursor.com/docs/enterprise/privacy-and-data-governance.md)).

**Hosts** ([Network configuration](https://cursor.com/docs/enterprise/network-configuration.md)): `api2.cursor.sh` ("most API requests"), `api5.cursor.sh` and its `agent.*` subdomains ("Cursor's agent requests"), the auth hosts `authenticate.cursor.sh`, `authentication.cursor.sh` and `prod.authentication.cursor.sh` (plus `accounts.x.ai` for new sign-in), and update hosts `downloads.cursor.com` and `cursor-cdn.com`. Agent streams are HTTP/2 bidirectional with an HTTP/1.1 SSE fallback, and the CLI has `network.useHttp1ForAgent` ([CLI configuration](https://cursor.com/docs/cli/reference/configuration.md)).

**Why the model proxy can't front it:**

- The upstream is Cursor's private Connect-RPC API, not a model API.
- `HTTPS_PROXY` is honoured end to end (v2026.06.09: "`HTTPS_PROXY` is honored on the streaming connection"). That is a `CONNECT` tunnel, which the model proxy refuses on purpose. Allowing it means the real `CURSOR_API_KEY` sits in the sandbox, since TLS runs end to end, and the proxy can read no usage.
- Usage exists only as the CLI's own report (`usage` with `reasoningTokens` in the headless result, v2026.10.28), which comes from inside the sandbox and can't be trusted for a cap.
- Cursor's backend runs tools of its own: remote MCP URL servers "still run on the backend" (v2026.11.17), and `@Web` is a separate service.

**Verdict:** Cursor CLI can't run under the Deep scan's model-proxy design. It needs a different security model (an egress allowlist to `*.cursor.sh`, the key inside the sandbox, a spend cap enforced through Cursor's own limits) or should be refused for the Deep scan Stage. **UNCONFIRMED**: how `CURSOR_API_KEY` travels on the wire.

## 6. What the proxy would need to generalise

1. **A provider profile per upstream**, holding: upstream origin, auth header (`x-api-key`, `Authorization: Bearer` or `x-goog-api-key`), the headers to drop (add `x-goog-api-key` and `key=`), a path allowlist (regex plus method), refused paths, the field that names the model (`model`, `response.model`, `modelVersion`) and a usage reducer. The reducers are:
   - Anthropic: sum the four fields.
   - OpenAI: `input_tokens + output_tokens`.
   - Gemini: `totalTokenCount`.
2. **A credential kind for each profile.** OpenAI and Gemini API keys are static, as today. Vertex needs host-side token minting and refresh from ADC.
3. **The harness config must pin all of these:** the base URL, WebSocket off (Codex custom provider, opencode `transport: "http"`), analytics, update and catalog fetches off, server-side web tools off, and project-config overrides ignored.
4. **Server-side tools cross the allowlist.** A request to an allowed path can ask the provider itself to reach the web: Anthropic `web_fetch`/`web_search`, OpenAI hosted `web_search`, Gemini `googleSearch`/`urlContext`. Switching the harness's tool off doesn't stop the agent from sending such a request itself (see §7).

## 7. Newly surfaced (possible tickets)

- **Server-tool egress through the model proxy (all providers, Anthropic today).** The agent has `Bash`, so it can `curl` the proxy's base URL with its own request body. Anthropic's web fetch is a server tool ("the API fetches the content during the request"), and it fetches any URL "in user messages", which the caller writes ([Web fetch tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)). Today's `--disallowedTools WebFetch,WebSearch` only covers Claude Code's own tools. That leaves an exfiltration route to arbitrary hosts. Two mitigations:
  - The proxy refuses request bodies whose `tools` hold a server-tool type (Anthropic `web_*`, `code_execution*` and `mcp_servers`; OpenAI `web_search*`; Gemini `googleSearch`/`urlContext`/`codeExecution`).
  - Docs tell Consumers to turn web fetch and web search off on the dedicated Console workspace's Capabilities page.
- **Plain-HTTP base URL vs Gemini CLI's documented HTTPS rule.** This needs a decision: an in-sandbox loopback forwarder, TLS on the proxy, or accepting the undocumented behaviour.
- **Cursor CLI in the Deep scan.** Decide whether to refuse it for the Deep scan Stage or design a separate egress model.
- **Vertex credential kind.** This means host-side ADC token minting, and the express-mode header swap.
- **Codex ChatGPT-subscription path.** Refresh would have to happen host-side. Probably out of v1.

## 8. UNCONFIRMED (collected)

1. Whether Codex ever sends `background: true` or calls `/v1/models` on a custom provider in `codex exec`. The source shows a best-effort catalog fetch, and first-party usage of `responses-api-proxy` shows neither is needed.
2. Whether Codex's ChatGPT-auth path can be fronted by a third-party proxy that holds the refresh token.
3. Whether every Gemini stream chunk carries cumulative `usageMetadata`.
4. Whether Gemini CLI on Vertex can run in the sandbox with no real ADC, and which header the SDK then sends.
5. Whether opencode v2 has telemetry outside the packages grepped.
6. How `CURSOR_API_KEY` is sent on the wire, and every host the Cursor CLI reaches in headless mode.
