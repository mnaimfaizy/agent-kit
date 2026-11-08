# @mnaimfaizy/agent-kit

The command-line companion to [Agent-kit](https://github.com/mnaimfaizy/agent-kit): checks a Consumer repository against the Agent-kit tag its Callers pin.

```bash
npx @mnaimfaizy/agent-kit doctor            # local run with your own gh login
npx @mnaimfaizy/agent-kit doctor --ci       # Kit-owned paths and pins only
npx @mnaimfaizy/agent-kit doctor --strict   # warnings fail too
```

- The package holds only code. Kit files are read from the git tag your `uses:` pins name, never bundled.
- `doctor` is read-only. It never changes files or GitHub settings; for anything to fix it prints a `gh` command for you to run.
- No runtime dependencies. Needs Node.js 22 or later, `git`, and (outside `--ci`) `gh` logged in with admin on the repository.
- Tags before `v1.0.0-alpha.11` have no `kit-owned-paths.txt`, and the CLI refuses them: adopt those by hand with that tag's `docs/adopt.md`.
- `init` and `upgrade` are not in this version yet.

The package version matches the Agent-kit Release line: `@mnaimfaizy/agent-kit@1.0.0-alpha.12` is published from tag `v1.0.0-alpha.12`, with npm provenance.

Full documentation: [Getting started](https://github.com/mnaimfaizy/agent-kit/blob/main/docs/getting-started.md) and [Adopt](https://github.com/mnaimfaizy/agent-kit/blob/main/docs/adopt.md#check-an-adoption-with-doctor).
