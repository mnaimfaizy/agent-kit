---
status: proposed
---

# A security Stage runs only on a harness with a recorded run of that Stage

A **Support Level** belongs to a harness and Stage pair, never to a harness as a whole. Static security audit and Deep scan count as two Stages. Codex CLI can be `verified` for the Deep scan and `documented` for implement at the same time.

The levels for built-in adapters live in one kit-owned table, harness by Stage. Each cell holds a level and a link to the run that earned it. Preflight reads the table and the docs render it. Every pair starts at `documented` when its adapter merges, and a level changes only by a pull request that cites the run.

What earns a level:

- **`tried`**: one recorded run of that Stage on that harness through the Launcher, in this repository, where the Stage result was valid and every Guard probe passed. Any other gap is named.
- **`verified`**: a recorded run with no named gap. The Stage's whole outcome landed (report, comment, draft pull request or thread replies), and the wall clock and the token cap were seen to hold.

A Guard is never a known gap. A pair whose Guard probe fails has no level and is refused.

What a level gates, the same for a built-in adapter and a Custom harness:

- Static security audit and Deep scan are refused on a pair below `tried`.
- Every other Stage runs at `documented`, with a warning in the run summary.

A **Proving run** is how a pair below `tried` gets its first run of a security Stage. It is a Launcher flag that no reusable workflow exposes as a Caller input. This repository's dogfood workflows set it, and so can anyone running `agent-kit deep-scan` locally. The run summary marks the run as a Proving run. So a released kit never offers a security Stage on a pair below `tried` through a Caller.

A Custom harness ([ADR 0027](0027-a-harness-adapter-returns-a-launch-plan-as-data.md)) records its levels in its own file: a level per Stage with the URL of the run. This is the Consumer's attestation. Doctor checks its shape, preflight reads it, and the run summary shows "custom, attested". The Consumer makes the Proving run themselves, with the flag set in their own workflow step or local CLI.

A level belongs to the adapter at its pinned CLI version. A pin bump keeps the level only if the contract tests pass on the new pin; a failing test blocks the bump and does not lower the level. A regression found after a release lowers the level by pull request. Cursor CLI cannot be pinned, so it is capped at `tried`.

`anthropics/claude-code-action` leaves a Stage ([ADR 0024](0024-every-stage-runs-through-agent-kits-launcher.md)) in the first kit release after the Claude Code adapter is `verified` on that Stage. For this one adapter `verified` needs three consecutive passing dogfood runs, because it replaces the default path. The action is removed in the same release, with no fallback input. A Consumer who wants the old path stays on the previous kit tag.

Decided in [Rollout order and starting Support Levels](https://github.com/mnaimfaizy/agent-kit/issues/448), on the map [Wayfinder: Stages run on a Consumer-chosen harness](https://github.com/mnaimfaizy/agent-kit/issues/438). The rollout order itself is in that ticket and is not part of this decision.

## Considered Options

- **One level per harness.** Rejected. One good Deep scan run would vouch for a Stage that pushes code.
- **One level per flow.** Rejected. The Agent flow's three Stages differ too much in what they write.
- **Built-in adapters run security Stages at `documented`**, because the kit wrote them. Rejected. The level would be informational only, and the Guards would never have been probed on that pair.
- **Never unlock security Stages for a Custom harness.** Rejected. It is safer, but it makes `custom:` useless for the audit. The kit cannot see a Consumer's runs, so the record is the Consumer's claim and is labelled as one.
- **A failing contract test lowers the level.** Rejected. The pin would move to a version nothing has proven. Blocking the bump keeps the proven version in use.
- **A one-release fallback to `claude-code-action`.** Rejected. It means two code paths and a setting to retire, and the kit tag already lets a Consumer stay behind ([ADR 0022](0022-stage-settings-are-named-for-the-kit-not-the-harness.md) made the same cut).
- **Cursor CLI may reach `verified`.** Rejected. A `verified` run on a CLI that updates itself says nothing about the next run.

## Consequences

- The Proving run flag is visible in the CLI's help. A local Deep scan on an unproven pair is the operator's own risk.
- The kit cannot check a Custom harness attestation. A Consumer can write `tried` with any URL.
- This repository needs an OpenAI and a Gemini API key as secrets before the first non-Claude dogfood run.
- The contract tests now gate every pin bump, so what they prove per adapter has to be settled before the first bump.
