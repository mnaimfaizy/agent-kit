---
# Pattern guide skeleton: docs/patterns/external-skills-registry.md in Agent-kit.
# Copy this folder's SKILL.md into your skills directory, fill in every
# <placeholder>, and delete these comment lines.
name: <external-skills>
description: Use when asked to add, refresh, change or remove a skill written outside this repository, or when <check command> fails. Installs only through <installer>, at project scope, and keeps <path to approved-external-skills.md> and <path to skills-lock.json> in step.
---

# External skills

## Who does what

| Step                                | Owner                                                  |
| ----------------------------------- | ------------------------------------------------------ |
| Decide a skill is approved          | A person. You propose; you do not approve.             |
| Install, refresh or remove it       | `<installer>`, at project scope. Never by hand.        |
| Record the approval and its trigger | You, in `<path to approved-external-skills.md>`        |
| Hold the list and the lock in step  | `<check command>`                                      |
| Read the upstream diff              | The person reviewing the pull request, and you, first. |

## Rules

- Never edit a folder the lock file names. The next refresh overwrites the edit without a warning. To change how the skill behaves here, put the rule in your always-on instructions (when it holds whatever skill runs) or in your own skill (when only one workflow needs it).
- Never copy a skill's folder in by hand. A copy has no lock entry, so no refresh reaches it and nothing records where it came from.
- Never install at personal scope as the approval. Nothing in a fresh clone or in CI can reach it.
- Never list approved skills anywhere else. Link to `<path to approved-external-skills.md>`.

## Steps

**Add:** confirm a person approved it, run `<installer command to add one skill at project scope>`, add its entry with its trigger under the approved heading, run `<check command>`, and commit the skill folder, the lock file and the list together.

**Refresh:** run `<installer command to update project-scope skills>`, read the diff of each skill folder, run `<check command>`, and commit. Say in the commit message what changed upstream that an agent here will now do differently.

**Remove:** uninstall it with `<installer>`, move its entry to the excluded section with the reason, run `<check command>`, and search your own skills for a route to it by name.
