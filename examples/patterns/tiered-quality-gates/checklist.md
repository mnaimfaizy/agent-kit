<!--
Pattern guide skeleton: docs/patterns/tiered-quality-gates.md in Agent-kit.
Copy it next to your always-on agent instructions, fill in every <placeholder>,
and delete this comment. Your instructions tell the agent to read it before
its first edit.
-->

# Before your first edit: choose a gate tier

State the tier in your first reply, or follow the tier on the issue. The user can override it ("use the full gate"). When unsure, promote. Never demote.

| Tier         | Use when                                 | Who edits                         | Required gates                                                         |
| ------------ | ---------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| `mechanical` | Every mechanical criterion below is true | You, directly                     | `<runner command> mechanical <paths>`. A report of at most 5 bullets.  |
| `standard`   | One behaviour change on one surface      | One specialist for that file type | That specialist, then its reviewer **or** the runner, once.            |
| `full`       | Any of the `full` signals below          | The whole chain for each type     | Builder → Reviewer → Runner for each file type, and the review at end. |

## Mechanical: all four must be true

1. No new behaviour and no change to a public contract (an API, a schema, an exported type others build on).
2. The diff is small and in one place: at most `<2>` files, more only for a pure rename or delete.
3. Tests and assertions are unchanged, or only retargeted to a change that has already landed.
4. Deterministic checks alone can say whether it worked: a type check, a linter, a focused test run.

If any one is false, the tier is `standard` or `full`.

## Signals for `full`

- A new module, primitive or feature.
- `<Your high-risk areas: authentication, cryptography, payments, data migrations, ...>`
- A change to a public contract.
- Behaviour across several files.
- The behaviour the user wants is unclear.

## Red flags: promote, even if the change looks small

- A test assertion or a user flow changes.
- A new mock that encodes behaviour.
- A change to a component's props, state or interaction.
- Anything in the `full` signals above.

## By file type

| Files                     | `mechanical`                                  | `standard`                                | `full`                                            |
| ------------------------- | --------------------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| `<UI component paths>`    | Direct edit for a rename, import or dead code | `<builder>` → `<reviewer>`                | `<builder>` → `<reviewer>`, then tests after PASS |
| `<unit test paths>`       | Direct edit for a fixture or type retarget    | `<test writer>` → `<test reviewer>` → run | Same chain                                        |
| `<API contract paths>`    | Direct edit for a rename or comment           | One-shot `<contract writer>`, then leave  | One-shot hops in order, then leave                |
| `<end-to-end test paths>` | Direct edit for a selector string only        | `<test writer>` → `<test reviewer>`       | `<planner>` → `<test writer>` → `<test reviewer>` |
| Config, docs, types only  | Direct edit                                   | Direct edit                               | Direct edit                                       |

At every tier, `<runner command> <tier> <paths>` runs before you report. Its verdict, not yours, says whether the checks passed.

## Specialists

- A specialist writes, reports and stops. It does not run the next hop or start another specialist.
- A report is `PASS`, `FAIL` or `ESCALATE`, at most 5 bullets, and the exact commands it ran.
- A reviewer that returns `FAIL` sends the work back to its builder. After `<2>` reject cycles, stop: you fix it, and record an incident.

## Record an incident when

- The same `FAIL` reason comes back on two cycles in a row.
- A "fix" only hides the finding.
- A reviewer said `PASS` and the runner, the type check or the linter then failed.
- The retry cap was hit.
- A sibling file already solved the problem and the specialist did not look.

Post it under the heading `## Gate incident` on the issue, or in `<your incident log>` when there is no issue.
