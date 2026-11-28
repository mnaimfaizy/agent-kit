---
status: accepted
---

# Executors are chosen per Delegation from an ordered list

`executors.<kind>` (`build`, `analysis`, `qa`, and now `review`) may name an ordered list of entries, each a harness with its own `model` and `effort`, instead of one harness id. When the Dispatch Plan is made, each Delegation gets the first entry that matches and is available. An entry matches when its `when_label` is one of the issue's labels; an entry with no `when_label` matches every issue. `spread: round-robin` makes entries that tie on the same match take turns. An entry that is full, because it reached its own `limit`, or unavailable, because its CLI is missing or signed out at step 1, passes the Delegation to the next match. If no entry is free, the Delegation goes into a later wave. Nothing changes harness after "go": the human approves each Delegation's harness, model and effort, and a harness that fails mid-run stops or raises a Decision Request as before. With `executors.review` set to another harness, a building Delegation's code review becomes a **review Delegation** (`d<issue>-review<k>`). The Chief of Staff starts it on a detached worktree at the reported head. It writes nothing but its report, and runs one round, whose findings the building Delegation fixes inside its scope fence.

This extends [ADR 0006](0006-orchestrate-runs-on-a-detected-harness.md), which allowed one other harness per kind of work. A single id still reads as it did, with `models.<kind>` and the new `efforts.<kind>` applying to it and to the Chief of Staff's own harness, so no existing config changes. Decided in [#477](https://github.com/mnaimfaizy/agent-kit/issues/477).

## Considered Options

- **`models` stays keyed by kind of work, for every harness.** Rejected. A model name belongs to one harness, so a list of harnesses needs a model, and an effort, on each entry. A list entry with no `model` or `effort` takes its harness's default, never `models.<kind>` or `efforts.<kind>`, which may not exist there.
- **Fall back to another harness during the run** when one is rate-limited. Rejected. It puts a harness nobody approved on a branch, and in the Factory no human is there to approve it ([ADR 0040](0040-in-factory-mode-the-chief-of-staff-never-waits-on-a-human.md)). Fallback happens only while the plan is made, from the step-1 check.
- **Choose the harness by a line in the issue body.** Rejected. It is free text that drifts, and anyone who can edit the issue can change it. Labels are structured, and the tracker shows them.
- **The building Delegation starts the reviewer itself**, in its own working copy. Rejected. Only the Chief of Staff starts headless runs and has checked their CLIs, a Live Session's sandbox may not run another harness's CLI, and two Executors in one working copy overwrite each other.
- **Re-review after the fixes, automatically.** Rejected for its cost. The fixes are verified at step 7 like any report, and a second round is the human's call, or a Ruling in an autonomous run.
- **A table mapping the kit's effort names to each harness's.** Rejected, for the reason [ADR 0009](0009-stage-settings-resolve-in-the-caller.md) and [ADR 0027](0027-a-harness-adapter-returns-a-launch-plan-as-data.md) give: it goes stale. `effort` passes through as written, and the harness's CLI rejects a value it does not take.

## Consequences

- **Each harness file gains an `Effort:` line**, giving its flag or `none`. An `effort` on a harness whose line says `none` is a config problem.
- **The Dispatch Plan and the Run Events name each Delegation's entry**: its harness, model and effort, and why it was chosen (a label, the catch-all, round-robin, or a fallback and its cause), so runs on different harnesses can be compared.
- **A Delegation's Support Level warning** comes from the lowest level among its build and review harnesses.
- **`limits.building` stays the total.** An entry's `limit` caps its own share. A review Delegation counts against its entry's `limit` only.
