# @mnaimfaizy/agent-kit

The command-line companion to [Agent-kit](https://github.com/mnaimfaizy/agent-kit): adopts Agent-kit in a Consumer repository, checks it against the Agent-kit tag its Callers pin, and upgrades it to another tag.

```bash
npx @mnaimfaizy/agent-kit init --tag <tag>          # first adoption (asks first)
npx @mnaimfaizy/agent-kit doctor                    # local run with your own gh login
npx @mnaimfaizy/agent-kit doctor --ci               # Kit-owned paths and pins only
npx @mnaimfaizy/agent-kit doctor --strict           # warnings fail too
npx @mnaimfaizy/agent-kit upgrade --tag <new-tag>   # move to another tag (asks first)
```

- The package holds only code. Kit files are read from the git tag your `uses:` pins name, never bundled.
- `doctor` is read-only. It runs git in your checkout without hooks or configured filter commands, never changes files or GitHub settings, and for anything to fix prints a POSIX-shell `gh` command for you to run.
- No runtime dependencies. Needs Node.js 22 or later, `git`, and (outside `--ci`) `gh` logged in with admin on the repository.
- Tags before `v1.0.0-alpha.11` have no `kit-owned-paths.txt`, and the CLI refuses them: adopt those by hand with that tag's `docs/adopt.md`.
- `upgrade --tag <vY>` reads the current tag from your Agent-kit `uses:` pins (they must agree), replaces each Kit-owned path vY lists (delete, then copy), deletes paths only the old tag listed, rewrites only the `@<tag>` of those pins, prints the `examples/` diff between the two tags for you to apply by hand, and then runs the `doctor --ci` checks. Every refusal is checked before anything is written. It refuses a path with uncommitted changes unless `--force`, refuses symbolic links in or above a Kit-owned path, and copies only regular and executable files from the tag. Ignored files inside a replaced path are deleted with it, and listed first. After a Dependabot pin bump, when the pins already name vY, add `--from <vX>` to also delete paths only vX listed and see the `examples/` diff. It asks before writing; pass `--yes` when there is no terminal. It writes only local files and commits nothing; where `core.fileMode` is off (Windows), it stages each copied file with the tag's mode (`git add --chmod=+x` or `-x`), so the executable bit is neither lost nor kept by mistake.
- `init --tag <vX>` copies the Kit-owned paths, writes `.github/workflows/agent-pipeline.yml` and/or `security-audit.yml` from the tag's `examples/` with your answers filled in (`--flows`, `--actors`, `--default-branch`, `--verify`, `--preset`), writes the Threat pack skeleton to `.security/` (or `--threat-pack-dir`) and `.github/dependabot.yml` if there is none, and prints the GitHub-side steps as `gh` commands. It refuses to overwrite an existing Caller or Kit-owned path without `--force`, never overwrites an existing Threat pack file, and leaves Kit-owned paths that already match the tag alone (so `init --flows audit` later adds that flow); use `upgrade` to change tags. `--yes` asks nothing.

The package version matches the Agent-kit Release line: `@mnaimfaizy/agent-kit@1.0.0-beta.1` is published from tag `v1.0.0-beta.1`, with npm provenance.

Full documentation: [Getting started](https://github.com/mnaimfaizy/agent-kit/blob/main/docs/getting-started.md) and [Adopt](https://github.com/mnaimfaizy/agent-kit/blob/main/docs/adopt.md#check-an-adoption-with-doctor).
