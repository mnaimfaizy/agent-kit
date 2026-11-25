---
status: proposed
---

# The Orchestrate engine is a trusted host process, and its agents reach GitHub only through a Snapshot and an Outbox

The Orchestrate engine is `agent-kit factory run`, a foreground process in the npm CLI for one repository on the user's own machine (`--once` runs one sweep, for a scheduled task). It is the trusted host: it alone holds the GitHub token (a fine-grained PAT for this one repository) and the model keys (in the model proxy's memory), and it runs the Launcher and the Dispatcher. Every agent it starts runs in a Launcher sandbox under [ADR 0025](0025-a-stages-guards-are-reached-by-the-launchers-sandbox.md)'s Guards, with no GitHub credential and no route out but the proxy.

That includes the Chief of Staff. One Chief of Staff runs per Factory task, in its own sandbox, as the build Stage. What it needs from GitHub reaches it as a **Snapshot** the engine rewrites every sweep (the issue, the pull request, its checks and review threads). What it wants done, a GitHub write or a new Delegation, it writes to an **Outbox**; the engine checks each entry and acts on it, [ADR 0026](0026-every-github-write-is-a-trusted-step-working-from-the-stage-result.md)'s trusted step made continuous. Each Delegation is a sibling sandbox the engine starts, never a process inside the Chief of Staff's sandbox; a build comes out as a git bundle the engine checks and pushes.

Decided in [The Orchestrate engine's process](https://github.com/mnaimfaizy/agent-kit/issues/490), on the map [Wayfinder: Agentic Software Factory](https://github.com/mnaimfaizy/agent-kit/issues/480).

- **One Dispatcher.** The sweep (Claims, expiry, cap, overlap, retries, [ADR 0038](0038-label-ownership-is-enforced-by-reconciling-against-evidence.md)'s reconciliation) is one module in the CLI. The Workflow engine's `factory-dispatcher` ([ADR 0037](0037-the-workflow-dispatcher-is-one-queued-sweep-over-the-tracker.md)) runs it once per run; this engine runs it in a loop. An engine supplies only how a Stage starts and is cancelled, and its identity.
- **Polling, no webhooks.** A sweep every 60 seconds by default, 30 at the least. A webhook would need a public tunnel to the user's machine and a delivery secret.
- **Engine lease.** One engine sweeps a repository. It takes an Engine lease on the tracker at start, read back like a Claim and renewed every sweep, plus a local lockfile; a second engine that finds a live lease refuses to start. That stands in for the Workflow engine's concurrency group, since labels have no compare-and-swap.

## Considered Options

- **Run `orchestrate` on the host as today**, the Chief of Staff and its Delegations calling `gh` and holding the model key. Rejected: unattended, with untrusted issue and pull request text read for hours, it breaks every Guard of ADR 0025.
- **A Stage per sandbox with no Chief of Staff**, the Workflow engine run locally. Rejected: safe, but it drops what makes this engine `orchestrate` (one agent that dispatches, verifies and sends work back), and duplicates the Workflow engine on a worse runner.
- **A GitHub tool or `gh` inside the Chief of Staff's sandbox**, or a live proxy to the GitHub API. Rejected: any read endpoint it can call can be steered by injected text, and any write credential breaks ADR 0025. A Snapshot is data the engine chose to write.
- **Delegations as processes inside the Chief of Staff's sandbox.** Rejected: a builder would share the sandbox of the agent that verifies it, and the engine could not check its bundle before a push.
- **Two Dispatcher implementations, one per engine.** Rejected: the claim, expiry and retry rules would drift apart.
- **`gh auth token`** as the engine's GitHub credential. Rejected: it usually reaches every repository the user can, a wide blast radius for an unattended process.

## Consequences

- The Chief of Staff's harness must be one the model proxy can front; Delegations follow ADR 0025's per-Stage rules, and a harness without a Launcher adapter is refused.
- What the Chief of Staff may ask for in its Outbox, and how its human touchpoints move onto the tracker, are `orchestrate`'s factory mode, decided apart from this.
- A GitHub read the Snapshot lacks is a read the agent cannot make; the Snapshot grows by kit release, not by agent request.
- The engine writes every Stage's Run Record itself ([ADR 0036](0036-a-stage-records-counts-come-from-what-the-kit-runs.md)), since the proxy, Guards and Launcher are in its process; transcripts and its log stay in a local, user-only folder and expire ([ADR 0021](0021-run-records-go-to-a-private-sink-and-raw-folders-only-to-an-expiring-bucket.md)). Transcripts and collected run folders go to the raw-folder Sink only under `--upload-raw` ([ADR 0040](0040-in-factory-mode-the-chief-of-staff-never-waits-on-a-human.md)).
- Restart, stop and sleep recover from the tracker alone: an engine that dies leaves Claims that expire, and the next start releases them as an `error`, never an Attempt.
