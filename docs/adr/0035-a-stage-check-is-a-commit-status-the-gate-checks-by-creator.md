---
status: proposed
---

# A Stage check is a commit status, and the merge gate checks who wrote it

Review, QA and security each record a **Stage check** on the head commit of a Factory task's pull request: a commit status with the context `factory/review`, `factory/qa` or `factory/security`. The merge gate reads only these statuses, the same way on either Factory engine.

Decided in [Verdicts on the head commit](https://github.com/mnaimfaizy/agent-kit/issues/487), on the map [Wayfinder: Agentic Software Factory](https://github.com/mnaimfaizy/agent-kit/issues/480).

- **States.** `pending` when the Stage starts; `success` or `failure` only from a Stage result a trusted step has validated; `error` when the Stage left no valid result (crash, timeout, malformed report). The Dispatcher counts `failure` as a failed Attempt and treats `error` as a retry.
- **Writer.** The trusted step after the Stage ([ADR 0026](0026-every-github-write-is-a-trusted-step-working-from-the-stage-result.md)), never the agent: the publish job on the Workflow engine, the Dispatcher's publish step on the Orchestrate engine. Each engine writes with one fixed identity, and the merge gate refuses a Stage check whose `creator` is not that identity.
- **One head.** A status belongs to one SHA, so every new head, a fix push or a base-branch update alike, starts with no Stage check, and all three Stages run again. Nothing carries over, except across a clean base-only update, which the merge gate carries ([ADR 0041](0041-auto-merge-exists-only-in-the-factory-behind-its-merge-gate.md)).
- **Review.** Findings stay threads ([ADR 0011](0011-every-review-finding-is-a-thread.md)). The Review report gains a strict header line, the result and the head SHA, which the trusted step parses. It fails while any open Finding on that head is above nit; a declined thread the reviewer left silent, which means it agrees, does not count.
- **QA.** Derived from the strict QA Report header ([ADR 0033](0033-qa-report-summary-is-the-post-with-a-strict-header.md)), whose commit must equal the head. Items held for a person are not a failure: the status is `success` with the description `passed; held <n>`, so the gate reads the held count from the status alone and routes the merge to a human. A header saying no manual QA was needed is `success`.
- **Security.** The description is exactly `passed` or `held for a maintainer`: no count, no severity, no link. Findings stay in the private draft advisory. The audit failing to run (a missing token, a failed probe) writes the same `held` text, so a hold does not say which it was.

## Considered Options

- **Check runs.** Rejected. Only a GitHub App can create one, so the Orchestrate engine, writing with the user's own token, could not. And every Actions run is the same "GitHub Actions" App, so the gate could not tell the trusted step's check from one any workflow in the repository wrote ([GitHub facts the factory depends on](https://github.com/mnaimfaizy/agent-kit/issues/483)). A commit status works with any write token and records its creator's login.
- **Reuse the word Verdict.** Rejected. **Verdict** already names the Review responder's answer on one thread (`fixed`, `addressed`, `declined`).
- **Carry the review's result over a push that only updates from the base.** Not decided here: v1 is strict, and whether the merge gate may relax it is [The merge gate](https://github.com/mnaimfaizy/agent-kit/issues/492)'s call.
- **Held QA items as `failure`.** Rejected. A required status in `failure` blocks the human merge the held items are asking for.

## Consequences

- Every rebase or base update costs a full review, QA and security run.
- The merge gate's inputs are three statuses and their creators; it parses no comment.
- A failed `factory/security` on a public repository still says something was held; sharing that text with "could not run" is the only blur.
