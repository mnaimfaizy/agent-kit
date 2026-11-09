---
status: accepted
---

# Offer Portable skills to Skill installers through `npx skills`, scoped by the skill

People who want one Portable skill should not have to adopt the whole kit, so Agent-kit now serves **Skill installers** as well as Consumers. Skill installers use the open `npx skills` CLI, always pinned to a Release line tag (`npx skills add mnaimfaizy/agent-kit#<tag> --skill <name>`). That CLI reads `.claude/skills/` as it is, so no second copy of any skill exists, and the git tag stays the single source of truth, as [ADR 0001](0001-distribute-the-cli-via-npm.md) set for the CLI. This reverses the earlier "tags only, nothing else" stance only for skill installs. There is still no skills zip and no Marketplace listing. Each skill declares itself a **User-scope skill** or a **Repo-scope skill** in its `SKILL.md` frontmatter (`metadata.agent-kit-scope`). A Repo-scope skill checks for its supporting files at run time and stops without them. No tool blocks the install itself.

## Considered Options

- **A Claude Code plugin marketplace.** Rejected for now. It works only for Claude Code, it needs a version stamped into a manifest at every release, it prefixes skill names (`/code-review:code-review`), and each plugin probably caches the whole repository.
- **An `agent-kit skills` subcommand.** Rejected. It was the only way to refuse a global install of a Repo-scope skill. But a skill's install location is not what breaks it; missing supporting files are. The skill can check for those itself, wherever it was installed.
- **Hiding Repo-scope skills** (`metadata.internal: true`). Rejected. They are offered for project installs, and naming a skill still installs it anyway.

## Consequences

- **Scope does not change Kit-owned paths.** Consumers keep copying all six skills from the tag, because the review and audit flows read `code-review` and `security-audit` from the checkout and restore them from the PR base.
- **Consumers must not install Kit-owned skills with `npx skills`.** Its project install turns `.claude/skills/<name>` into a symlink, which `agent-kit upgrade` refuses.
- **Scope is part of SemVer.** A skill moving from User-scope to Repo-scope, or gaining a required supporting file, is a Major change. A move from Repo-scope to User-scope is Minor.
- **`npx skills` never advances a tag pin.** To upgrade, Skill installers run the install command again with the new tag.
