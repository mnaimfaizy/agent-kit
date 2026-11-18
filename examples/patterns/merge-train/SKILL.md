---
# Pattern guide skeleton: docs/patterns/merge-train.md in Agent-kit.
# Copy this folder's SKILL.md into your skills directory, fill in every
# <placeholder>, and delete these comment lines.
name: <merge-train>
description: Use when the user asks to merge a batch of pull requests, or asks in what order to merge them. Has <merge-order> propose the order, then hands the user the one <train command> to run. Never merges with --admin and never merges a pull request outside the train.
---

# Merge a batch through the train

## Who does what

| Step                                                 | Owner                             |
| ---------------------------------------------------- | --------------------------------- |
| Propose the order and the command                    | `<merge-order>` agent (read-only) |
| Show the order and the command to the user           | You                               |
| Run the train                                        | The user, or you when they say so |
| Update, wait, merge, stop                            | `<train command>`                 |
| Decide whether a candidate may auto-merge (optional) | `<train command> --auto`          |

## Rules

- Never run `gh pr merge` yourself, and never pass `--admin`. The only way a batch merges is `<train command>`.
- Never run the train without the user's go-ahead for that batch. A merge cannot be taken back; a revert is a new change on the base branch.
- Do not apply any merge rule yourself: do not skip a pull request because its review "looks fine" or hold one because it "looks risky". Pass the order; the train reads its facts for each head.
- When the train stops, report the reason and the pull requests it never reached, exactly as it printed them. Do not rerun it past the stop until the cause is fixed.
- A pull request the train stopped on for a conflict is rebased by its author or by you on the user's say, then the train is run again **from that pull request**.
- `--auto` runs in the mode the base branch's `<path to your auto-merge mode file>` sets. Never edit that file to change what one pass does; a mode change is its own pull request.

## Steps

1. Call `<merge-order>` with the pull request numbers. Do not give it an order.
2. Show the user the `ORDER:`, the `LEFT OUT:` line with its reasons, and the `COMMAND:`.
3. When the user says to go, run the command and wait for it to finish. Do not background it or cancel it.
4. Report what merged, where it stopped and why, and what it never reached.
