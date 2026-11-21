# PROTOTYPE, throwaway: Run Record dashboard designs

Throwaway branch for the wayfinder ticket "Dashboard designs for Run Records" (#394), on the map "Orchestrate Run Records and run observability" (#391). Never merged.

**Open `dashboard.html` by double-clicking it.** To rebuild it from the records: `node docs/prototypes/run-record-dashboard/build.mjs`.

Flip between designs with the floating bar or the ← → keys (`?variant=A..D`). Use the buttons at the top for the views: **This run**, **Across runs**, **Team Run**.

| Variant | Design | Leads with |
| --- | --- | --- |
| A | Swimlanes | A Gantt on one clock: a Human lane, a Chief of Staff lane (writes with their `actor`, review rounds, CI), one lane per Delegation |
| B | Human-step ledger | The number of times you were needed, every touch in order coloured by `cause`, a kind × cause table, and "fix these next run" |
| C | Run story | One readable feed, top to bottom, with the Delegations' times in a side rail and a retro at the end |
| D | Terminal report | No page: what `orchestrate --report` would print at close-out (ASCII Gantt, steps by cause, next run) |

## Data

- **Real:** the two Run Records hand-derived on `prototype/run-record-fields` (spec-344, spec-253), read from `../run-record-fields/records/`.
- **Synthetic (marked on the page):** two later solo runs, so the across-runs view has a trend, and one Team Run with three teammates. There is no real sample of either yet.
- **`cause` is assigned by this page** (`causeOf` in `template.html`). The v0 records were derived before the `cause` field was decided.

## What building it showed about the record

1. **Splitting avoidable from expected steps needs a `by-design` cause, or an equivalent flag.** Plan approval and close-out are not problems, but without that cause they inflate the "fix next run" count.
2. **Delegations need `started_at` and `ended_at` from Run Events.** In spec-344 a bar runs from the first commit to the last commit, so every Delegation looks like it took 3 to 8 minutes. The real time is unknown.
3. **A Team Run needs a `run.operator` (a handle per teammate) and a shared team-run id** to merge records on one clock. v0 has neither.
4. **The `actor` rule works.** Writes the Chief of Staff made after a human answer show on its own lane, and they don't count as human touches. With this rule spec-344 has 17 touches, not 23.
5. **Times known only as bounds, or only as dates, need their own marks** (dashed ranges, and a "date only" gutter). Otherwise the old runs show false precision.
