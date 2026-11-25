---
status: proposed
---

# The Workflow engine's Dispatcher is one queued sweep over the tracker, holding only `GITHUB_TOKEN`

On the Workflow engine the Dispatcher is one workflow, `factory-dispatcher`. Every run lists every issue with a `factory:*` label and moves each one on from what the tracker says, whatever event woke it. All its runs share one concurrency group (`cancel-in-progress: false`, `queue: max`), so one run writes at a time. It keeps nothing of its own: the tracker is its ledger, read again on every run.

Decided in [The Dispatcher on the Workflow engine](https://github.com/mnaimfaizy/agent-kit/issues/489), on the map [Wayfinder: Agentic Software Factory](https://github.com/mnaimfaizy/agent-kit/issues/480).

- **Wakes.** `issues` (labeled, unlabeled, closed), `pull_request: closed`, a `workflow_dispatch` from every Stage's last job, and a `schedule` every 15 minutes that catches expired Claims and dropped events. Not `workflow_run`.
- **Starts a Stage** with `workflow_dispatch` on that Stage's Caller, passing the issue, Attempt and a Claim nonce that the Caller puts in its `run-name`.
- **Token.** `GITHUB_TOKEN` only (`issues`, `pull-requests` and `actions` write, `contents` read). Its writes start no workflow, so it cannot wake itself. It checks the sender's permission before acting on a human event.
- **One App token, in one job.** Only the build Stage's publish job turns a Consumer-owned GitHub App's key into a short-lived token, to push and open the pull request, so the Consumer's CI runs on it without approval. Every other job, the Stage checks' writers included, keeps `GITHUB_TOKEN`.
- **Claim** is the lock comment alone, read back after writing; this engine sets no assignee.

## Considered Options

- **A handler per event**, touching only the issue that woke it. Rejected: a dropped or duplicated event leaves a task stuck or claimed twice, and labels and assignees have no compare-and-swap ([GitHub facts the factory depends on](https://github.com/mnaimfaizy/agent-kit/issues/483)). A queued sweep heals on its next run, and the shared concurrency group is the only serialization GitHub gives.
- **A state store of its own** (Actions cache, artifact, a pinned ledger issue). Rejected: it drifts from the tracker the moment a person edits a label, against "the tracker is the only state".
- **Start Stages by label.** Rejected: Stages never move a label ([ADR 0034](0034-stages-never-move-a-factory-label.md)), and a `GITHUB_TOKEN` label starts nothing.
- **Call Stages as reusable workflows from the Dispatcher.** Rejected: the Stage would hold the one concurrency group for hours and stall every other task.
- **Wake on `workflow_run`.** Rejected: the docs do not say it fires for a dispatched run; an explicit dispatch from the Stage's last job is certain.
- **A PAT, or dispatching the Consumer's CI**, for CI on factory pull requests. Rejected: a PAT is a long-lived key tied to one person; dispatching CI makes every Consumer's CI accept `workflow_dispatch`.
- **A bot assignee as part of the Claim.** Rejected: the docs do not say a bot can be assigned.

## Consequences

- A Consumer running the factory on the Workflow engine must create a GitHub App; Agent-kit creates its own as the first factory.
- Every Dispatcher run costs a full read of the factory's issues: one GraphQL query plus head statuses, cheap for one repository.
- Moves wait up to 15 minutes when an event is dropped.
- The Dispatcher leaves no Run Record; its trace is its tracker writes and its Actions log.
