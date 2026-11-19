# Security finding triage — outcome format

Emit **markdown only**, starting with exactly:

```markdown
## Security finding triage
```

Then:

```markdown
- **Concept id:** `<kebab-case>`
- **Finding:** F<n> — <short title> (or ledger title)
- **Advisory:** GHSA-… (or `n/a`)
- **Outcome:** confirmed | rejected | accepted-risk | duplicate
- **Severity (after triage):** none | medium | high | critical
- **Bucket:** shipped-product | ci-maintainer | duplicate
- **Date:** <YYYY-MM-DD>
```

### Evidence

- What was checked (`path:line`) and whether claim still holds
- Who can trigger it / preconditions (narrative only)
- For a finding from a deep scan: its `Reproduced` value and, with `yes`, its Observation, weighed as evidence. `yes` shows the path was triggered in a running copy of the code. `no` and `not attempted` are weak evidence that the bug is absent, so check the code path as for any static finding. Quote an Observation only in prose: never add a payload or a step to it.

### Decision

Why this outcome. For `rejected` or `accepted-risk`, state what would reopen it.

### Fix direction (confirmed only)

Concrete remediation direction (not a full patch unless trivial).

### Agent brief (optional, confirmed only)

- Goal
- Likely files
- Acceptance checks
- Out of scope

### Ledger update

- Previous evidence/status -> new evidence/status
- Confirm row update (or say blocked)

### Notes

- Related concepts / duplicates
- Maintainer follow-ups
