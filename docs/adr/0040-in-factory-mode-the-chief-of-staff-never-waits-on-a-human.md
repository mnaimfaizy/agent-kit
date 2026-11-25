---
status: proposed
---

# In factory mode the Chief of Staff never waits on a human

When the Orchestrate engine starts `orchestrate`, as `/orchestrate --factory <snapshot dir>` in a Launcher sandbox ([ADR 0039](0039-the-orchestrate-engine-is-a-trusted-host-its-agents-reach-github-through-a-snapshot-and-an-outbox.md)), nobody is in chat, so nothing inside the sandbox waits on one. Decision authority is always `autonomous`. A question it does not rule on **ends the build Stage** with a `questions` result, which the Dispatcher turns into a Decision Request and `factory:needs-decision`. Its Rulings are reviewed by the **review Stage**, not by a person: a Ruling that does not hold against its cited evidence is a Finding above nit. The human Ruling Review does not exist in factory mode. A person who disagrees uses a Human move ([ADR 0038](0038-label-ownership-is-enforced-by-reconciling-against-evidence.md)).

Decided in [Orchestrate's factory mode](https://github.com/mnaimfaizy/agent-kit/issues/491), on the map [Wayfinder: Agentic Software Factory](https://github.com/mnaimfaizy/agent-kit/issues/480).

- **One Chief of Staff per build Stage run**, so one per Claim. A new build Attempt is a new Chief of Staff, starting from the branch head, with the findings and the PR's Rulings in its Snapshot.
- **A factory Ruling cites only what GitHub still shows:** `path:line` at a SHA, a tracker permalink, a check or Actions run link, or an earlier Ruling's id. Local command output dies with the sandbox, so it is not evidence, and a question that rests on it is not ruled on.
- **Ending on a question is not a failed Attempt.** The Claim is released with `released=question`. Re-queuing re-plans with the answers, and the next build starts from the branch head.
- **The raw-upload yes is given at engine start.** [ADR 0021](0021-run-records-go-to-a-private-sink-and-raw-folders-only-to-an-expiring-bucket.md) wants a person's yes for every raw upload, and a factory Stage has no close-out to ask at. `agent-kit factory run --upload-raw` is that yes, for one process. It is never a config key. The bucket-lifecycle check still runs before each upload, and each Run Record says whether raw upload was on. Transcripts go with the raw run folder under the same yes.

## Considered Options

- **The Chief of Staff waits in its sandbox for a human answer on the tracker.** Rejected: a sandbox that waits holds a Claim and a slot for hours, its state lives outside the tracker, and an expiry would lose it.
- **A human Ruling Review on the PR before merge.** Rejected: every factory PR would wait on a person, whatever its tier. An independent review Stage keeps "the author never reviews itself". Whether a PR with Rulings may auto-merge is the merge gate's.
- **Raw uploads from a committed config key.** Rejected: it breaks ADR 0021's rule that a raw upload is never a default.
- **No raw upload from the factory.** Rejected: a run folder and its transcripts are what analysis and optimisation need, failed runs most of all.

## Consequences

- The Dispatch Plan, its "go", `relay`, `--status`, `--resume`, the QA Rulings, the merge order and the close-out do not exist in factory mode. The Claim is the go, the Plan header's Allowed paths are the scope fence, and the gate owns Ready to Merge.
- The engine copies the run folder out of the sandbox at every teardown (result, expiry, cancel, drain, restart clean-up), next to that Stage's transcript. This amends [The Orchestrate engine's process](https://github.com/mnaimfaizy/agent-kit/issues/490), which kept transcripts local only.
