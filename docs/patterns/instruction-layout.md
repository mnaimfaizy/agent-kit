# Pattern guide: the instruction layout

A way to lay out the instructions agents read so that each rule is written once: one always-on file every harness reads, a thin adapter per harness that adds only that harness's notes, one skill tree every harness sees, and reference documents opened only when a named trigger applies. This is a **Pattern guide** ([ADR 0012](../adr/0012-pattern-guides-are-docs-a-consumer-adapts.md)): you read it, copy the skeleton, and adapt it. Agent-kit does not install or upgrade it.

Skeleton to copy: [`examples/patterns/instruction-layout/`](../../examples/patterns/instruction-layout/)

- [`AGENTS.md.template`](../../examples/patterns/instruction-layout/AGENTS.md.template): a minimal shared file, with reference documents behind triggers, the always-on rules and a Skills section of choosers.
- [`CLAUDE.md.template`](../../examples/patterns/instruction-layout/CLAUDE.md.template): the Claude Code adapter, which imports the shared file and adds only what is true for Claude Code.
- [`skills-layout.md`](../../examples/patterns/instruction-layout/skills-layout.md): the one skill tree, the link each harness reads it through, and how to make the link.
- [`explorer.agent.md`](../../examples/patterns/instruction-layout/explorer.agent.md): the read-only explorer that a search is handed to past the delegation threshold.
- [`explorer-request.md`](../../examples/patterns/instruction-layout/explorer-request.md): the request the main agent sends it, with a filled example.
- [`SKILL.md`](../../examples/patterns/instruction-layout/SKILL.md): the skill an agent follows to decide which file a new instruction belongs in.
- [`instruction-layout-core.mjs`](../../examples/patterns/instruction-layout/instruction-layout-core.mjs): the layout check's core. Every problem it reports is decided by a pure function here.
- [`instruction-layout-core.test.mjs`](../../examples/patterns/instruction-layout/instruction-layout-core.test.mjs): the contract suite, including a test that the two templates pass the check.
- [`check-instruction-layout.mjs`](../../examples/patterns/instruction-layout/check-instruction-layout.mjs): the check's shell, which reads the files and the link and prints what the core finds.

The two instruction files are named `.template` in the skeleton for a reason: a harness that finds an `AGENTS.md` or a `CLAUDE.md` in a folder loads it as the instructions for that folder, placeholders and all.

## The problem

Every agent harness reads its own instruction file: Claude Code reads `CLAUDE.md`, others read `AGENTS.md` or a file in their own folder. A repository that uses two harnesses starts by giving each one its own copy of the rules, and from then on:

- **The copies drift.** A rule is tightened in the file one person's harness reads. The other harness keeps the old rule, and the same request is handled two ways depending on who asked.
- **The always-on file grows into a manual.** Every lesson becomes a line in the file that is loaded on every turn. The commands for a release, the steps of a commit, the full label table: each costs context on every task, and a long file gets skimmed, so the rules that matter on every task are read less carefully.
- **A skill's steps get copied up.** Someone writes a skill's procedure into the always-on file "so it is never missed". Now there are two procedures. The always-on copy is the one an agent always has in front of it, so it wins, and it is the one nobody updates when the skill changes.
- **The skills fork too.** Each harness reads skills from its own folder, so the skills get copied into each one, and a fix to one copy reaches one harness.
- **Lists get restated.** A README, an onboarding page or an adapter repeats a list "for convenience", and the copy stops matching the original without anyone noticing.

Two smaller habits make it worse. An agent searches the code one file at a time and fills its own context with file contents it no longer needs. And when a hook or a permission check refuses a command, the agent finds another command with the same effect.

## The moving parts

