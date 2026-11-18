# Pattern guide: sub-agent sync across harnesses

A way to define each sub-agent once and give every agent harness you use (Claude Code, Cursor, Copilot, Gemini or another) its own copy, with that harness's frontmatter and pinned model, so that a fix to an agent reaches every harness and a hand edit to one copy is caught instead of lost. This is a **Pattern guide** ([ADR 0012](../adr/0012-pattern-guides-are-docs-a-consumer-adapts.md)): you read it, copy the skeleton, and adapt it. Agent-kit does not install or upgrade it.

Skeleton to copy: [`examples/patterns/sub-agent-sync/`](../../examples/patterns/sub-agent-sync/)

- [`reviewer.agent.md`](../../examples/patterns/sub-agent-sync/reviewer.agent.md): one canonical agent body, with its capability roles and one part marked for a single harness.
- [`agent-models.json`](../../examples/patterns/sub-agent-sync/agent-models.json): the model policy, one pin per agent per harness, and where each harness lists its model names.
- [`sync-agents-core.mjs`](../../examples/patterns/sub-agent-sync/sync-agents-core.mjs): the generator's core. Reading a canonical file, rendering each copy, planning the sync and auditing the pins are pure functions here.
- [`sync-agents-core.test.mjs`](../../examples/patterns/sub-agent-sync/sync-agents-core.test.mjs): the contract suite. Its last test fails if the example copy below is not what the generator writes.
- [`sync-agents.mjs`](../../examples/patterns/sub-agent-sync/sync-agents.mjs): the generator's shell, with `--apply` and `--check`.
- [`audit-models.mjs`](../../examples/patterns/sub-agent-sync/audit-models.mjs): the periodic audit that every pinned model name still exists.
- [`reviewer.claude.md`](../../examples/patterns/sub-agent-sync/reviewer.claude.md): the Claude Code copy the generator writes from the canonical body, unedited.
- [`SKILL.md`](../../examples/patterns/sub-agent-sync/SKILL.md): the skill an agent follows when it adds, edits or removes a sub-agent.

## The problem

A repository that uses more than one agent harness ends up with the same sub-agent in several folders, because each harness reads its own: `.claude/agents/`, `.cursor/agents/`, `.github/agents/` and so on. Each folder wants a slightly different file: other frontmatter keys, other tool names, other model names. Kept by hand, they drift:

- **A fix reaches one harness.** Someone tightens the reviewer's instructions in the harness they use. The other copies keep the old instructions, and the same agent behaves differently depending on which tool ran it.
- **A hand edit is lost.** Once a generator exists, an instruction written straight into a copy lasts until the next sync. In one repository an instruction added to one harness's copy was overwritten two weeks later, and nobody noticed until its output was missing.
- **Model names are edited by hand.** Each harness spells models its own way, and a pin changed in one copy is not changed in the others. Worse, a vendor retires a model, and the agent pinned to it starts failing or quietly runs on a default.
- **A grant widens unseen.** Adding a shell tool to one copy's tool list gives that agent a new power in one harness. In a diff of a long frontmatter line it is easy to miss.
- **A frontmatter value breaks the file.** An unquoted colon in a description is invalid YAML, and some harnesses drop an agent whose frontmatter does not parse, without an error.

## The moving parts

```text
   canonical folder              generator                    harness folders
  ┌──────────────────┐      ┌────────────────────┐ --apply  ┌────────────────────┐
  │ <agent>.agent.md │─────▶│ parse, render each │─────────▶│ .claude/agents/    │
  │ body, roles,     │      │ copy, plan create, │          │ .cursor/agents/    │
  │ harness markers  │      │ update, extra      │ --check  │ <other>/agents/    │
  └──────────────────┘      └─────────┬──────────┘◀─────────│ (generated only)   │
  ┌──────────────────┐                │                     └────────────────────┘
  │ model policy:    │────────────────┘
  │ pin per agent    │      ┌────────────────────┐  weekly  ┌────────────────────┐
  │ per harness      │─────▶│ audit: every pin   │─────────▶│ each harness's     │
  └──────────────────┘      │ still listed?      │  fetch   │ model list         │
                            └────────────────────┘          └────────────────────┘
```

1. **The canonical folder** holds one file per agent: its name, its description, the capability roles it needs (`read`, `search`, `edit`, `execute`, `web`), and its body. A part of the body meant for some harnesses only sits inside a `<!-- harness:claude -->` … `<!-- /harness -->` block.
2. **The model policy** is one file that pins a model for every agent in every harness, in that harness's spelling, and says where each harness publishes its list of model names.
3. **The generator** renders every harness's copy from those two: the frontmatter in that harness's shape (tool names mapped from the roles, the pinned model, quoted values) and the body with the other harnesses' blocks removed. `--apply` writes the copies and deletes copies of agents that no longer exist. `--check` writes nothing and fails if any copy is missing, different or extra.
4. **The audit** runs on a schedule. It fetches each harness's model list and fails if a pinned name is no longer on it.

## The rules, and why each one exists

