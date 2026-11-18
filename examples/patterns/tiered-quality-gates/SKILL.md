---
# Pattern guide skeleton: docs/patterns/tiered-quality-gates.md in Agent-kit.
# Copy this folder's SKILL.md into your skills directory, fill in every
# <placeholder>, and delete these comment lines.
name: <quality-gates>
description: Use before the first edit of any change to code or tests. Chooses a gate tier from <path to checklist.md>, then edits directly (mechanical) or routes through the Builder → Reviewer → Runner chain for each file type (standard, full), with a retry cap of <2> reject cycles.
---

# Quality gates

## Who does what

| Step                                         | Owner                              |
| -------------------------------------------- | ---------------------------------- |
| Choose and state the tier                    | You, from `<path to checklist.md>` |
| A mechanical edit                            | You                                |
| A standard or full edit                      | The builder for that file type     |
| Judge the change                             | Its reviewer (read-only)           |
| Run the deterministic checks                 | `<runner command>`                 |
| Fix after the retry cap, record the incident | You                                |

## Rules

- State the tier in your first reply, with the one criterion that decided it. When unsure, promote.
- The tier sets how deep the chain goes. It does not choose the model; each agent's own definition does.
- On `standard` and `full`, do not edit files of a type that has a builder. Delegate first. Editing them yourself skips the reviewer.
- Call one specialist at a time. Each one writes, reports and stops; you decide the next hop.
- A reviewer's `FAIL` goes back to its builder with the findings. Count reject cycles per builder. After `<2>`, stop calling the builder: fix it yourself, run the runner, and record an incident.
- Record an incident also when the same finding repeats, when a "fix" only hides a finding, or when a reviewer's `PASS` is followed by a runner `FAIL`.
- `<runner command>` runs before you report, at every tier. Report its verdict line, not your reading of the output.

## Steps

1. Read `<path to checklist.md>`. Choose the tier and state it.
2. **Mechanical:** edit, then run `<runner command> mechanical <paths>`. Report in at most 5 bullets.
3. **Standard:** for the one file type that changes, call its builder with a spec, then its reviewer with the builder's report. If the reviewer says `FAIL`, go back to the builder, up to the cap.
4. **Full:** do step 3 for each file type that changes, one after another, then run `<runner command> full <all changed paths>`, then `<your end-of-change review>` once.
5. Report the tier, each specialist's verdict line, the runner's verdict line, and any incident you recorded.

## Incident

```markdown
## Gate incident

- Tier: <tier>
- Specialist: <name>, cycle <n> of <cap>
- Trigger: <repeat FAIL | hidden finding | PASS then runner FAIL | cap hit | sibling ignored>
- What failed: <the finding or the check, with the command>
- What fixed it: <what you changed>
```

Post it on the issue, or append it to `<your incident log>` when there is none.