```text
                     ┌───────────────────────────┐   trigger   ┌──────────────────────┐
                     │ AGENTS.md (always on)     │────────────▶│ reference documents  │
                     │ scope, commands, rules,   │  opens one  │ commands, conventions│
                     │ Skills: choosers only     │             └──────────────────────┘
                     └──▲───────────▲────────┬───┘
            @-import    │           │ pointer│ names a skill
  ┌─────────────────┐   │  ┌────────┴──────┐ │   ┌─────────────────────────────────────┐
  │ CLAUDE.md       │───┘  │ other adapter │ └──▶│ <skill-tree>/<name>/SKILL.md        │
  │ Claude-only     │      │ its notes only│     │ one tree; .claude/skills is a link  │
  └─────────────────┘      └───────────────┘     └─────────────────────────────────────┘
                     ┌───────────────────────────┐
                     │ explorer (read-only)      │◀── explorer request, past the
                     │ returns a cited summary   │    delegation threshold
                     └───────────────────────────┘
                     check: adapters import and never restate; choosers name real skills;
                     every reference has a trigger and a file; each skill folder is a link
```

1. **The shared file** (`AGENTS.md`) holds the policy that is true for every task in every harness: what the repository is, the everyday commands, the always-on rules, and the choosers. It is the only file a person edits to change a rule.
2. **An adapter per harness** is the file that harness reads by name. It imports the shared file in that harness's syntax (`@AGENTS.md` in `CLAUDE.md`) and adds only what is true for that harness alone, such as a hook or a tool name. A harness with no import syntax gets a short pointer instead.
3. **The skill tree** is one folder of skills. A harness that reads skills from a folder of its own gets a committed link to the tree.
4. **Reference documents** hold what is needed only sometimes: the full command list, the conventions for adding a doc. The shared file lists each one with the trigger that should make an agent open it.
5. **The explorer** is a read-only sub-agent. Past a set number of searches in a row, the main agent hands the search to it with a structured request, and gets back a summary with citations instead of the files.
6. **The check** runs in CI and a pre-commit hook, and fails when the layout disagrees with itself.

## The rules, and why each one exists

| Rule                                                                                                                                                                         | Why                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One shared, always-on file holds the policy. A person changes a rule there and nowhere else.                                                                                 | A rule with two homes has two versions as soon as one is edited. One file that every harness reads means a rule changes once and reaches every harness.                                                                                                                                                                |
| Each harness's adapter imports the shared file and adds only that harness's notes. It never restates the shared file; the check fails on a copied sentence.                  | The harnesses insist on their own file names, so the adapters have to exist. A restated rule in an adapter is the drifting copy this layout removes. A harness-only note kept in the shared file would confuse every other harness that reads it.                                                                      |
| One skill tree. Each harness that reads its own skills folder gets a committed link to it, never a copy.                                                                     | Copies of a skill fork, as copies of a rule do. A script that copies skills into each folder rebuilds a generator for something a link already shares. Sub-agents are different: each harness wants other frontmatter, so they are generated ([sub-agent sync](sub-agent-sync.md)).                                    |
| The Skills section lists choosers: which skill to load for which request, one line each, naming the skill's path. It never holds a skill's steps.                            | A skill's own description already tells a harness when to load it. A chooser is for the requests two skills could both answer, such as a one-off issue against a planned feature. Steps copied up become a second procedure that wins because it is always loaded.                                                     |
| A chooser is needed only where requests collide. Not every skill has one.                                                                                                    | A line per skill turns the section into an index of the tree, which is the tree with manual synchronisation. The check only requires that each chooser names a skill that exists.                                                                                                                                      |
| A reference document is opened on a named trigger, and listed in the shared file with that trigger. It is not inlined.                                                       | The always-on file is in context on every turn. A trigger keeps the rarely needed text out of it until a task needs it, and tells the agent when that is. A reference listed with no trigger is one nobody opens.                                                                                                      |
| Link, don't restate. Each fact lives in one file, and every other file that needs it links there. The same goes for lists: the commands, the labels, the approved skills.    | A copy is a second record that nothing keeps in step. The [registry of external skills](external-skills-registry.md#worked-example-the-readme-that-restated-the-list) has a worked example: a README that listed the approved skills went three months out of date while the check that compared the real list passed. |
| Past a delegation threshold, such as a third read or search in a row to find something, the main agent hands the search to a read-only explorer with a structured request.   | Each search result the main agent reads stays in its context for the rest of the task. The explorer reads the files and returns a summary with citations. The request's fields stop it re-deriving what the caller knew, and a no-shell explorer cannot change anything.                                               |
| The explorer has no shell, so the request carries supplied evidence: the output of any command it would need, run by the main agent.                                         | A read-only grant is easy to check and easy to keep. When the answer depends on a command, such as a dependency graph query, the caller runs it once and the explorer cites it.                                                                                                                                        |
| The explorer tags each finding `[found]`, with a path and line, or `[inferred]`, with what it was deduced from, and lists in its gaps every hit it left out.                 | A summary reads as certain whether or not its author looked. The tags tell the caller which findings it can act on and which it must check, and the gaps say what the search did not cover.                                                                                                                            |
| A refused tool call, from a hook or a permission check, is the human's decision. The agent stops, says what was refused, and asks, even when it looks like a false positive. | A hook is a rule the human wrote down. An agent that reaches the same effect another way has overruled the human without asking. A false positive is real, and the human fixes it by changing the hook, not the agent by going round it.                                                                               |

