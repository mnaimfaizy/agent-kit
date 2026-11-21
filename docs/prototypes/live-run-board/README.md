# PROTOTYPE, throwaway: live run board

Throwaway branch for the wayfinder ticket "Live run board a human can watch in the browser" (#407), on the map "Orchestrate Run Records and run observability" (#391). Never merged.

```bash
python3 -m http.server 47219 --bind 127.0.0.1 --directory docs/prototypes/live-run-board
```

Then open <http://127.0.0.1:47219/board.html>. Use `?variant=A|B|C|D|delivery`, the floating bar, or the ← → keys to switch.

The yellow **REPLAY** bar is only part of the prototype. It replays the real spec-344 run (2026-11-19, 3 h 32 m) as if it were live, at 10×, 60× or 240×. Use **next wait ⏭** to jump to the next point where the run waits on you.

| Key | Variant | Primary affordance |
| --- | --- | --- |
| A | Kanban | Delegation cards slide between Planned, Needs you, Running, Checking, Landed and Merged; run-level waits sit in Needs you |
| B | Needs you | An inbox first: one headline, each wait with its cause, age and where to answer, "since you last looked", Delegations as a strip |
| C | Timeline | One lane per Delegation plus a **You** lane on one clock with a moving now line; waits are coloured by cause, as in the dashboard's Timeline |
| D | board.md, live | The board.md table with a cell that flashes when it changes, plus `tail -f events.jsonl` |
| delivery | Delivery sketch | The Chief of Staff's "go" and "go autonomous" replies with the link, and three delivery options: a generated file in the run folder, a local server, or hosted |

The tab title and favicon show how many things wait on you. A toast stands in for the browser notification option 2 would send.

## Data

- `replay-spec-344.js`: the spec-344 run as Run Events, with ids, kinds, causes and states only. Times come from the hand-derived Run Record on `prototype/run-record-fields`. Times the record only bounds are placed inside those bounds and marked `est: true`.
- `shared.css` is copied unchanged from `prototype/run-record-dashboard`. Cause colours and meanings match the past-runs dashboard, so colour always means `cause`, and states are grey.

## What building it showed

See the delivery page's "What the prototype found": a card start has no board state, waits need open and close events, many waits are run-level, each wait needs a `how`, and a file page must show when it is stale.
