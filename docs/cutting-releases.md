# Cutting releases

Maintainers cut Agent-kit Releases from the **default branch** only. There is no release-branch workflow, no attached binaries, and no skills zip.

Each tag is a **whole-kit snapshot**: reusable workflows, shipped skills, docs, and the Copilot archive at that commit. Consumers pin `uses: …@<tag>` and copy skills from the same tag.

## First cut: `v1.0.0-alpha.1`

When the kit is ready for its first public Pre-release:

1. Ensure `main` (or your default branch) is clean and includes every path in `scripts/release-snapshot-manifest.txt`.
2. Verify the snapshot:

   ```bash
   python scripts/verify_release_snapshot.py
   ```

3. Move `[Unreleased]` items in `CHANGELOG.md` into a new section if you want alpha notes (optional for alpha).
4. Dry-run the cut:

   ```bash
   bash scripts/cut-release.sh --tag v1.0.0-alpha.1
   ```

5. Create the tag locally:

   ```bash
   bash scripts/cut-release.sh --tag v1.0.0-alpha.1 --apply
   git push origin v1.0.0-alpha.1
   ```

6. Optionally publish the GitHub Release (still no assets):

   ```bash
   bash scripts/cut-release.sh --tag v1.0.0-alpha.1 --apply --publish
   ```

   Or create the Release manually in GitHub after pushing the tag.

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

## Stage order

On a given target `X.Y.Z`: **alpha → beta → rc → stable**. Do not move backward. Counters reset per stage (`-alpha.1`, `-alpha.2`, … then `-beta.1`, …).

## What is not part of a cut

- No release branch
- No floating `v1` or `v1.0` tags
- No binaries or skills zip attached to the GitHub Release
- No Marketplace listing

See [Releases](releases.md) for SemVer bump rules and Consumer contract policy.
