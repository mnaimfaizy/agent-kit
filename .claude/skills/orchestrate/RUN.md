# The run folder

Where a run keeps its state, so that `--status` can print it and `--resume` can continue it. Load it before opening, updating or resuming a run.

## Layout

A run lives in its own folder inside the config's `run_dir`, which is gitignored:

```text
<run_dir>/<run>/
  board.md                  the board: one row per Delegation
  activity.md               the Chief of Staff's Activity Log
  answers.json              the answers given in chat, when the config did not say
  delegations/<id>/
    brief.md                the brief, as spawned
    activity.md             the Delegation's Activity Log
    report.md               its latest report
```

`<run>` is the date and the issue numbers, `2026-11-13-12-34`, with `-2`, `-3` added when that folder is already there. A Delegation's `<id>` is `d<issue>`, `d12`; a second Delegation for the same issue adds `-2`.

Nothing in a run folder is committed. A brief or a log can quote issue text and command output the human has not chosen to publish.

## Board

```markdown
# Run <run>

Started <date>. Plan approved <date>. Approved routine writes: <list, or none>.

| Delegation | Issue | Kind     | Executor     | Handle   | Model | Wave | Branch | Pull request | State   | Decision Requests |
| ---------- | ----- | -------- | ------------ | -------- | ----- | ---- | ------ | ------------ | ------- | ----------------- |
| d12        | #12   | building | Live Session | <handle> | <m>   | 1    | <b>    | <URL>        | running | none              |

## Not delegated

- #34: `ready-for-human`, listed for the human.
```

The **Handle** is what `message` and `await` need to reach the Executor again: a session id, a process id with its output file, or a Sub-agent's name ([HARNESSES.md](HARNESSES.md)). The board is rewritten whole on each change, never edited in part, so an interrupted write leaves the last whole board in place: write the new board beside the old one, then rename it over the old one.

## States

| State            | Means                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `planned`        | In the approved plan; not started.                                                                        |
| `parked`         | Waits for another Delegation's branch to be merged (an overlap or a blocker), then starts from the merge. |
| `running`        | Spawned, and working.                                                                                     |
| `waiting`        | Stopped on an open Decision Request.                                                                      |
| `reported`       | Has written a report; not verified yet.                                                                   |
| `sent back`      | Its report did not hold; the Delegation has been told what was found.                                     |
| `stalled`        | Nudged once, still stuck, and raised to the human.                                                        |
| `crashed`        | Its Executor ended without a report; its branch and worktree are kept as the handoff.                     |
| `analysed`       | An analysis Delegation whose evidence and options are verified and relayed.                               |
| `ready to merge` | Ready to Merge: CI green, review settled, QA requirement met, merges cleanly.                             |
| `merged`         | The human has merged it.                                                                                  |
| `dropped`        | Taken out of the run on the human's yes.                                                                  |

## Activity Logs

Each Activity Log is append-only Markdown, one entry per thing done, newest last: the time, what was done, and why. The Chief of Staff's log records each plan, spawn, relayed Decision Request and its answer, verification result and write made in the human's name. A Delegation's log records its phases, its stop points and the commands it ran. Neither is ever rewritten: when a log is wrong, a later entry says so.

## Resume

`--resume <run>` continues a run from its folder, after a usage limit, a closed laptop or a pause for merges.

1. Read the config again (`check`, with the run's `answers.json` when there is one). A config that changed since the run started is said, and its new values apply from here.
2. Read the board and both kinds of Activity Log.
3. Check each Delegation not `merged` or `dropped` against the source, not the board: its branch and head, its pull request and whether it is merged, CI on its head, and whether its Executor still answers its handle. A board written before an interruption can be out of date.
4. Update the board to what was found, and log each change.
5. Start each `parked` Delegation whose wait is over, from the default branch as it now is. Continue the loop from SKILL.md step 6.

A Delegation whose Executor no longer answers, and whose work did not finish, is `crashed`: its branch is the handoff, and the human decides whether a new Delegation picks it up.

## Status

`--status [<run>]` prints the board of the run named, or of the newest run folder in `run_dir`, with each open Decision Request in full. It reads nothing else and changes nothing.

## Run Summary

After the human has merged, the Chief of Staff may offer a Run Summary on the umbrella issue the run's issues share, if they share one. It lists each Delegation with its pull request, each decision the human made and where it was recorded, what was not delegated, and anything left open. Posting it is a write as the human: it is drafted, shown, and posted only on a yes.
