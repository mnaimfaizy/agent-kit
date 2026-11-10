# Install individual skills

For **Skill installers**: people who want one or more of Agent-kit's Portable skills without adopting the rest of the kit. The [`npx skills`](https://www.npmjs.com/package/skills) CLI copies a skill from a release tag into your agent's skills directory.

**If you adopt the kit, don't use this page.** A Consumer gets every Portable skill from the tag its `uses:` pins name, as a Kit-owned path (see [Adopt](adopt.md)). Installing a Kit-owned skill with `npx skills` in a Consumer turns that path into a symlink, or a junction on Windows, and `agent-kit upgrade` refuses to touch it.

## Scope

Each skill declares where it works, in its `SKILL.md` frontmatter (`metadata.agent-kit-scope`):

- **User-scope** (`user`): works from your own skills directory in any repository. Install it once with `-g`.
- **Repo-scope** (`repo`): works only inside a repository that holds its supporting files. Install it into that repository, without `-g`.

| Skill                                                                           | `agent-kit-scope` | What it needs                                                                                              |
| ------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| [`code-review`](../.claude/skills/code-review/SKILL.md)                         | `user`            | Nothing.                                                                                                   |
| [`explainer`](../.claude/skills/explainer/SKILL.md)                             | `user`            | Nothing; per-repository settings are optional.                                                             |
| [`instruction-drift-audit`](../.claude/skills/instruction-drift-audit/SKILL.md) | `user`            | Node 22 or later. Its optional CI gate and hook need it installed in the repository too.                   |
| [`qa-plan`](../.claude/skills/qa-plan/SKILL.md)                                 | `user`            | Node 22 or later, `git`, and an open pull request; `gh` to read it and to deliver beyond the working copy. |
| [`security-audit`](../.claude/skills/security-audit/SKILL.md)                   | `repo`            | A Threat pack (threat model and findings ledger) in the repository. Without one it stops before any work.  |
| [`security-finding-triage`](../.claude/skills/security-finding-triage/SKILL.md) | `user`            | Nothing.                                                                                                   |
| [`security-response`](../.claude/skills/security-response/SKILL.md)             | `user`            | `security-finding-triage`, installed with it: its `triage` mode runs that skill.                           |

## Install

Replace `<tag>` with the release you want, for example `v1.0.0-beta.2` (see the [releases](https://github.com/mnaimfaizy/agent-kit/releases)). Every install names a tag: an install without one follows `main`, which no release promises anything about, and is not supported.

**An install replaces any skill you already have with the same name.** `npx skills` keeps one skill per name in each place it installs to, and replaces it without asking. Its summary lists the agents it "overwrites". Other skill collections ship skills with the same names as these (a `code-review`, say), so check first:

```bash
npx skills list -g
```

It lists each skill with its source; drop `-g` to see the skills installed in the current project. To keep the skill you have, don't install Agent-kit's one of the same name in that place.

`code-review`:

```bash
npx skills add mnaimfaizy/agent-kit#<tag> --skill code-review -g
```

`explainer`:

```bash
npx skills add mnaimfaizy/agent-kit#<tag> --skill explainer -g
```

`instruction-drift-audit`:

```bash
npx skills add mnaimfaizy/agent-kit#<tag> --skill instruction-drift-audit -g
```

`qa-plan`:

```bash
npx skills add mnaimfaizy/agent-kit#<tag> --skill qa-plan -g
```

`security-audit`, from the root of the repository it audits, with no `-g`:

```bash
npx skills add mnaimfaizy/agent-kit#<tag> --skill security-audit
```

It needs a Threat pack in that repository: a threat model and a findings ledger. Put them at `.security/threat-model.md` and `.security/findings-ledger.md`. [Security audit](security-audit.md#threat-pack) says what goes in each, and this repository's [threat model](../security/threat-model.md) and [ledger](../security/findings-ledger.md) are a worked example (kept under `security/`, which its own audit Caller names). Run by hand, the skill writes its report for you to file as a draft security advisory yourself; the automated audit flow, which files it for you, comes with adopting the kit.

`security-finding-triage`:

```bash
npx skills add mnaimfaizy/agent-kit#<tag> --skill security-finding-triage -g
```

`security-response`, always with `security-finding-triage`:

```bash
npx skills add mnaimfaizy/agent-kit#<tag> --skill security-response --skill security-finding-triage -g
```

## Upgrade

Run the same command again with the new tag. [Releases](releases.md) says what each kind of version bump can change: a skill moving from User-scope to Repo-scope, or needing a new supporting file, only happens in a Major release.
