# Cutting releases

Maintainers cut Agent-kit Releases from the **default branch** only. There is no release-branch workflow, no attached binaries, and no skills zip.

Each tag is a **whole-kit snapshot**: reusable workflows, shipped skills, docs, and the Copilot archive at that commit. Consumers pin `uses: …@<tag>` and copy skills from the same tag.

## Before you cut

- CI is green on `main` (tests, lint, actionlint, links).
- The examples pin the tag you are about to cut (`uses: …@<tag>`). The contract tests require a SemVer tag there, so bump them in the release-prep PR.
- `cli/package.json`'s `version` is the tag without its `v` (see [Publishing the CLI to npm](#publishing-the-cli-to-npm)).
- `CHANGELOG.md` has a section for the tag, and `release-notes/<tag>.md` exists when you want a Release body (required for beta, rc, stable).
- The release-prep PR is merged to `main` with the Admin bypass: the `main branch` ruleset lets only the Admin role update `main`. Wait for green CI on the PR first, because the bypass skips the required checks too. See [Branch protection](../CONTRIBUTING.md#branch-protection).

## Cut a release

The steps below use `<tag>`, e.g. `v1.0.0-alpha.11`. The first cut on this line was `v1.0.0-alpha.1`.

1. Ensure `main` (or your default branch) is clean, up to date (`git pull`), and includes every path in `scripts/release-snapshot-manifest.txt`.
2. Verify the snapshot:

   ```bash
   uv run python scripts/verify_release_snapshot.py
   ```

3. Move `[Unreleased]` items in `CHANGELOG.md` into a new section if you want alpha notes (optional for alpha).
4. Dry-run the cut:

   ```bash
   bash scripts/cut-release.sh --tag <tag>
   ```

5. Either create and push the tag yourself (then create the Release in the GitHub UI):

   ```bash
   bash scripts/cut-release.sh --tag <tag> --apply
   git push origin <tag>
   ```

6. Or do it in one step — `--publish` pushes the tag, then creates the GitHub Release on it (still no assets):

   ```bash
   bash scripts/cut-release.sh --tag <tag> --apply --publish --notes-file release-notes/<tag>.md
   ```

   `--notes-file` is optional for alpha and required for beta, rc, and stable.

## Publishing the CLI to npm

Each pushed `v*` tag also publishes `cli/` as `@mnaimfaizy/agent-kit` through [publish-cli.yml](../.github/workflows/publish-cli.yml), with npm trusted publishing: the job's OIDC token is exchanged for a short-lived publish credential, and `npm publish --provenance --access public` links the package to the run. The repository stores no npm token. The package version must equal the tag without its `v`: `cut-release.sh` refuses to tag otherwise, and the workflow checks again before it publishes. So in the release-prep PR, set `cli/package.json`'s `version` to the tag you are about to cut, for example `1.0.0-alpha.12` for `v1.0.0-alpha.12`. Every Release-line tag is published as `latest`, because the line only moves forward.

### One-time setup

Trusted publishing can only be configured on a package that already exists, so the first version is published by hand, without provenance (ADR [0001](adr/0001-distribute-the-cli-via-npm.md)). The maintainer does this once; no agent or workflow does it.

1. **Before you push the first tag that carries `cli/`** (`v1.0.0-alpha.12`), create the `npm` environment in the repository settings (**Settings → Environments → New environment**), add yourself as a **required reviewer**, and limit its deployment tags to `v*`. Every publish then waits for your approval. Without it, the tag's publish run starts at once and fails, because no trusted publisher exists yet.
2. Cut the tag as usual. Its `Publish CLI` run waits on the `npm` environment; leave it waiting.
3. On npmjs.com, create a **granular access token** with read and write access to the `@mnaimfaizy` scope only (publishing a new package needs the scope, not one package), and the shortest expiry offered.
4. Publish the first version from a clean checkout of the tag. The token stays in an environment variable: the temporary npmrc only names the variable (npm expands it), so the token reaches no file, command line, or shell history:

   ```bash
   git switch --detach v1.0.0-alpha.12
   cd cli
   read -rs NPM_BOOTSTRAP_TOKEN && export NPM_BOOTSTRAP_TOKEN
   npmrc="$(mktemp)"
   printf '%s\n' '//registry.npmjs.org/:_authToken=${NPM_BOOTSTRAP_TOKEN}' > "$npmrc"
   npm publish --access public --tag latest --userconfig "$npmrc"
   rm -f "$npmrc"; unset NPM_BOOTSTRAP_TOKEN
   ```

5. **Revoke the token straight after**, on npmjs.com (**Access Tokens → Delete**).
6. Reject the waiting `Publish CLI` run for this tag: the version is already published.
7. On the package's npmjs.com settings, add a **trusted publisher**: GitHub Actions, organization or user `mnaimfaizy`, repository `agent-kit`, workflow `publish-cli.yml`, environment `npm`. Then, under publishing access, require two-factor authentication and disallow tokens, so only the trusted publisher can publish.

From the next tag on, approve the waiting `Publish CLI` run and it publishes with provenance. Check it with `npm view @mnaimfaizy/agent-kit@<version> dist.attestations`.

## Release notes and changelog shape

User-facing notes summarize contract-impacting changes — not a raw commit dump.

| Stage      | GitHub Release body | `CHANGELOG.md` section |
| ---------- | ------------------- | ---------------------- |
| **alpha**  | Optional            | Optional               |
| **beta**   | Required            | Required               |
| **rc**     | Required            | Required               |
| **stable** | Required            | Required               |

### Alpha (notes optional)

```markdown
## [1.0.0-alpha.1] - YYYY-MM-DD

### Added

- First public Agent-kit snapshot: security-audit and plan-implement-review flows, four portable skills, Adopt/Releases docs, Copilot inert archive.
```

### Beta / rc / stable (notes required)

```markdown
## [1.0.0-beta.1] - YYYY-MM-DD

### Added

- …

### Changed

- …

### Fixed

- …
```

Pass a notes file when cutting beta, rc, or stable tags:

```bash
bash scripts/cut-release.sh --tag v1.0.0-beta.1 --apply --publish --notes-file release-notes/v1.0.0-beta.1.md
```

## A tag turned out broken

Never move, delete, or re-push a tag: Consumers may already pin it. Instead:

1. Fix on `main` and cut the next tag.
2. Add the broken tag to the table in [Releases → Broken releases](releases.md#broken-releases) and say so in the CHANGELOG.
3. Edit the broken tag's GitHub Release body to point at the fix (`gh release edit <tag> --notes-file …`).

## Stage order

On a given target `X.Y.Z`: **alpha → beta → rc → stable**. Do not move backward. Counters reset per stage (`-alpha.1`, `-alpha.2`, … then `-beta.1`, …).

## What is not part of a cut

- No release branch
- No floating `v1` or `v1.0` tags
- No binaries or skills zip attached to the GitHub Release (the npm package holds CLI code only)
- No Marketplace listing

See [Releases](releases.md) for SemVer bump rules and Consumer contract policy.
