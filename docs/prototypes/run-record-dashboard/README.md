# PROTOTYPE, throwaway: Run Record dashboard

Throwaway branch for the wayfinder ticket "Dashboard designs for Run Records" (#394), on the map "Orchestrate Run Records and run observability" (#391). Never merged.

**Open `dashboard.html` by double-clicking it.** To rebuild it from `src/`:

```bash
node docs/prototypes/run-record-dashboard/build.mjs               # dashboard.html: Run Records only, safe to commit
node docs/prototypes/run-record-dashboard/build.mjs --local-logs  # dashboard.local.html: also inlines tmp/orchestrate/<run>/activity.md (gitignored)
```

## Round 2: one multi-page dashboard

Round 1 (commit 677d6d2) had four single-page variants. The maintainer found them too thin: colours that weren't explained, no way to drill down, no text log, and no view across repos. Round 2 is one dashboard with hash routes:

| Page | Route | Shows |
| --- | --- | --- |
| Overview | `#/` | Every Consumer repo: runs, merge rate, human steps per run, a sparkline of avoidable steps, top cause, recent runs |
| Repo | `#/repo/<owner/name>` | Human steps per run stacked by cause (oldest → newest), all causes, people, runs table, link to any Team Run |
| Run | `#/run/<id>/<tab>` | Tabs: **Summary** (KPIs, next run, why you were needed, plan, outcome), **Timeline** (Gantt on one clock), **Delegations**, **Human steps** (filterable), **Reviews & CI**, **Log**, **Record (JSON)** |
| Log tab | `#/run/<id>/log` | *Run Events as text* (derived from the record, copy or download), *Report* (`orchestrate --report` text), *Activity Log* (the local prose, only in a `--local-logs` build) |
| Delegation | `#/run/<id>/delegation/<d>` | Its facts, why it needed you, its own timeline, its steps, its log |
| Step | `#/run/<id>/step/<n>` | One human step in a sentence, its fields, the cause explained with its fix, the log around it, the raw entry |
| Team Run | `#/team/<id>` | Every teammate's record merged on one clock, plus a teammates table |
| Key | `#/key` | What every colour, cause, kind and timeline mark means |

## Data

- **Real:** the two Run Records hand-derived on `prototype/run-record-fields` (spec-344, spec-253).
- **Synthetic (`src/synth.js`, tagged on every page):** three `example-org/*` Consumers plus earlier agent-kit runs, 23 runs in all. One run is abandoned, and one is a three-teammate Team Run. The rates fall over time so the trends have something to show.
- **`cause` on the real records is assigned by the page** (`causeOf` in `src/app.js`), and marked "assigned by the prototype" wherever it shows.

## What building it showed about the record

1. **A `by-design` cause, or an equivalent flag,** is needed to split expected steps (plan approval, close-out) from avoidable ones.
2. **Delegations need `started_at` and `ended_at`, from Run Events.** In spec-344 the bars run from first commit to last commit, so every Delegation looks like 3 to 8 minutes.
3. **A record needs `run.repo` and `run.operator`, and a Team Run needs a shared `run.team_run` id,** for the multi-repo and Team Run pages. v0 has none of these.
4. **The `actor` rule works.** Writes the Chief of Staff makes after you answer show on its own lane and don't count. With this rule spec-344 has 17 human steps, not 23.
5. **A text log can be derived from the record alone** (time, who, Delegation, kind, cause, wait). The prose Activity Log stays local: a page generated on the machine can include it, but an uploaded record never carries it.
