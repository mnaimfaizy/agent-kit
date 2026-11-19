---
status: proposed
---

# The deep scan is a `security-audit` mode, not its own skill

The **Deep scan** is a third mode of `security-audit`, `deep`, next to `full` and `pr`. It shares the **Threat pack**, the report format and **Private delivery** with them. Its sandbox procedure lives in its own file inside the skill (`DEEP.md`), read only in `deep` mode, so `full` and `pr` stay as lean as they are today. The "no Bash" restriction of today's audit belongs to the CI workflow, not to the skill, so adding a mode that runs code does not weaken `full`.

Recorded in [#336](https://github.com/mnaimfaizy/agent-kit/issues/336), on the wayfinder map [#332](https://github.com/mnaimfaizy/agent-kit/issues/332), and specified in [#362](https://github.com/mnaimfaizy/agent-kit/issues/362).

This departs on purpose from [ADR 0003](0003-qa-is-two-skills-joined-by-a-copied-plan-format.md), where QA became two skills joined by a copied format. There the composer and the runner are different people in different places, and each needs a skill they can install alone. Here what the modes share is the security hard rules themselves, and two copies of those would drift.

## Considered Options

- **A separate Portable skill with a copied report format**, as in ADR 0003. Rejected. Two copies of the security hard rules would drift.
- **Fold the sandbox procedure into `SKILL.md`.** Rejected. Every `full` and `pr` run would read sandbox instructions it never uses.

## Consequences

- **Consumers pass `mode: deep`.** Once they do, splitting the mode out into its own skill would be a breaking change for them.
- **Triage stays static.** `Reproduced` and the Observation are evidence that `security-finding-triage` reads. It alone decides confirmed, rejected, accepted-risk or duplicate, and it never needs a sandbox.
- **`deep` runs on trusted refs only**: the whole repository at the default branch, optionally narrowed by path or attack path, never a pull request head. `pr` stays static. A **Verification run** is the one exception: it runs locally, on a ref the maintainer chooses ([#358](https://github.com/mnaimfaizy/agent-kit/issues/358)). #358 puts that at the same trust as running the tests on it. So the ref is either the maintainer's own branch, or a branch on the advisory's private fork whose commits the maintainer has reviewed. The private fork is the only place someone else's commits may come from, and only after review, because it takes commits from every advisory collaborator, the reporter included. Any other pull request head from someone else, a public fork's included, is never run, reviewed or not ([#336](https://github.com/mnaimfaizy/agent-kit/issues/336)).
- **One concept-id space.** `deep` and static runs share concept ids and the findings ledger ([#357](https://github.com/mnaimfaizy/agent-kit/issues/357)).
