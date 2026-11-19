# Can a deep scan's model-API proxy inject a subscription OAuth token

Research for wayfinder ticket [#342](https://github.com/mnaimfaizy/agent-kit/issues/342) on map [#332](https://github.com/mnaimfaizy/agent-kit/issues/332). It follows decision 2 in the resolution of [#338](https://github.com/mnaimfaizy/agent-kit/issues/338): during a deep scan the model credential never enters the sandbox; a key-injecting proxy outside it is the only route out, and Claude Code inside reaches it through `ANTHROPIC_BASE_URL`. Today's CI audit authenticates with a subscription token from `claude setup-token`, passed as `CLAUDE_CODE_OAUTH_TOKEN` ([`security-audit-reusable.yml`](../../.github/workflows/security-audit-reusable.yml), input `claude_code_oauth_token`).

This builds on [How Claude Code runs sandboxed with Bash for a headless deep scan](https://github.com/mnaimfaizy/agent-kit/blob/research/deep-scan-claude-code-sandbox/docs/research/deep-scan-claude-code-sandbox.md) (branch `research/deep-scan-claude-code-sandbox`) and does not repeat it: that note already covers the credential precedence list, `--bare` ignoring `CLAUDE_CODE_OAUTH_TOKEN`, the hosts Claude Code needs, and the secure-deployment proxy pattern.

This note states facts and limits only. It picks no design; the spec decides.

- **Read on:** 2026-11-19. Docs pages carry no publish date, so a fact from a docs page is dated by the read.
- **Sources:** primary only.
  - Claude Code docs: [Authentication](https://code.claude.com/docs/en/authentication.md), [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway.md), [Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect.md), [Gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md), [Environment variables](https://code.claude.com/docs/en/env-vars.md), [Settings reference](https://code.claude.com/docs/en/settings-reference.md) (`apiKeyHelper`), [Enterprise network configuration](https://code.claude.com/docs/en/network-config.md), [Run Claude Code programmatically](https://code.claude.com/docs/en/headless.md), [Securely deploying AI agents](https://code.claude.com/docs/en/agent-sdk/secure-deployment), [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md).
  - Claude API docs: [API overview](https://platform.claude.com/docs/en/api/overview), [Beta headers](https://platform.claude.com/docs/en/api/beta-headers), [Get your Claude API key](https://platform.claude.com/docs/en/get-api-key), [Rate limits](https://platform.claude.com/docs/en/api/rate-limits), [Pricing](https://platform.claude.com/docs/en/about-claude/pricing).
  - Terms: [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) (effective 8 Oct 2025).
- **Nothing was run.** No proxy was built and no request was sent with any credential.
- **INFERENCE** marks a conclusion drawn from stated facts that no source states outright. **UNCONFIRMED** marks a point no source settles. Both are collected at the end.

## 1. Which header carries each credential

| Credential (as Claude Code reads it)                                                 | Header Claude Code sends                                                                                                     | Source                                                                                                                                                                                                                 |
| :----------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                                                  | `X-Api-Key`                                                                                                                  | [authentication](https://code.claude.com/docs/en/authentication.md), "Authentication precedence"; [env vars](https://code.claude.com/docs/en/env-vars.md)                                                              |
| `ANTHROPIC_AUTH_TOKEN`                                                               | `Authorization: Bearer <value>` ("the value you set here will be prefixed with `Bearer `")                                   | same                                                                                                                                                                                                                   |
| `apiKeyHelper` output                                                                | Both `X-Api-Key` and `Authorization: Bearer`                                                                                 | [settings reference](https://code.claude.com/docs/en/settings-reference.md), `apiKeyHelper`; [gateway connect](https://code.claude.com/docs/en/llm-gateway-connect.md), "How the credential variable maps to a header" |
| claude.ai subscription login (`/login`, and per INFERENCE `CLAUDE_CODE_OAUTH_TOKEN`) | `Authorization` carries the login's token, **plus** an OAuth capability value in `anthropic-beta` that the upstream requires | [gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md), "Request headers"                                                                                                              |

What the Claude API accepts at `api.anthropic.com` ([API overview](https://platform.claude.com/docs/en/api/overview), "Authentication"):

- `Authorization: Bearer <token>`, where the token is an API key or a short-lived Workload Identity Federation access token. "Required: Yes, unless `x-api-key` is set."
- `x-api-key`: a Console API key; "Legacy fallback for `Authorization`, still supported."
- `anthropic-workspace-id`: required with an API key not scoped to a workspace.
- The public API pages do not document subscription OAuth tokens as an accepted credential, and the [beta headers](https://platform.claude.com/docs/en/api/beta-headers) page does not list the OAuth beta value. The only primary statements about it are in the Claude Code gateway guide:
  - "When the developer authenticates with a claude.ai login … this header [`anthropic-beta`] also carries an OAuth capability that the upstream requires, and stripping it fails those requests with `401`."
  - `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` leaves in place "The OAuth `anthropic-beta` value that subscription authentication requires" ("Disable pre-release capabilities").
  - Gateways that pass subscription traffic to Anthropic "must forward `Authorization` and the OAuth capability in `anthropic-beta`" ([LLM gateways](https://code.claude.com/docs/en/llm-gateway.md), "Subscriptions and gateways").
  - The exact string of that beta value is UNCONFIRMED from a primary source.

## 2. Can an injecting proxy carry a subscription OAuth token

### What the docs describe

The docs describe one subscription-through-a-gateway shape, and it is **pass-through, not injection**: set `ANTHROPIC_BASE_URL` with no gateway credential; "Requests still route through the gateway, but a saved claude.ai login remains the active credential, so its usage limits and billing apply" ([LLM gateways](https://code.claude.com/docs/en/llm-gateway.md), "Subscriptions and gateways"). In that shape the client holds the token and the gateway only forwards `Authorization` and `anthropic-beta`. For a deep scan that puts the token inside the sandbox, which #338 rejected.

The docs describe injection (agent holds nothing, proxy adds the credential) only in general terms: "The agent sends requests without credentials, the proxy adds them, and forwards the request to its destination" ([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment), "The proxy pattern"). No page shows it with a subscription token; every worked gateway example injects or issues an API-style key ([LLM gateways](https://code.claude.com/docs/en/llm-gateway.md), "Roll out a gateway": "Deploy the gateway and give it your provider credential").

### What injection of an OAuth token would need (INFERENCE)

From the header facts in section 1, a proxy injecting a `setup-token` value would have to make the forwarded request look like one from a subscription-authenticated Claude Code:

1. Set `Authorization: Bearer <oauth token>` and drop any `x-api-key` the client sent.
2. Make sure `anthropic-beta` carries the OAuth capability value. Claude Code adds it only when it believes it is subscription-authenticated, so:
   - if the sandboxed Claude Code is started with a gateway credential (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` or `apiKeyHelper`), it does not send that value, and the proxy must append it itself, needing the exact string, which is not published (UNCONFIRMED);
   - if instead it is started with a placeholder `CLAUDE_CODE_OAUTH_TOKEN` (non-`--bare`), it should send the value itself and the proxy only swaps the `Authorization` value. Whether Claude Code accepts a placeholder OAuth token at startup, or validates it first against an Anthropic endpoint that does not follow `ANTHROPIC_BASE_URL`, is UNCONFIRMED.
3. Forward `anthropic-version` and the rest unchanged, and relay the streaming response event by event (gateway guide, "Streaming"), plus `anthropic-ratelimit-unified-*` response headers, which Claude Code reads for plan-limit display and to tell a plan limit from a throttle on `429` (gateway guide, "Response headers").

Either variant is undocumented and depends on Claude Code internals that "change with Claude Code releases" (gateway guide on `anthropic-beta`). Nothing here was tested.

### Hosts and refresh

- **Inference host:** `api.anthropic.com`, paths `/v1/messages` (posted as `/v1/messages?beta=true`) and optionally `/v1/messages/count_tokens`; a `HEAD /api/hello` warm-up probe can be rejected without harm (gateway guide, "Optional endpoints and startup traffic").
- **OAuth hosts:** `claude.ai` for account sign-in; `platform.claude.com` for "OAuth token exchange, refresh, and revocation … for claude.ai accounts" ([network config](https://code.claude.com/docs/en/network-config.md), "Network access requirements").
- **Refresh for a `setup-token` token:** `CLAUDE_CODE_OAUTH_TOKEN` is an "OAuth access token". "Unless you run `/login`, Claude Code uses the token you set for the whole session. To replace an expired token, generate a new one and restart" ([env vars](https://code.claude.com/docs/en/env-vars.md)). `setup-token` mints a one-year token and saves it nowhere ([authentication](https://code.claude.com/docs/en/authentication.md), "Generate a long-lived token"). So no refresh flow exists for it to use; INFERENCE: a proxy injecting it needs only `api.anthropic.com`, not `platform.claude.com`, and the token is rotated by hand once a year. (A separate `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` exists, but it is consumed by `claude auth login`, "works once, because the exchange replaces it", and needs `CLAUDE_CODE_OAUTH_SCOPES`; it is not a `setup-token` path.)
- **Direct calls that skip `ANTHROPIC_BASE_URL`:** the fast mode availability check and the WebFetch domain safety check go straight to `api.anthropic.com` (gateway guide; [gateway connect](https://code.claude.com/docs/en/llm-gateway-connect.md), "Turn off traffic outside the gateway path"). In a no-egress sandbox they fail; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns off the first and nonessential traffic, `skipWebFetchPreflight: true` the second (and #338 already disallows web tools).
- **Scope of the token:** a `setup-token` token "can only make model requests" ([authentication](https://code.claude.com/docs/en/authentication.md)). Through a proxy, anything inside the sandbox can spend it on model requests up to the plan's limits.

## 3. What Claude Code inside the sandbox must be given

Claude Code needs some credential to start; "a reachable base URL isn't one" ([gateway connect](https://code.claude.com/docs/en/llm-gateway-connect.md), troubleshooting row "Claude Code asks you to log in even though the curl test succeeds"). The documented options, each holding no real secret if the proxy owns the real one:

| Inside the sandbox                      | Header sent to the proxy                             | Works with `--bare`                                                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                             |
| :-------------------------------------- | :--------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_AUTH_TOKEN=<placeholder>`    | `Authorization: Bearer <placeholder>`                | UNCONFIRMED: bare-mode docs name only `ANTHROPIC_API_KEY` and `apiKeyHelper` ([headless](https://code.claude.com/docs/en/headless.md), "Start faster with bare mode") | The docs' default for gateways ("If you weren't told which kind, use `ANTHROPIC_AUTH_TOKEN`"). Takes precedence over a saved login immediately.                                                                                                                                                                                                                                                                                   |
| `ANTHROPIC_API_KEY=<placeholder>`       | `X-Api-Key: <placeholder>`                           | Yes, documented                                                                                                                                                       | In `-p` "the key is always used when present" ([authentication](https://code.claude.com/docs/en/authentication.md)). A non-Anthropic-format key behind a gateway turns off the fast mode check and `/feedback` upload (gateway connect, troubleshooting).                                                                                                                                                                         |
| `apiKeyHelper` printing a placeholder   | Both headers                                         | Yes, via `--settings` ([headless](https://code.claude.com/docs/en/headless.md))                                                                                       | Re-run every 5 minutes by default and on `401`/`403` ([settings reference](https://code.claude.com/docs/en/settings-reference.md)); a real vault fetch is not needed. Runs outside Claude Code's own Bash sandbox ([prior note](https://github.com/mnaimfaizy/agent-kit/blob/research/deep-scan-claude-code-sandbox/docs/research/deep-scan-claude-code-sandbox.md), section 2), but here it would run inside the outer boundary. |
| `CLAUDE_CODE_OAUTH_TOKEN=<placeholder>` | `Authorization` + OAuth `anthropic-beta` (INFERENCE) | No: "Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`" ([authentication](https://code.claude.com/docs/en/authentication.md))                                         | Only route that would make Claude Code send the OAuth beta value itself. Startup acceptance of a fake token is UNCONFIRMED. Non-bare `-p` loads the target repo's hooks, `.mcp.json` and `CLAUDE.md` "even in a folder you've never trusted" ([headless](https://code.claude.com/docs/en/headless.md)).                                                                                                                           |

Common to all: `ANTHROPIC_BASE_URL` pointing at the proxy's local relay (plain HTTP is what lets the proxy see and rewrite headers; [secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment), "Option 1"), and the proxy must strip whatever placeholder arrives in **both** `Authorization` and `x-api-key` before adding the real credential. Project and local settings cannot set `CLAUDE_CODE_OAUTH_TOKEN` ([env vars](https://code.claude.com/docs/en/env-vars.md): "Ignored in project and local settings"), so the target repo cannot override it; whether project settings can set `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN` follows the [rules for when `env` values apply](https://code.claude.com/docs/en/settings-reference.md) and, in `-p`, project `env` applies at startup without a trust prompt. INFERENCE: a target repo's `.claude/settings.json` could re-point `ANTHROPIC_BASE_URL` unless the launcher passes it via `--settings` or managed settings, or uses `--bare`; with no egress the re-pointed URL would go nowhere, but it is worth pinning.

## 4. Do the subscription terms permit this

Facts:

- Claude Code under Free, Pro, Max and Ultra is governed by the [Consumer Terms](https://www.anthropic.com/legal/consumer-terms); Team, Enterprise and API by the Commercial Terms ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md), "License").
- Consumer Terms, section 3: users may not access the Services "through automated or non-human means", except "when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it". Section 2: no sharing account credentials, and no making the account "available to anyone else".
- The Claude Code docs explicitly permit the token for automation: `CLAUDE_CODE_OAUTH_TOKEN` is for "CI pipelines and scripts where browser login isn't available" ([authentication](https://code.claude.com/docs/en/authentication.md), precedence item 5), and "Alternative to `/login` for SDK and automated environments" ([env vars](https://code.claude.com/docs/en/env-vars.md)). INFERENCE: that is the "explicitly permit" exception for running Claude Code headless with one's own token, which is what today's CI audit does.
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md), "Authentication and credential use":
  - OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  - Developers building products, including with the Agent SDK, "should use API key authentication". Anthropic does not permit third-party developers "to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users", and "developers may not collect, store, or intermediate Claude.ai credentials or session tokens".
  - It does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
  - "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK" ("Acceptable use").
  - "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

What no source settles (UNCONFIRMED): whether a Consumer's **own** proxy, holding the Consumer's **own** `setup-token` and injecting it into requests from an unmodified Claude Code on the Consumer's own machine or runner, counts as permitted ordinary use or as "intermediating" a session token. The prohibition is written about third-party developers acting "on behalf of their users"; agent-kit would ship the proxy code but the Consumer would run it with their own token. The docs' only subscription-through-gateway pattern is pass-through. A team sharing one Consumer's token across a team's CI runs would also meet the "make your Account available to anyone else" clause (INFERENCE). Anthropic's sales contact is the route the legal page names for questions about permitted authentication.

## 5. The API-key alternative for a Consumer

Setup ([get API key](https://platform.claude.com/docs/en/get-api-key); [API overview](https://platform.claude.com/docs/en/api/overview)):

- A separate Claude Console account at `platform.claude.com`; a claude.ai subscription does not supply API keys or API usage. Subscription limits do not apply to API-key traffic and it is "billed per token to whoever owns the credential" ([LLM gateways](https://code.claude.com/docs/en/llm-gateway.md), "Subscriptions and gateways").
- Create a key (`sk-ant-…`, shown once) on the API keys page, choosing a type (personal, service account, or legacy workspace key; service account keys are meant for "CI pipelines") and an expiration; optionally scope it to a workspace. A key not scoped to a workspace must send `anthropic-workspace-id`.
- Payment by major credit card, buying credits on the Billing page; "Billing is based on actual monthly usage"; new users get free test credits ([pricing](https://platform.claude.com/docs/en/about-claude/pricing), "Billing and payment", FAQ).
- Works with `--bare`, so the target's hooks, `.mcp.json` and `CLAUDE.md` are not auto-loaded ([headless](https://code.claude.com/docs/en/headless.md)). The proxy injects `x-api-key` or `Authorization: Bearer`; no beta value, no refresh host. Proxy injection of an API key is the pattern the secure-deployment guide and gateway rollout docs describe.

Billing controls ([rate limits](https://platform.claude.com/docs/en/api/rate-limits)):

- Monthly spend caps by tier: Start $500, Build $1,000, Scale $200,000. New organizations "may start in the Evaluation tier, with limits below the standard limits".
- A user-set monthly spend limit below the cap, organization-wide and per workspace (not on the default workspace); requests over it fail with `400`.
- INFERENCE: a dedicated workspace with its own spend limit and a service account key gives a Consumer a hard ceiling on what a deep scan, or code inside it spending through the proxy, can cost. This bears on the "budgets" fog #338 left on the map.

Per-token prices read on 2026-11-19 ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)), USD per million tokens:

| Model                                            | Input | 5m cache write | Cache hit | Output |
| :----------------------------------------------- | :---- | :------------- | :-------- | :----- |
| Claude Opus 5.5 (the workflow's default `model`) | $4    | $5             | $0.20     | $20    |
| Claude Sonnet 5.5                                | $2    | $2.50          | $0.10     | $10    |
| Claude Haiku 5.5 (prompts up to 100k tokens)     | $0.10 | $0.125         | $0.01     | $0.50  |

What one deep scan costs in tokens is UNCONFIRMED; nothing was run.

## Trade-offs in one place

|                           | Subscription token injected by proxy                                 | API key injected by proxy                                    |
| :------------------------ | :------------------------------------------------------------------- | :----------------------------------------------------------- |
| Documented by Anthropic   | No (only pass-through is)                                            | Yes (secure deployment, gateway rollout)                     |
| Needs undocumented detail | OAuth `anthropic-beta` value, or placeholder-OAuth startup behaviour | No                                                           |
| `--bare`                  | No                                                                   | Yes                                                          |
| Refresh / extra hosts     | None for `setup-token`; manual yearly rotation                       | None; key expiry chosen at creation                          |
| Cost to Consumer          | Inside existing plan limits                                          | New Console account, card, per-token bill                    |
| Spend ceiling             | Plan usage limits                                                    | Tier cap plus user-set workspace limit                       |
| Terms                     | Permitted for own headless Claude Code; proxy injection unaddressed  | Consumer Terms' automated-access exception names the API key |
| Breakage risk             | Tied to Claude Code internals that change by release                 | Stable public API contract                                   |

## UNCONFIRMED and INFERENCE, collected

1. UNCONFIRMED: the exact OAuth `anthropic-beta` string; no public API page lists it.
2. INFERENCE: `CLAUDE_CODE_OAUTH_TOKEN` is sent like a `/login` credential (`Authorization` plus the OAuth beta value); the docs say this of "a claude.ai login".
3. INFERENCE: with a gateway credential variable set, Claude Code does not add the OAuth beta value, so an injecting proxy would have to.
4. UNCONFIRMED: whether Claude Code accepts a placeholder `CLAUDE_CODE_OAUTH_TOKEN` at startup or validates it against an endpoint outside `ANTHROPIC_BASE_URL`.
5. INFERENCE: a `setup-token` token needs no refresh and so no `platform.claude.com` route; it is rotated by hand within a year.
6. UNCONFIRMED: whether `ANTHROPIC_AUTH_TOKEN` is read in `--bare` mode.
7. INFERENCE: a target repo's project settings could re-point `ANTHROPIC_BASE_URL` in non-bare `-p` unless pinned by `--settings` or managed settings.
8. INFERENCE: the docs' description of `CLAUDE_CODE_OAUTH_TOKEN` for CI is the "explicitly permit" exception to the Consumer Terms' automated-access clause for headless Claude Code.
9. UNCONFIRMED: whether a Consumer's own injecting proxy holding their own subscription token is permitted use or prohibited intermediation.
10. INFERENCE: one Consumer's token shared across a team's runs meets the "make your Account available to anyone else" clause.
11. INFERENCE: a dedicated workspace with a spend limit bounds deep-scan spend under the API-key route.
12. UNCONFIRMED: the token cost of one deep scan.
