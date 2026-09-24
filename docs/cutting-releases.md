# Cutting releases

Maintainers cut Agent-kit Releases from the **default branch** only. There is no release-branch workflow, no attached binaries, and no skills zip.

Each tag is a **whole-kit snapshot**: reusable workflows, shipped skills, docs, and the Copilot archive at that commit. Consumers pin `uses: …@<tag>` and copy skills from the same tag.

## Before you cut

- CI is green on `main` (tests, lint, actionlint, links).
- The examples pin the tag you are about to cut (`uses: …@<tag>`). The contract tests require a SemVer tag there, so bump them in the release-prep PR.
- `CHANGELOG.md` has a section for the tag, and `release-notes/<tag>.md` exists when you want a Release body (required for beta, rc, stable).

## Cut a release

The steps below use `<tag>`, e.g. `v1.0.0-alpha.6`. The first cut on this line was `v1.0.0-alpha.1`.

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
- No binaries or skills zip attached to the GitHub Release
- No Marketplace listing

See [Releases](releases.md) for SemVer bump rules and Consumer contract policy.
