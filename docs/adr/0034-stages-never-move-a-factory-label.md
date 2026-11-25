---
status: proposed
---

# Stages never move a factory label

A Factory task has exactly one Factory state label on its issue, and only three writers ever set one. The **Dispatcher** owns every state an agent works in (`queued`, `planning`, `planned`, `building`, `reviewing`, `checking`). It moves a task on only from what a Stage left behind: the plan comment, the pull request, a Stage check on the head commit. The **merge gate** owns `ready-to-merge`. A **human** owns the `paused` modifier and is the only one who takes a task out of `needs-decision`; the Dispatcher and a human both send it there. Which hand moves a human may make, and how a wrong one is reverted, is [ADR 0038](0038-label-ownership-is-enforced-by-reconciling-against-evidence.md). A Stage (plan, build, review, QA, security) never writes a `factory:*` label, on either Factory engine. The state lives on the issue only, never on the pull request.

Decided in [Factory lifecycle labels and their owners](https://github.com/mnaimfaizy/agent-kit/issues/482), on the map [Wayfinder: Agentic Software Factory](https://github.com/mnaimfaizy/agent-kit/issues/480).

## Considered Options

- **Each Stage moves its own label**, as the factory's design draft has it (the builder sets `implemented`, the reviewer `ready-for-qa`, QA `ready-for-merge`). Rejected. GitHub restricts no label to any writer, and every Actions run writes as the same App ([GitHub facts the factory depends on](https://github.com/mnaimfaizy/agent-kit/issues/483)), so "the reviewer's label" could not be told from the builder's. Two Stages that check side by side (QA and security) would also share one state, so it would have no single owner.
- **A lock state (`factory:locked`) between planned and building.** Rejected. Label writes have no compare-and-swap, so a lock state leaves a race window between two label writes and makes nothing atomic. A **Claim** (an assignee plus a lock comment naming the engine, run id, attempt and expiry, read back after it is written) sits on whichever state the Dispatcher owns.

## Consequences

- Enforcing one owner per label is done by reconciling each label against the evidence the owners leave, not by telling their identities apart ([ADR 0038](0038-label-ownership-is-enforced-by-reconciling-against-evidence.md)).
- Stages keep [ADR 0026](0026-every-github-write-is-a-trusted-step-working-from-the-stage-result.md)'s shape: they publish results, and the Dispatcher reads them. A Stage needs no knowledge of the lifecycle.
- The Dispatcher is the one place that counts Attempts, clears an expired Claim, and refuses an `agent:*` Trigger label on an issue that carries a Factory state.
