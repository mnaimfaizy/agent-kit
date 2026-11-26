---
status: proposed
---

# Factory metrics are computed from the tracker, never the Sink

The Factory's v1 metrics are merge rate, first-pass success, lead time, escalation rate, revert rate and tokens per merged PR. All six come only from the tracker: label events, lock and release comments, Stage checks, pull requests and the merge gate's comments. One command reads them with the user's own `gh` and prints them: `agent-kit factory report [--since 30d] [--json] [--gate]`. The gate's shadow-to-on bar, the former `gate-report`, is one section of it. Stage Run Records in the Sink are kept for drill-down only. The past-runs dashboard still never reads the tracker, and it shows Stage records as runs grouped under their task, with no metric tiles.

Decided in [Factory metrics in v1: which, from which source, shown where](https://github.com/mnaimfaizy/agent-kit/issues/497), on the map [Wayfinder: Agentic Software Factory](https://github.com/mnaimfaizy/agent-kit/issues/480).

- **Counted over** Factory tasks that reached a terminal state (merged, withdrawn, or closed unmerged) inside the window. A restart counts as the same task. Each metric is shown by Risk tier. Revert rate and lead time are also shown by merge path (person or gate).
- **Tokens** are the sum of the release-comment totals for every Stage run of the task, failed Attempts included. As in [ADR 0042](0042-the-daily-token-cap-is-a-reservation-summed-from-the-tracker.md), a missing or edited total counts at its full cap, and the report shows how many such totals it counted.
- **A revert** is a revert of a merged Factory PR, or a `regression` issue linking one, within 7 days. This is wider than the gate's trip ([ADR 0041](0041-auto-merge-exists-only-in-the-factory-behind-its-merge-gate.md)), which only an auto-merged pull request sets off: the revert rate counts every merged Factory PR, so it can be shown by merge path.

## Considered Options

- **Join Stage Run Records from the Sink on `(repo, task)`.** Rejected for three reasons. It would need a second credential. A Caller without a sink secret keeps no records, so its runs would vanish from the numbers. And merges and reverts leave no Run Record anyway, so the tracker would still be needed.
- **A Factory view on the past-runs dashboard.** Rejected: it would have to read the tracker, which the dashboard never does, or rely on the Sink alone.
- **A recurring summary comment on the Factory control issue.** Rejected for v1: it is noise, and it would add a job to a sweep that judges nothing.
- **A task record.** Not needed: the tracker already groups a task's evidence.

## Consequences

- The release comment's fixed format must carry `stage`, `attempt`, `outcome` and `tokens`. The gate's merge must be marked by its own PR comment ("merged at `<sha>`"). A PR is tied to its task by its closing reference. Edited evidence is void ([ADR 0038](0038-label-ownership-is-enforced-by-reconciling-against-evidence.md)).
- No Run Record field is added for metrics.
- Per-Stage and per-model breakdowns are not in v1. They would come from the Sink.
