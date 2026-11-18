---
# Pattern guide skeleton: docs/patterns/sub-agent-sync.md in Agent-kit.
# Copy this folder's SKILL.md into your skills directory, fill in every
# <placeholder>, and delete these comment lines.
name: <sub-agent-sync>
description: Use when adding, removing, renaming or editing a sub-agent, changing an agent's model or tools, or when <generator command> --check reports drift. Edits only the canonical body in <canonical agents folder> or the pin in <path to agent-models.json>, then regenerates every harness's copy.
---

# Sub-agent sync

## Where each fact lives

| Fact                              | Lives in                                                 | Never in             |
| --------------------------------- | -------------------------------------------------------- | -------------------- |
| An agent's body, name, purpose    | `<canonical agents folder>/<agent>.agent.md`             | a harness's copy     |
| What it may do (`tools:` roles)   | the canonical body, as roles                             | a copy's tool list   |
| A part meant for one harness only | the canonical body, inside a `<!-- harness:... -->` mark | a copy               |
| Which model it runs on, per tool  | `<path to agent-models.json>`                            | a copy's `model:`    |
| How a role or pin is written      | `<path to sync-agents-core.mjs>` (`HARNESSES`)           | a hand-written patch |

## Rules

- Edit the canonical body or the model policy, never a generated copy. The next `--apply` overwrites a copy, and the edit is gone without a warning.
- To add an agent, add its canonical file **and** a pin for every harness in the policy, in the same change. A missing pin stops the generator.
- To delete an agent, delete its canonical file and its pins. `--apply` removes the copies.
- A change that widens a grant (adds `edit`, `execute` or `web`) says so in the commit message.
- Do not change a pin to make the audit pass without checking the new name in the harness's own docs.

## Steps

1. Make the change in the canonical body or the policy.
2. Run `<generator command> --apply`.
3. Run `<generator command> --check`. It must say `IN SYNC`.
4. Read the diff of the copies. Each one should differ from before only by the change you made.
5. Commit the canonical file, the policy and every copy together.
