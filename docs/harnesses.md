# Harnesses and Support Levels

A **harness** is the agent that runs a Stage. A Stage chooses its harness with `AGENT_KIT_<STAGE>_HARNESS`, else `AGENT_KIT_HARNESS`, else `claude-code` ([the stage settings](getting-started.md#8-turn-the-flows-on-kill-switch-variables)). Claude Code is the only harness that runs a Stage so far.

## Support Levels

A **Support Level** belongs to a harness and Stage pair, never to a harness as a whole ([ADR 0028](adr/0028-a-security-stage-runs-only-on-a-harness-with-a-recorded-run.md)). The static security audit and the Deep scan are two Stages.

- `documented`: the harness's adapter is in the kit, and no run of this Stage on it is recorded. Every pair starts here.
- `tried`: one recorded run of this Stage on this harness through the Launcher, in the kit's repository, with a valid Stage result and every Guard probe passing. Any other gap is named.
- `verified`: a recorded run with no named gap. The Stage's whole outcome landed, and the wall clock and the token cap were seen to hold.

A pair whose Guard probe fails has no level, and is refused. A level changes only by a pull request that cites the run, and each level above `documented` links to it:

<!-- generated:support-levels -->

| Stage                 | Claude Code  |
| --------------------- | ------------ |
| Deep scan             | `documented` |
| static security audit | `documented` |
| review                | `documented` |
| plan                  | `documented` |
| implement             | `documented` |
| Review response       | `documented` |

<!-- /generated:support-levels -->

## What a level allows

- **The Deep scan** is refused on a pair below `tried`, before anything runs, unless the run is a Proving run. Every run prints the harness, its Support Level and whether it is a Proving run, and in GitHub Actions writes that line to the run summary. The [Deep scan workflow](security-audit.md#deep-scan-in-ci) never makes a Proving run, so while its pair is below `tried` its scan is refused.
- **The static security audit** is a security Stage too, but does not run through the Launcher yet. Until it does, it runs at any level, and its run summary names the level, with a warning at `documented`. The refusal starts when it moves to the Launcher.
- **Plan, implement, review and Review response** run at `documented`, with a warning in the run summary.

### Proving runs

A **Proving run** is how a pair below `tried` gets its first run of a security Stage: `agent-kit deep-scan --proving-run`. It relaxes only the Support Level rule; every other check and Guard holds. No reusable workflow takes it as an input, so no Caller can set it. On your own machine, the run on an unproven pair is at your own risk.

## Effort

A Stage's effort is written in its harness's own words and passed through as it is.

- A Stage's own effort (`AGENT_KIT_<STAGE>_EFFORT`, or `deep-scan --effort`) that the harness does not accept, or any effort on a harness with no effort setting, fails the run before the agent starts.
- An effort inherited from `AGENT_KIT_EFFORT` that the harness does not accept is dropped, with a line in the log, and the Stage runs on the model's own default. The reusable workflows tell the two apart by reading both variables: it is inherited when the Stage's own variable is unset and the `effort` input equals `AGENT_KIT_EFFORT`.

## harnesses.json

Each kit tag ships `cli/harnesses.json`, in the repository and in the npm package ([ADR 0030](adr/0030-harness-facts-are-published-per-tag-as-data.md)). Preflight and this page read it. It holds `stages` and, under `harnesses`, one entry per built-in harness:

| Field           | Holds                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `displayName`   | The harness's name as people read it.                                                                              |
| `secrets`       | The kit secrets it accepts, the preferred one first, each with its `name` and a `whereToGet` line.                 |
| `effortValues`  | The effort values it accepts; empty when it has no effort setting.                                                 |
| `noEffort`      | `true` when it has no effort setting.                                                                              |
| `defaultModel`  | The model a Stage gets when none is named.                                                                         |
| `supportLevels` | One cell per Stage: `level` (`documented`, `tried`, `verified`, or `null` for none) and the `run` link, or `null`. |

The file's shape is grow-only: a field may be added, and is never renamed or removed, because an older CLI reads a newer tag's file and a newer CLI an older one.

It is generated, never edited. In the kit's repository, change the adapter or the table in `cli/src/harness/`, then run both:

```bash
node scripts/gen_harnesses.mjs
uv run python scripts/gen_doc_blocks.py
```
