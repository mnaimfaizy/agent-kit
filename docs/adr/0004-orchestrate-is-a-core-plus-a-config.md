---
status: accepted
---

# Orchestrate is a core plus a config, designed apart from the skill it comes from

Agent-kit ships `orchestrate` as one User-scope Portable skill made of two parts. The **core** is the skill folder: the roles (Chief of Staff, Delegation, Executor), the Dispatch Plan, the board, the Brief Contract, the loop, and the authority limits. It names no repository command, skill, label or path. The **config** is a file the repository owns, `orchestrate.config.{yml,yaml,json}` at its root. It names the repository's routes: what a Delegation reads first, how it commits and opens a pull request, which commands re-gate a branch, which model each kind of work gets, the limits, where decisions are recorded, and what Ready to Merge requires. The skill reads it through a validating reader it ships (`config.mjs`), and an unknown key or a wrong shape stops the run with its line named. With no config file, the skill asks for what it needs.

The kit's skill is designed on its own terms, not ported. It comes from MyOrganiser's `orchestrate` skill, which names that repository's commands, skills, labels and ADRs throughout. A Portable skill must name no host, so a copy would need every line rewritten, and the reasons it carries live in ADRs of a repository a Skill installer cannot read. The kit's skill restates the reasons that still apply in its own `DESIGN.md`, and links to none of the source's. MyOrganiser keeps its own skill, as it did when `qa-plan` was designed apart from its source ([ADR 0003](0003-qa-is-two-skills-joined-by-a-copied-plan-format.md)).

## Considered Options

- **Port the source skill and replace its names with placeholders.** Rejected. The source's rules are bound to its repository's routes in the same sentences, so placeholders would leave rules that read wrong anywhere else, and every later change to the source would have to be re-ported by hand.
- **Prose settings in a Markdown file the skill reads** (as `explainer` does). Rejected. A run hands the routes to several Executors at once, and a misread route is repeated by all of them. A config that a reader checks before the run starts fails once, with its line, instead.
- **Make the kit's plan, implement and review flow the Executor.** Rejected for version one. That flow is label-driven and runs in CI, so the Chief of Staff could not message it or read its log while it works. It may become an Executor later.

## Consequences

- **A repository adopts the skill by writing a config, not by editing the skill.** The folder stays a Kit-owned path a Consumer replaces whole on upgrade, and the config survives.
- **A new config key is a change to `config.mjs`, its suite and `CONFIG.md` together.** A key the reader does not know is a problem in every older copy of the skill, so a config written for a newer version fails loudly on an older one instead of being half read.
- **Spec mode, a documentation page and an example config come in later changes**, each adding to this core and config rather than changing their shape.
- **Harness facts are dated.** The skill body speaks of four verbs only; a reference file in the skill says how each works on each harness, read on a known date, with every unconfirmed item marked "check before use".
- **The QA stage names the kit's own QA skills.** Added with [#179](https://github.com/mnaimfaizy/agent-kit/issues/179). The core dispatches `qa-plan` and `manual-qa` by name, rather than reading them from `skills`, because it verifies what they produce: the QA Plan's marker and Head, and the posted `<!-- qa-report -->` comment. A different skill would produce something the core cannot check. They are Portable skills of the same Release line, joined to the core by a format it reads, not repository skills, so naming them does not break the rule above. Companion skills (`implement`, `triage`, `review`) stay in the config.
