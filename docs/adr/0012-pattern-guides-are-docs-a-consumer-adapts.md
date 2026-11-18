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

A pattern with no agent in it has no agent body in its skeleton. The registry of external skills (guide 5) is one: an installer writes, a person approves and a script checks, and an agent body written only to fill the slot would teach nothing. The contract test lists each such pattern by name, and its page must say that the skeleton has no agent body.

A pattern whose every step is a Companion skill has no agent body, no `SKILL.md` and no runner in its skeleton, only the templates the steps pass to each other. The planning chain (guide 7) is one: grilling, writing the PRD and slicing it are the Companion library's skills, and a `SKILL.md` here would restate one of them. The contract test lists each such pattern by name, refuses any of the three parts in its skeleton, and its page must say that the skeleton is templates only.

## Considered Options

- **A Portable skill with a config for each workflow, as orchestrate is.** Rejected for now. The parts are small, and almost every line in them is a repository fact, so the config would be the whole skill. It also implies the kit maintains each one for every Consumer's hooks, which it cannot test. A guide stays open to this later, one pattern at a time.
- **Link to the source repository's files.** Rejected. Those files name the source's commands and record its decisions. A reader would have to translate every line, and the files can change or move without notice.
- **Make the skeletons Kit-owned paths.** Rejected. A Kit-owned path is replaced whole on upgrade, which would wipe out the edits a skeleton exists to receive.
- **Pages only, with no skeletons.** Rejected. The rules in a pipeline sit in the runner, such as which hooks it runs and what it refuses, and prose alone reads like advice. A runner stub shows where each rule is enforced.

## Planned guides

All eight are written. The first pass wrote guides 1 and 2, the second wrote 3 and 8, the third wrote 4 and 5, and the fourth wrote 6 and 7. A further guide is a new entry here, with its page and skeleton in the same change:

1. **Commit pipeline** (written: [commit-pipeline.md](../patterns/commit-pipeline.md)). A read-only drafting agent and a runner that always runs the hooks and labels each failure with a reason. Covers named-path staging, a secret-path guard, and origin lines on fixes.
2. **Pull request pipeline** (written: [pr-pipeline.md](../patterns/pr-pipeline.md)). The drafting agent emits the merge base and the runner verifies it. Covers a merge risk block, labels from one allowlist, and no reviewers by default.
3. **Tiered quality gates** (written: [tiered-quality-gates.md](../patterns/tiered-quality-gates.md)). Mechanical, standard and full tiers, builder → reviewer → runner chains, and a retry cap.
4. **Sub-agent sync across harnesses** (written: [sub-agent-sync.md](../patterns/sub-agent-sync.md)). One folder holds the canonical agent bodies, and a generator writes each harness's copy, frontmatter included, with `--apply` and a `--check` that fails on drift. Capabilities are roles mapped to each harness's tool names, each harness's model is pinned in one policy and written by the generator, and a scheduled audit checks that every pinned model name still exists.
5. **A registry for skills from outside the repository** (written: [external-skills-registry.md](../patterns/external-skills-registry.md)). An external skill is installed at project scope, committed and never hand-edited, so an upstream change arrives as a diff. The lock file is the registry, one approval list names each approved skill, and a check holds the two in step in both directions. Content forked from an upstream skill moves to where it is always true, there is no personal-scope tier, and every other doc links to the approval list rather than restating it.
6. **The instruction layout** (written: [instruction-layout.md](../patterns/instruction-layout.md)). One `AGENTS.md` plus thin harness adapters that import it and never restate it, and one skill tree each harness reads through a link. A skill listed there says which skill to use, not that skill's steps, and a reference document is opened on a named trigger. Past a delegation threshold a search goes to a read-only explorer, and a refused tool call is the human's decision.
7. **Planning chain** (written: [planning-chain.md](../patterns/planning-chain.md)). Grill → PRD → slices, each slice with a gate tier, an AFK or HITL marker, its blocking edges and a dispatch label. A slice closes only on a clean outcome, and a PRD is gated once on its assembled branch. It builds on the Companion library, so it follows the last consequence below: its skeleton is templates only.
8. **Merge train** (written: [merge-train.md](../patterns/merge-train.md)). It keeps strict up-to-date branch protection meaningful without a merge queue or an admin bypass. Pull requests merge one at a time, in the order given. For each one the train brings the branch up to date if needed, waits for every required check on that new head (read from the ruleset, not listed in the script), and merges exactly that head. It stops at the first red check, conflict, draft or blocking review, and names the pull requests it never reached. All decisions live in a pure core, and all IO in a thin shell.

   Its optional auto-merge mode moves from off to shadow to on. In shadow it only posts what it would have merged, or why it held. When on, it merges only on facts read for the exact head, never on a model's judgment, and a bad auto-merge sends it back to shadow. The kit's own flows promise that nothing auto-merges, and this guide does not change that. It is a practice a Consumer may choose for its own repository, so the page presents auto-merge as optional and reached only through shadow, and the kit's flows keep their promise.

## Consequences

- **The kit can document a workflow without owning it.** Every guide has the same shape: a page, a skeleton, a Docs map row and a README link.
- **A skeleton can be wrong for a Consumer without being a kit bug.** The page says what each rule protects against, so an adopter can tell when a rule does not fit them. The kit fixes a guide when its reasoning is wrong, not when one repository's adaptation fails.
- **A skeleton change is not a breaking change.** Nothing a Consumer runs comes from the kit, so a changed skeleton is a docs entry in the CHANGELOG, never **Consumer action**.
- **Patterns that build on a Companion library are handled separately.** A guide for a planning chain built on Companion skills would describe how the kit's pieces fit around that library. It would not restate the library's skills. The planning chain does this: its page names each Companion skill for its step and describes what one step hands the next, and its skeleton holds only those hand-offs, as templates.
