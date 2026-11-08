---
status: accepted
---

# Distribute the adoption CLI via npm, as code only

Adopters spent most of their time on repository settings rather than files ([#67](https://github.com/mnaimfaizy/agent-kit/issues/67)), so Agent-kit ships an `init` / `upgrade` / `doctor` CLI. We publish it to npm as `@mnaimfaizy/agent-kit`, from its own `cli/package.json` (the root package stays private dev tooling), with no npm runtime dependencies. The package holds only CLI code. `init` and `upgrade` fetch the requested git tag from GitHub and read `kit-owned-paths.txt` from that tag, so the git tag Consumers pin in `uses:` stays the single source of truth for shipped files. The CLI version matches the Release line.

## Considered Options

- **Run the CLI from the cloned tag** (`node /tmp/agent-kit/bin/...`): no new channel to secure, but clumsy to invoke and harder to discover. Rejected in favour of `npx`.
- **`npx github:mnaimfaizy/agent-kit#vX`**: needs no registry, but npx installs the whole repository and runs its lifecycle scripts.
- **Bundle the Kit-owned paths in the npm tarball**: works offline, but creates a second copy of every shipped file, and `--tag` could then only mean "the version you installed".

## Consequences

- npm is a new supply-chain surface. Every version is published from the tag workflow through npm trusted publishing (OIDC, `--provenance`, a protected `npm` environment). The repository never stores a long-lived publish token.
- The **first** version has no provenance. Trusted publishing can only be set up on a package that already exists, so the maintainer publishes it by hand once, with their own interactive `npm login` (two-factor authentication), then `npm logout`. No access token is created. The steps are in `docs/cutting-releases.md`.
- Tags without `kit-owned-paths.txt` (up to `v1.0.0-alpha.10`) are refused rather than handled with a built-in fallback list.
- The CLI writes only local files and never changes GitHub settings. For rulesets, labels, variables and secrets it prints ready-to-run `gh` commands.
