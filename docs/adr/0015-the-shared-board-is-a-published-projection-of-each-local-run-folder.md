---
status: accepted
---

# The Shared Board is a published projection of each teammate's local run folder

In a **Team Run**, each teammate's Chief of Staff keeps its own gitignored run folder exactly as a single-person run does: the board, both kinds of Activity Log, briefs, reports, Decision Requests, the Ruling Ledger, evidence and QA files. The **Shared Board** on the tracker is a projection of that folder's board, never a replacement for it. A row carries the ticket, its assignee and state, the branch and pull request, what it is parked on, open Decision Request headings, a count of Rulings awaiting review, a short Recent activity list, and its age since its last change. Every free-text piece of a row is written for publication, never copied from a brief, log or evidence file. So a public and a private repository get the same content.

Recorded in [#306](https://github.com/mnaimfaizy/agent-kit/issues/306), with [#310](https://github.com/mnaimfaizy/agent-kit/issues/310) and [#312](https://github.com/mnaimfaizy/agent-kit/issues/312), on the wayfinder map [#302](https://github.com/mnaimfaizy/agent-kit/issues/302).

The run folder is gitignored because briefs and logs quote issue text and command output the human has not chosen to publish ([DESIGN.md](../../.claude/skills/orchestrate/DESIGN.md#the-run-folder)). On a public repository a Shared Board is the open web. A shared store would publish exactly what the run folder keeps back, so the tracker gets a projection, and the run's state stays where `--resume` and verification already read it.

## Considered Options

- **Move the run folder to the tracker** (or to a committed folder) so teammates share one store. Rejected. It publishes briefs, logs and evidence, and it makes `--resume` depend on the network and on other people's edits.
- **Publish the full Activity Logs, or a comment per event.** Rejected. The logs quote command output. A comment per event notifies every watcher at every step.
- **A reduced row for public repositories.** Rejected. A second content mode is a second thing to drift. Privacy beyond the row's rules is a private repository.

## Consequences

- **A lost machine cannot be rebuilt from the Shared Board.** It holds no briefs, logs or ledger. The teammate starts a new Team Run: it takes the old run's rows over, restarts unfinished tickets from their branch heads, and treats every unreviewed Ruling line as an open question again.
- **Rulings are reviewed only by the teammate whose Chief of Staff made them,** because the ledger and its evidence never leave their machine. The row shows only a count awaiting review.
- **Writing the row and its state labels is one routine write,** approved at "go", for the teammate's own tickets only. The Dispatch Plan says when the repository is public.
- **Nothing claims a teammate's run is alive or dead.** Rows are written on change only, and show their age since the last change.