## Failure modes

- **A paraphrase.** The check finds a sentence of at least `MIN_WORDS` words (eight in the skeleton) copied word for word. A rule reworded in an adapter passes it. Reviewers catch that one; the rule to point at is "link, don't restate".
- **A harness with no import.** Some harnesses cannot import another file. Give that harness a pointer of a line or two that names the shared file, and keep it out of the check's adapters, since it has no import line to find.
- **Nested instruction files.** A folder's own `AGENTS.md` adds rules for that folder, and the check reads only the root one. To keep a nested file from restating the root, add it to the check as a second shared file, or review it.
- **A checkout without symlinks.** Git on Windows with `core.symlinks` off writes the link as a small text file holding the path. The harness then sees no skills, and the check fails on the file. Contributors on such a checkout turn symlink support on.
- **A harness that reads both folders.** A harness that reads the tree's folder and the linked folder may list each skill twice. Check its docs, and where it reads the tree directly, give it no link.
- **The shared file grows anyway.** The check does not measure length. When a section is needed only for some tasks, move it to a reference document with a trigger, and review the file's size as you would any other budget.
- **The threshold is advice.** The delegation threshold is an instruction the agent counts for itself. It holds as well as the agent follows it; the explorer's cost is low enough that erring towards delegating is cheap.

## Adopting it

1. **Pick the files.** Name the shared file, each harness's adapter, the skill tree's folder and each folder a harness reads skills from. Check each harness's own docs for its file name, its import syntax and its skills folder.
2. **Copy the skeleton.** Save `AGENTS.md.template` as `AGENTS.md` and `CLAUDE.md.template` as `CLAUDE.md` at the repository root. Put the explorer's agent body and its request where your harness reads agents, the `SKILL.md` in the skill tree, and the core, its suite and the shell wherever your scripts live.
3. **Fill in every placeholder.** Each is written `<like this>` or as a `TODO(adopt)` line. They cover the reference documents and their triggers, the everyday commands, the delegation threshold and the explorer's name, the choosers, the skill tree, the link paths and the check's command.
4. **Move what you have.** Merge each harness's instruction file into the shared file, keeping only harness-only notes in its adapter. Move each skill into the tree and replace each harness's skills folder with a link. Move anything needed only sometimes into a reference document with a trigger, and replace every restated list with a link to its one home.
5. **Wire it in.** Run the check in CI and in a pre-commit hook.
6. **Try it on purpose.** Copy one shared rule into the adapter and check that the check fails. Replace the link with a copy of the tree, and check that it fails. Add a chooser for a skill that does not exist, and check that it fails.
