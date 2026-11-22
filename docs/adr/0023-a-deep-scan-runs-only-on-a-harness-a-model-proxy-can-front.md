---
status: proposed
---

# A Deep scan runs only on a harness a model proxy can front

A Deep scan has two guarantees: the real model credential never enters the sandbox, and the launcher enforces the spend cap. Both rest on the model proxy being the sandbox's only route to a model. So the proxy becomes one core plus a provider profile per model API (`anthropic`, `openai` and `gemini-api` in v1), and a Deep scan runs only on a harness whose model traffic can all be sent to that proxy under one of those profiles. Preflight refuses any other harness for the Deep scan. Cursor CLI is the first one refused: its requests all go through Cursor's own backend, so the key would have to sit in the sandbox and the proxy could read no usage.

The core owns the network cut, strict path decoding, a per-run caller secret that the sandbox holds as its placeholder key, a bound on requests in flight, and a cap that reserves a request's declared output limit when it arrives and settles to the real usage. A profile supplies the upstream, the auth header, an exact method-and-path allowlist, a request-body filter that lets only client tools through, a header allowlist, where the model id and the declared limit sit, and a usage reducer that counts each token once. The cap stays a count of tokens on every provider.

## Considered Options

- **A second security model for harnesses the proxy can't front** (an egress allowlist to the vendor's hosts, the key in the sandbox, the vendor's own spend limits). Rejected for this effort. It gives up both guarantees, which are the reason the Deep scan runs in a sandbox at all. Such a harness can still run the CI Stages.
- **A cost cap in money instead of tokens.** Rejected. It would need a price table for every model, which would go stale with every release, for the same reason ADR 0009 rejected an effort table.
- **Credentials that need refresh on the host in v1** (Vertex AI from ADC, Codex's ChatGPT sign-in, Gemini's Login with Google). Left out. Each needs a new kind of credential that the launcher mints and refreshes; the last two are private APIs. Claude's subscription token stays as it is.

## Consequences

- The harness adapter declares whether a model proxy can front it, and with which profile, and it pins its own CLI to the proxy (base URL, WebSockets off, analytics and update checks off, its own web tools excluded, the scanned repository's config ignored). The proxy never knows which harness is calling.
- opencode runs a Deep scan only with a provider that has a profile.
- Gemini CLI's documented "HTTPS unless loopback" base-URL rule is not enforced at the version read. A contract test runs the pinned Gemini CLI against the plain-HTTP proxy, and an in-sandbox loopback forwarder is added the day that test fails.
