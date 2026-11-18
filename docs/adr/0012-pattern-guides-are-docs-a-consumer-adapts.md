---
status: accepted
---

# Pattern guides are documentation a Consumer adapts, not skills the kit ships

Agent-kit takes some of its skills from MyOrganiser, the repository it was extracted from, and redesigns each one as a Portable skill ([ADR 0004](0004-orchestrate-is-a-core-plus-a-config.md)). Most of that repository's agent workflows are a different kind of thing. A commit pipeline or a pull request pipeline is a few small parts: a read-only drafting agent, a skill that routes between the agent and a script, and a runner script that does the write. Every part names that repository's own commands, hooks, labels and checks. Turning each one into a Portable skill with a config would need a config key for almost every line, and the config would end up longer than the parts it configures.

So the kit adds **Pattern guides**. A Pattern guide is a page under `docs/patterns/` and a skeleton under `examples/patterns/<pattern>/`. The page describes the problem, the moving parts, each rule and the failure it prevents, the failure modes, and how to adopt it. The skeleton holds a minimal agent body, a `SKILL.md` and a runner stub, with a placeholder wherever a repository has to supply a name. A developer reads the page, copies the skeleton into their own repository, fills in the placeholders and edits the result. From that point the copy is theirs.

This amends the boundary in the README's "What ships" section. It said the kit does not ship "product playbooks, Companion skills, subagent definitions". That still holds for anything the kit installs or upgrades. A skeleton's agent body is a subagent definition, but it ships only as an example to copy and edit, the same way a Caller template does.

## How a Pattern guide differs from a vendored skill

- **It is documentation plus examples.** A Portable skill is a folder a Consumer copies unchanged and an agent runs. A Pattern guide is a page a person reads, plus a skeleton they edit before anything runs it. A skeleton with its placeholders still in it is not meant to work.
- **It is not a Kit-owned path.** Nothing under `docs/patterns/` or `examples/patterns/` is in `kit-owned-paths.txt`. `agent-kit init` does not copy it, and `doctor` does not check it.
- **`upgrade` never overwrites it.** `upgrade` replaces only Kit-owned paths. Like the other files under `examples/`, a skeleton that changed between two tags shows up only in the `examples/` diff that `upgrade` prints for the Consumer to apply by hand. A Consumer's adapted copy lives at a path they chose, so the kit never writes it.

## How it relates to ADR 0004

ADR 0004's rule for an imported skill still applies to the page and the skeleton: they are redesigned from the source, not ported, and they name no host. A guide gives the reasons for its rules itself, and it links none of the source's ADRs, because a reader cannot open another repository's decision records. A placeholder is not a ported line with its names cut out. Each one marks a fact a repository has to supply, such as its hook command or its label allowlist, and the rule around it is written so that it holds for any value.

Where the two differ is what the Consumer does next. A Portable skill stays unedited so `upgrade` can replace it, so whatever a repository needs to change goes in a config the skill reads. A skeleton is meant to be edited, so it needs no config. Its placeholders do that job once, at copy time. If a pattern later becomes a Portable skill, that is a new decision, made under ADR 0004 as a core plus a config, and recorded in its own ADR.

## How it relates to ADR 0010

`docs/patterns/` and `examples/patterns/` are inside the gated docs in [ADR 0010](0010-doc-facts-are-generated-and-renames-are-registered.md): the Markdown under `docs/` and `examples/`, apart from `docs/adr/`, `docs/research/` and `docs/agents/`. So the Generated-block check reads them, and the Deprecation register test fails on an old name in them. Neither does anything today, because a Pattern guide describes a practice rather than kit code, so it holds no Doc fact. If a guide ever lists something whose source is kit code, that list goes in a Generated block, the same as on any other page. The Docs map gets a row for the guides, so a Docs-impact finding can point at them.

A contract test, `scripts/pattern-guides-contract.test.py`, checks what the boundary needs: every guide has its skeleton and the sections listed above, and no guide or skeleton names the source repository or its commands.

## Considered Options

- **A Portable skill with a config for each workflow, as orchestrate is.** Rejected for now. The parts are small, and almost every line in them is a repository fact, so the config would be the whole skill. It also implies the kit maintains each one for every Consumer's hooks, which it cannot test. A guide stays open to this later, one pattern at a time.
- **Link to the source repository's files.** Rejected. Those files name the source's commands and record its decisions. A reader would have to translate every line, and the files can change or move without notice.
- **Make the skeletons Kit-owned paths.** Rejected. A Kit-owned path is replaced whole on upgrade, which would wipe out the edits a skeleton exists to receive.
- **Pages only, with no skeletons.** Rejected. The rules in a pipeline sit in the runner, such as which hooks it runs and what it refuses, and prose alone reads like advice. A runner stub shows where each rule is enforced.

## Consequences

- **The kit can document a workflow without owning it.** The first two guides are the commit pipeline and the pull request pipeline. Later guides follow the same shape: a page, a skeleton, a Docs map row and a README link.
- **A skeleton can be wrong for a Consumer without being a kit bug.** The page says what each rule protects against, so an adopter can tell when a rule does not fit them. The kit fixes a guide when its reasoning is wrong, not when one repository's adaptation fails.
- **A skeleton change is not a breaking change.** Nothing a Consumer runs comes from the kit, so a changed skeleton is a docs entry in the CHANGELOG, never **Consumer action**.
- **Patterns that build on a Companion library are handled separately.** A guide for a planning chain built on Companion skills would describe how the kit's pieces fit around that library. It would not restate the library's skills.