| Rule                                                                                                                                    | Why                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One folder holds the canonical bodies. Every other copy is generated from it.                                                           | Two folders that can both be edited are two sources of truth, and the one edited last wins only in the harness that reads it.                                                                                                    |
| A copy is wholly generated, frontmatter included. Each copy says so in a comment at the top of its body.                                | A key the generator preserves from an existing copy is a key nobody reviews in the canonical file, and it drifts the same way the bodies did. The comment tells a person who opens the copy where to edit instead.               |
| `--check` fails on a missing, changed or extra copy. It runs in a pre-commit hook and in CI.                                            | A hand edit to a copy is caught when it is made, before an `--apply` erases it. The hook catches it on the author's machine; CI catches it when the hook was skipped.                                                            |
| `--apply` deletes a copy whose canonical file is gone, unless told to keep it. It only touches files with the copy's extension.         | An agent deleted from the canonical folder but alive in one harness is a ghost: it still runs there. Reading only the copy's extension keeps a README in the folder safe.                                                        |
| A part for some harnesses only lives in the canonical file, inside a marker block that names them.                                      | Some instructions really are harness-specific, such as a tool's name. Written into a copy they are lost at the next sync; written in the canonical file they are kept and reviewed with the rest.                                |
| An unknown harness name, a nested block or an unclosed block is an error, not a warning.                                                | A marker that silently fails to apply sends an instruction to the wrong harness, or drops it for all of them. The mistake is cheap to fix when the generator refuses to run.                                                     |
| Capabilities are declared once, as roles, and mapped to each harness's tool names by the generator. An unknown role is an error.        | A tool list per copy is a grant per copy. Roles make a widening one changed word in the canonical file, which a reviewer sees, and the map gives each harness the right spelling.                                                |
| Every agent has a pinned model for every harness, in one policy file. A missing pin is an error. A pin for a deleted agent is an error. | The pin is enforced by the generator, so it cannot differ between a copy and the policy. A missing pin means the harness picks a default that can change under you; a stale pin means the policy no longer describes the agents. |
| The generator quotes every frontmatter value it writes.                                                                                 | A colon or a leading quote in a description stays a string. The file always parses, so no harness drops the agent.                                                                                                               |
| A periodic audit checks that each pinned model name is still listed by its harness. It runs on a schedule, not on each pull request.    | A model's retirement is not something a pull request did, so a per-PR check would fail on unrelated work. A weekly run finds it within a week, in a place someone owns.                                                          |
| The audit reports `NOT RUN` when it could not read a list, and never changes a pin itself.                                              | An unread list checked nothing, so it cannot be a pass. Picking a replacement model is a judgment about cost and quality, so a person makes it, and the generator then writes it everywhere.                                     |

## Failure modes

- **The hook is not installed.** A contributor edits a copy, commits without the hook, and CI is the first to fail. That is the design working. If it keeps happening, the generated folders are not obviously generated: check that the comment at the top of each copy is visible in the editor people use.
- **A catalog spells the model differently.** The pin is `composer-2` and the vendor's page says "Composer 2", so the audit reports a pin as missing that is not. Point the audit at a machine-readable list where the harness has one, or add a per-harness spelling map in `auditPins`.
- **A short alias matches too much.** An alias like `sonnet` appears on a model page whether or not it still resolves, so a substring match can pass a dead alias. Prefer full model IDs in the policy where the harness accepts them, and an audit source that lists IDs.
- **A generated folder holds hand-written files.** Any file in a harness folder with the copy's extension is either a copy or an extra, and `--apply` deletes extras. Keep the generated folders generated only; put notes elsewhere.
- **One harness reads the canonical folder itself.** Then it is not a target, and the generator does not write its model line. Either enforce that harness's pin with a check over the canonical frontmatter, or keep the canonical folder neutral and make every harness a target.
- **A harness needs a different description.** Marker blocks work on the body only. If a harness really needs another description, add a per-harness field to the canonical frontmatter and render it, rather than preserving a hand-written one in the copy.

## Adopting it

1. **Choose the canonical folder.** A neutral folder that no harness reads is simplest. A folder one harness reads directly saves a copy, but see the failure mode above.
2. **Copy the skeleton.** Put the core, its suite, the shell and the audit wherever your scripts live, the policy next to them or in your config folder, and the `SKILL.md` in your skills directory. The example copy (`reviewer.claude.md`) and its test are there to show and check what the generator writes; drop them once your own agents are in.
3. **Fill in every placeholder.** Each is written `<like this>` or as a `TODO(adopt)` line. They cover the canonical folder, each harness's folder, frontmatter keys and tool names (check each harness's own docs), the roles you allow, the model policy's path, and each harness's model list URL.
4. **Move your agents in.** For each agent, merge its copies into one canonical body, turn its tool lists into roles, and put its models in the policy. Run `--apply` and read the diff: each copy should change only in ways you meant.
5. **Wire it in.** Run `--check` in your pre-commit hook and in CI. Schedule the audit weekly, with its failures going to a place someone reads, such as an issue.
6. **Try it on purpose.** Edit one copy by hand and check that `--check` fails. Delete one pin and check that the generator refuses to run. Pin a made-up model name and check that the audit reports it.
