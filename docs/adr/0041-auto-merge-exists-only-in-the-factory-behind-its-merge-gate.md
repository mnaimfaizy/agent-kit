---
status: proposed
---

# Auto-merge exists only in the Factory, behind its merge gate

Agent-kit promises that nothing auto-merges. The Factory is the one exception. Its **merge gate** may merge a task's pull request by itself, but only while its mode is `on`, and only for a Risk tier in `merge.auto_tiers` (default `[low]`, never `high`). Every fact on its list must also hold for the exact head it merges. The mode starts `off`. It sits in the factory config, a Guarded path, so only a pull request a person approves changes it. It reaches `on` only through `shadow`, on a measured record.

Decided in [The merge gate](https://github.com/mnaimfaizy/agent-kit/issues/492), on the map [Wayfinder: Agentic Software Factory](https://github.com/mnaimfaizy/agent-kit/issues/480).

- **Where it runs.** The gate is a pure decision core in the shared Dispatcher sweep, the same on both engines. It merges at most once per sweep per repository. The merge names the head (`--match-head-commit`), never uses `--admin`, and never uses GitHub's own auto-merge. On the Workflow engine a dispatched `factory-merge` job merges with the Consumer App token, since a `GITHUB_TOKEN` merge starts no `push` workflows. On the Orchestrate engine the user's one-repository PAT merges.
- **Not ruleset-required.** The `factory/*` Stage checks are not required by a ruleset: a ruleset would block every pull request that is not a factory one, and it cannot check a status's creator. The gate checks them itself ([ADR 0035](0035-a-stage-check-is-a-commit-status-the-gate-checks-by-creator.md)).
- **Risk rules** live in `.agent-kit/factory/risk-rules.yml`, read from the base branch. A missing or unreadable file makes every task `high`. The tier is the highest of the plan, the rules on the final diff, and a `risk:<tier>` label a person adds, so it only ever rises.
- **A clean base-only update carries the Stage checks.** When a behind branch is updated with no conflict, and the base side changed none of the files the pull request changes, the gate copies the three Stage checks to the new head with ` (carried from <sha7>)` appended. CI still runs on the new head. This amends ADR 0035's "Nothing carries over".
- **A bad auto-merge trips it.** A revert of an auto-merged pull request, or a `regression` issue linking one, makes the gate act as `shadow` until a person clears the marker on the control issue **and** the shadow bar is met again, counted from the trip. The gate checks both itself, so clearing the marker alone does not turn it back on (amended by [Rolling out the Factory on Agent-kit](https://github.com/mnaimfaizy/agent-kit/issues/498)).
- **A tier-only hold still records.** When a task's tier is its only hold, the gate's comment reads `held: tier <t> only (would merge at <sha>)`, so a tier outside `auto_tiers` builds its own shadow record while the gate is `on`.

## Considered Options

- **No auto-merge at all.** Rejected: the Factory's point is that low-risk work lands without a person at every merge. A shadow record measures that before it is allowed.
- **GitHub's own auto-merge, or a merge queue.** Rejected: auto-merge merges whatever turns green later, outside the gate's read of one head, and a user-owned repository has no merge queue.
- **Requiring the `factory/*` checks in a ruleset.** Rejected for the reasons above.
- **Strict re-runs after every base update.** Rejected: with parallel slots each merge re-runs review, QA and security on every other ready pull request, though disjoint changes cannot change what those Stages judged. CI on the combined tree still guards the merge result.
- **Rulings holding a merge.** Rejected: the review Stage checks each Ruling ([ADR 0040](0040-in-factory-mode-the-chief-of-staff-never-waits-on-a-human.md)). The gate counts them in its comment, so the shadow record measures them.

## Consequences

- The README's "Nothing auto-merges" becomes "Nothing auto-merges outside the Factory's opt-in merge gate".
- A tier outside `auto_tiers`, a held QA item, a held security check, a Guarded path, or any fact the gate cannot read means a person merges. The gate then records `merged`.
