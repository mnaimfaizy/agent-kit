# @mnaimfaizy/agent-kit

The command-line companion to [Agent-kit](https://github.com/mnaimfaizy/agent-kit): checks a Consumer repository against the Agent-kit tag its Callers pin, and upgrades it to another tag.

```bash
npx @mnaimfaizy/agent-kit doctor                    # local run with your own gh login
npx @mnaimfaizy/agent-kit doctor --ci               # Kit-owned paths and pins only
npx @mnaimfaizy/agent-kit doctor --strict           # warnings fail too
npx @mnaimfaizy/agent-kit upgrade --tag <new-tag>   # move to another tag (asks first)
```

- The package holds only code. Kit files are read from the git tag your `uses:` pins name, never bundled.
- `doctor` is read-only. It runs git in your checkout without hooks or configured filter commands, never changes files or GitHub settings, and for anything to fix prints a POSIX-shell `gh` command for you to run.
- No runtime dependencies. Needs Node.js 22 or later, `git`, and (outside `--ci`) `gh` logged in with admin on the repository.
- Tags before `v1.0.0-alpha.11` have no `kit-owned-paths.txt`, and the CLI refuses them: adopt those by hand with that tag's `docs/adopt.md`.
- `upgrade --tag <vY>` reads the current tag from your Agent-kit `uses:` pins (they must agree), replaces each Kit-owned path vY lists (delete, then copy), deletes paths only the old tag listed, rewrites only the `@<tag>` of those pins, prints the `examples/` diff between the two tags for you to apply by hand, and then runs the `doctor --ci` checks. Every refusal is checked before anything is written. It refuses a path with uncommitted changes unless `--force`, refuses symbolic links in or above a Kit-owned path, and copies only regular and executable files from the tag. It asks before writing; pass `--yes` when there is no terminal. It writes only local files and commits nothing.
- `init` is not in this version yet.

The package version matches the Agent-kit Release line: `@mnaimfaizy/agent-kit@1.0.0-alpha.12` is published from tag `v1.0.0-alpha.12`, with npm provenance.

Full documentation: [Getting started](https://github.com/mnaimfaizy/agent-kit/blob/main/docs/getting-started.md) and [Adopt](https://github.com/mnaimfaizy/agent-kit/blob/main/docs/adopt.md#check-an-adoption-with-doctor).
