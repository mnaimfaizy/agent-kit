---
status: accepted
---

# A Team Run's Shared Board is one single-writer row per ticket

In a **Team Run** of `orchestrate --spec`, several teammates each run their own Chief of Staff over the spec's tickets assigned to them, and every one of them reads one **Shared Board** on the issue tracker. The Shared Board is not one document. Each spec ticket carries one row comment, and only the Chief of Staff of that ticket's current assignee writes it, with a small set of coarse state labels mirroring the row's state. The whole board is assembled by reading the spec's tickets. Neither GitHub nor GitLab offers optimistic locking on any write a board would use: the last write wins, with no error to the loser. So the board is cut so that no two teammates ever write the same value. The tracker's assignee is the only ownership signal, read fresh before every write.

Recorded in [#305](https://github.com/mnaimfaizy/agent-kit/issues/305) and [#307](https://github.com/mnaimfaizy/agent-kit/issues/307), on the wayfinder map [#302](https://github.com/mnaimfaizy/agent-kit/issues/302), from the research in [#303](https://github.com/mnaimfaizy/agent-kit/issues/303) (GitHub) and [#304](https://github.com/mnaimfaizy/agent-kit/issues/304) (GitLab).

## Considered Options

- **The whole board in the spec issue's body, or in one pinned comment.** Rejected. Every write replaces the whole board, so two teammates writing within one read-write window lose each other's rows, silently. It is the lost write `RUN.md` already guards `--status` against, across machines.
- **One comment per teammate on the spec issue.** Rejected. It has one writer per comment, but a reassignment moves a row from one teammate's comment to another's, and only one comment can be pinned, so the rest scroll away.
- **A GitHub Projects (v2) board as the record.** Rejected as the record, kept as a possible view. It needs the `project` token scope and project access granted apart from the repository role, and it has no GitLab Free equivalent.
- **A rendered whole-board summary on the spec issue, rebuilt from the rows.** Rejected. It brings back a shared whole-board write.

## Consequences

- **Free tiers are the floor.** A row comment needs only the right to comment, and plain labels work on GitHub Free and GitLab Free. Premium features (blocking links, scoped labels, Status, custom fields, Projects) are never required.
- **A reassignment is a hand-off, not an edit.** The new owner usually cannot edit the old owner's comment, so it writes a new row comment. Readers take the comment written by the current assignee. The old one ends with a "handed off" line.
- **A run-id marker in each row** is the only guard left: it stops two sessions of the same teammate from overwriting each other.
- **The full row lives on each ticket.** The at-a-glance view is the spec's sub-issue list (assignee and state label), plus `--status`.
- **The core names tracker operations, not commands.** Each tracker's mapping is its own file under `trackers/`, as harnesses are ([ADR 0006](0006-orchestrate-runs-on-a-detected-harness.md)).
