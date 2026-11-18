<!--
Pattern guide skeleton: docs/patterns/instruction-layout.md in Agent-kit.
Keep this page next to your skill tree, or fold it into your conventions doc,
fill in every <placeholder>, and delete this comment.
-->

# Skills layout

One skill tree holds every skill. Each harness that reads skills from a folder of its own gets a link to the tree, never a copy.

```text
<repository root>
├── AGENTS.md                  shared, always-on policy
├── CLAUDE.md                  Claude Code adapter: imports AGENTS.md
├── <other adapter>            one per other harness, each importing or pointing at AGENTS.md
├── <skill-tree>/              the one skill tree
│   ├── <commit-skill>/
│   │   └── SKILL.md
│   └── <placing-instructions>/
│       └── SKILL.md
├── .claude/
│   └── skills -> ../<skill-tree>      a link, committed
└── <agents folder>/
    └── <explorer>.agent.md
```

## Make the link

From the repository root:

```sh
mkdir -p .claude
ln -s ../<skill-tree> .claude/skills
git add .claude/skills
```

Git stores the link itself, not the files it leads to. A checkout without symlink support (Git on Windows with `core.symlinks` off) writes it as a small text file holding the path instead, and the layout check fails on it.

## Which folder each harness reads

| Harness     | Reads skills from          | How it gets the tree                 |
| ----------- | -------------------------- | ------------------------------------ |
| Claude Code | `.claude/skills/`          | The link above                       |
| <harness>   | <its project-scope folder> | <reads the tree directly, or a link> |

Check each harness's own docs for its folder. Where a harness can read the tree directly, give it no link at all.

## Adding a skill

Add its folder under `<skill-tree>/` only. A skill folder anywhere else is a second tree that nothing keeps in step. Add a line to the Skills section of AGENTS.md only when the skill's description alone does not say when to load it, such as when two skills could answer the same request.
