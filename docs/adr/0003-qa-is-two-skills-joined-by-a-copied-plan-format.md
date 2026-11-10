---
status: accepted
---

# QA is two skills joined by a copied plan format

Agent-kit ships manual QA as two User-scope Portable skills: `qa-plan` writes a **QA Plan** for an open pull request, and `manual-qa` runs one and returns a **QA Report**. They share no code at run time. The plan file is their only interface. Its format (`ANATOMY.md`) and the config reader (`adapter.mjs`) are owned by `qa-plan`, and `manual-qa` carries byte-identical copies. A contract test fails when either pair differs.

This departs on purpose from the design it comes from. MyOrganiser's `qa-plan` skill (its ADR 0048) keeps composing and running in one skill, so their shared rules cannot drift apart. That fits a developer who runs their own QA. Here the developer and the tester are different people in different places: the developer composes against their checkout and posts the plan where the team shares work, and a remote QA team, or an agent acting as a tester, runs it, perhaps with no repository checked out. Each needs a skill they can install alone, and a plan they can trust without the other's context. Two skills make that possible. The identical-copy test stops the drift one skill used to prevent.

## Considered Options

- **One skill with compose and run modes.** Rejected. The tester would install the composer's rules, config and tools to run a file, and both halves would have to change together on every release. It also blurs who is allowed to do what: a run that can also re-compose can re-judge the Residue it was given.
- **A third shared folder** that both skills import the format and reader from. Rejected. A Portable skill must carry everything it uses (ADR 0002, and the skill-portability contract test). A Skill installer who installs `manual-qa` alone would get a skill that cannot start.
- **Loose plan parsing**, where `manual-qa` accepts anything that looks like a plan. Rejected. A runner that guesses at missing sections runs plans their composer never meant, and nothing would catch the drift between the two skills. A plan is validated against `ANATOMY.md` before it runs.

## Consequences

- **A change to the plan format or the config reader is made in `qa-plan` and copied into `manual-qa` in the same change.** CI fails until both copies match.
- **The format is versioned in the plan itself** (`<!-- qa-plan format=1 … -->` on its first line). An incompatible change raises the number, and is a Major change to both skills.
- **One config file, two sections.** `qa.config.{yml,yaml,json}` at the repository root carries `plan:` for `qa-plan` and `run:` for `manual-qa`. Each skill checks its own section and accepts the other's as it is.
- **No credentials travel with a plan.** A plan is copied into trackers and other teams' tools, so it names roles and where their values come from, never the values.
