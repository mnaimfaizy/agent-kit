---
status: proposed
---

# Adapters are proven against a stub model in the real sandbox

A pin bump keeps a Support Level only if the contract tests pass on the new pin ([ADR 0028](0028-a-security-stage-runs-only-on-a-harness-with-a-recorded-run.md)), and preflight refuses any adapter that cannot reach a Guard ([ADR 0025](0025-a-stages-guards-are-reached-by-the-launchers-sandbox.md)). So the tests have to show that the pinned CLI, in its Harness image ([ADR 0029](0029-the-kit-publishes-one-image-per-harness-pinned-by-digest.md)), is held to every Guard. A harness only shows that by acting, and a real model cannot be steered into each breach on every pull request without a key, spend and a result that changes run to run.

So the adapter tests come in two tiers:

- **Tier A, offline**, in `ci.yml` on every pull request, with no Docker and no secrets. It covers each adapter's launch plan per Stage and credential kind, its checkout-config list, the sandbox's environment allowlist, `harnesses.json` against the adapters ([ADR 0030](0030-harness-facts-are-published-per-tag-as-data.md)), and sample Custom harness files against the schema, attested levels included.
- **Tier B, live harness, stub model**, in its own workflow. The pinned CLI runs in its Harness image, in the real sandbox under gVisor, behind the real model proxy. The proxy's upstream is a **stub model**: a kit-owned scripted server that speaks each provider profile (`anthropic`, `openai`, `gemini-api`) and answers with fixed tool calls. The stub picks the shell tool from the tools the harness declares in its request, and a Custom harness file may name it (`probe_shell_tool`). Through that tool the harness itself attempts a breach of each of the six Guards, and host-side assertions check that none got through. Each adapter runs the suite as a read-only Stage, as a writing Stage and, where the proxy fronts it, as a Deep scan.

Tier B runs on pull requests that touch an adapter, a Harness image digest, the Launcher, the sandbox driver or the model proxy, so on every pin bump and every monthly image refresh, and weekly on `main`. It needs no secret, so it runs on fork pull requests too. Both tiers gate a pin bump. A weekly failure opens an issue and changes no level; a failed Guard probe also blocks the next release until the issue is resolved.

**Cursor CLI** cannot be stubbed, because all its traffic goes through Cursor's backend. Its Tier B runs against the real backend with a `CURSOR_API_KEY` held in a protected environment, on the weekly schedule and on Cursor pin pull requests from this repository only, with a fixed prompt in place of the stub's script. It probes the weaker key-and-network form on plan, implement and review. Its result is not deterministic, which the `tried` cap already allows for.

**A Proving run** is the Tier B suite on that exact harness and digest (or Custom harness file), then the real Stage on a real model, recorded under one run URL. That URL is what a Support Level cell links to, so "every Guard probe passed" means the same suite wherever it is claimed. `agent-kit harness test custom:<name>` runs the suite on a Consumer's own Custom harness file; it is the first half of their Proving run.

Decided in [What the contract tests prove per adapter](https://github.com/mnaimfaizy/agent-kit/issues/453), on the map [Wayfinder: Stages run on a Consumer-chosen harness](https://github.com/mnaimfaizy/agent-kit/issues/438).

## Considered Options

- **Real-model contract tests.** Rejected as the gate. They need a key for every provider in CI, cost on every bump, cannot run on fork pull requests, and an agent asked to breach a Guard may simply decline.
- **Offline tests only, with the host-side probes every run already does.** Rejected. Those probes check the network cut and the model route, but not reads, writes, credentials or config loading as the harness actually behaves.
- **A probe conversation as a tenth part of the adapter.** Rejected. It would bring back a per-harness Guard table that [ADR 0027](0027-a-harness-adapter-returns-a-launch-plan-as-data.md) ruled out. The shell is also the strongest probe, being what hooks never confined.
- **The suite on all six Stages per adapter.** Rejected. The Guards differ by Stage only in Writes, so a read-only Stage, a writing Stage and the Deep scan cover every combination.
- **A Proving run that relies on the per-run host probes alone.** Rejected. A real model cannot be made to attempt each breach, so most Guards would go unprobed on the pair being proven.
- **Cursor CLI on Tier A only.** Rejected. The weaker key-and-network form would then never be probed.

## Consequences

- The kit maintains a stub model for three provider APIs, streaming and tool calls included. Each provider API change is a stub change.
- The live tests need Docker and `runsc` on the runner, and take minutes per adapter.
- Gemini CLI's plain-HTTP base URL ([ADR 0023](0023-a-deep-scan-runs-only-on-a-harness-a-model-proxy-can-front.md)) and opencode's `--standalone`, `OPENCODE_CONFIG`, `OPENCODE_DISABLE_AUTOUPDATE` and `transport: "http"` ([ADR 0027](0027-a-harness-adapter-returns-a-launch-plan-as-data.md)) each get a named assertion in Tier B, so a bump that breaks one says why.
- This repository holds a `CURSOR_API_KEY` in a protected environment.
