---
# Pattern guide skeleton: docs/patterns/instruction-layout.md in Agent-kit.
# Copy this folder's SKILL.md into your skill tree, fill in every
# <placeholder>, and delete these comment lines.
name: <placing-instructions>
description: Use when adding, moving or changing an instruction for agents in this repository, a skill, or a reference document, or when <check command> fails. Decides which file the instruction belongs in, so that each fact is written once.
---

# Placing an instruction

## Where it goes

Pick the first row that fits. Write the instruction there, and nowhere else.

| The instruction                                                 | Goes in                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Is true for one harness only, such as a hook or a tool name     | That harness's adapter                                                               |
| Holds for every task, whichever skill runs                      | AGENTS.md                                                                            |
| Is true only inside one folder                                  | The AGENTS.md in that folder                                                         |
| Is a step of a named workflow                                   | That workflow's skill, under `<skill-tree>/`                                         |
| Says which skill to load when two could answer the same request | One line in the Skills section of AGENTS.md, naming the skill's path                 |
| Is needed only when something specific happens                  | A reference document, plus one line under Reference documents that names the trigger |
| Is the reason for a decision that is hard to reverse            | A decision record, linked from where the rule is written                             |

## Steps

1. Search for the fact first. If it is already written somewhere, change it there, and link to it from where you were going to write it.
2. Write it in the one place the table gives.
3. If you moved it, replace the old copy with a link, or delete it.
4. Run `<check command>`. A restated sentence, a chooser for a skill that does not exist, a reference without a trigger, or a skill folder that is not a link fails it.

## What does not go in AGENTS.md

- A skill's steps. AGENTS.md says which skill to load; the skill says how.
- A list that a file elsewhere already holds, such as the commands, the approved external skills or the labels. Link to the file.
- A rule that only one harness reads.
