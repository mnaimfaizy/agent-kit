---
status: accepted
---

# Orchestrate runs on a detected Harness with a Support Level

`orchestrate` names the **Harness** it runs on before it plans, and says how far that harness has been proven. At step 1, `config.mjs check` reports the harnesses the environment points to, and the Chief of Staff confirms one against the tools it has. An optional `harness` key in the config pins it; when the two disagree, the run asks. When the run cannot tell, it asks. A harness the skill has no file for runs on tier 3, one Delegation at a time, and is never given an invented Executor.

Each harness has its own file in the skill, `harnesses/<id>.md`, with its **Support Level**: `verified` (a full run passed), `tried` (a run happened, with gaps named) or `documented` (written from its documentation alone). The Dispatch Plan opens with the harness and its level. Below `verified`, it lists the harness's limits that bear on the run, and waits for the human's "go" even when the invocation carried `go`. A level rises only on a run's recorded evidence.

By default every Executor runs on the Chief of Staff's harness. An optional `executors` key moves one kind of Delegation (`build`, `analysis` or `qa`) onto another harness's headless run, for example a Cursor Chief of Staff that builds with `claude -p`.

Recorded in [#194](https://github.com/mnaimfaizy/agent-kit/issues/194), after the first Cursor run ([#189](https://github.com/mnaimfaizy/agent-kit/issues/189) to [#192](https://github.com/mnaimfaizy/agent-kit/issues/192)) and the harness research in [docs/research/](../research/).

## Considered Options

- **Declare the harness in the config only.** Rejected. One repository is opened in Claude Code one day and Cursor the next, so the value goes stale, and a stale value sends every Delegation down the wrong route with nothing to say so.
- **Detect the harness only.** Rejected. Environment variables leak into an editor's integrated terminal, and tool names change between versions; a wrong guess is the failure detection was meant to stop. Detection proposes; the session's own tools confirm it, and the config can pin it.
- **One HARNESSES.md for every harness.** Rejected once it grew past a few harnesses. Every run loaded every harness's facts, and the first Cursor run, finding none for its own, invented its Executors. Now a run loads the core and its own harness's file.
- **Treat every described harness as supported.** Rejected. The first Cursor run followed a description no run had tried, and broke in ways the description did not predict. A Support Level tells the human, before the "go", which kind of description the run rests on.
- **Executors on another harness by default** (Claude Code CLI for every building Delegation, wherever the Chief of Staff runs). Rejected. It needs a second CLI installed and signed in, and model names for a second harness. It stays an option a config asks for.

## Consequences

- **A new harness is a new file**, `harnesses/<id>.md`, with its Support Level, headless run, Executors, verbs, Limits and check-before-use items, plus a row in HARNESSES.md's table. `config.mjs` reads the ids and levels from those files, so `harness` and `executors` accept a new id without a code change.
- **Environment signatures live in `config.mjs`** (`HARNESS_ENV`), since a script reads them. A harness whose variables are not confirmed has none, and is found by its tool signature alone.
- **A Support Level change is a change to the skill**, citing the run whose Activity Log shows it. The close-out lists each check-before-use item a run settled, so those changes have their evidence.
- **Two new config keys.** An older copy of the skill reports `harness` and `executors` as unknown keys, as for any new key ([ADR 0004](0004-orchestrate-is-a-core-plus-a-config.md)).
