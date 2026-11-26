---
status: proposed
---

# Label ownership is enforced by reconciling against evidence, not by identity

On both Factory engines the Dispatcher's sweep is what keeps one owner per Factory state move. On every run it derives the state each factory issue should carry from the evidence its trusted writers left (Claim comments, the Plan header, the pull request, Stage checks on the head, Decision Request replies) and compares that with the label it finds. A label the evidence does not support is either a **Human move**, checked by the timeline actor's repository permission, or a wrong move, which the Dispatcher reverts. No separate guard workflow exists, and the Dispatcher never identifies itself or the merge gate by who wrote a label.

Decided in [Enforcing one owner per factory label](https://github.com/mnaimfaizy/agent-kit/issues/485), on the map [Wayfinder: Agentic Software Factory](https://github.com/mnaimfaizy/agent-kit/issues/480).

- **Human moves.** A person with write access may: add `factory:queued` to an issue with no Factory state; add or remove `factory:paused`; set `needs-decision` from any state; swap `needs-decision` for `queued` once answered; set `queued` from any non-terminal state (restart: Claim released, Attempts reset); remove every factory label (withdraw: Claim released). Triage-only users have none. No forward jump is a Human move; a person who wants to merge merges, and the gate records `merged`.
- **The actor** of a Human move is read from the issue timeline and its permission checked, on both engines. The waking event's `sender` is only a hint ([ADR 0037](0037-the-workflow-dispatcher-is-one-queued-sweep-over-the-tracker.md)).
- **A wrong move** is reverted to the state the evidence supports, with one comment per issue per wrong label, edited in place with a count and the latest actor. It is not an Attempt and never escalates. Where two state labels sit on an issue, an allowed Human move wins; otherwise the evidence-backed label stays.
- **`paused`** freezes the Dispatcher, not people: Human moves apply at once, and nothing new starts until it is removed.
- **Evidence counts only from its trusted writer**: the engine's own identity for Claim comments, Plan headers and Decision Requests (`github-actions[bot]` on the Workflow engine, the engine's user on the Orchestrate engine); a write user for Decision Request replies; the checked creator for Stage checks ([ADR 0035](0035-a-stage-check-is-a-commit-status-the-gate-checks-by-creator.md)). An evidence comment last edited by anyone else is void: a voided Claim is treated as expired, a voided Plan header is one failed Attempt.

## Considered Options

- **A guard workflow on `issues: labeled`** that reverts a move by the wrong identity. Rejected. On the Workflow engine the Dispatcher and the merge gate both write as `github-actions[bot]`, and their `GITHUB_TOKEN` writes start no workflow, so the guard would see only human moves and could not tell owners apart anyway ([GitHub facts the factory depends on](https://github.com/mnaimfaizy/agent-kit/issues/483)). On the Orchestrate engine every write is the user's own, and there is no event to wake a guard.
- **Owners identified by a signed lock comment or an App identity per owner.** Rejected: more keys for every Consumer, and still no answer for the Orchestrate engine running as its user.
- **Only flag a wrong move** (comment, or `needs-decision`). Rejected: flagging leaves the tracker saying something false, against "the tracker is the only state"; `needs-decision` would let one stray click, or a Triage user, stop a task.
- **Escalate after repeated wrong moves.** Rejected for the same reason.

## Consequences

- "One label, one owner" reads as one owner per **move**: `needs-decision` is entered by the Dispatcher or a person and left only by a person.
- On the Orchestrate engine, the engine is told apart from its own user by its evidence, not its identity; a forged engine comment by that user is an accepted risk, since they own the engine.
- Every sweep reads the timeline and comment editors of each factory issue, on top of [ADR 0037](0037-the-workflow-dispatcher-is-one-queued-sweep-over-the-tracker.md)'s query.
