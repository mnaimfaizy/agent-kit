# Releases

Agent-kit releases are whole-kit snapshots, not partial artifacts.

## Release identity

- Tag form: `vX.Y.Z` or `vX.Y.Z-<stage>.N`
- First public stable line starts at `v1.0.0` (no `0.x`)
- Every tag is immutable and represents the full kit:
  - reusable workflows
  - shipped skills
  - docs
  - Copilot archive assets (when present)

Each release is paired with a GitHub Release entry.

## What is intentionally not shipped

- no floating major/minor tags (no moving `v1` or `v1.2`)
- no binaries
- no skills zip bundle
- no Marketplace listing

## SemVer policy (consumer contract first)

One SemVer line covers both workflows and skills.
The strongest Consumer-facing change determines the bump.

- **Major**: Consumer contract break (required caller changes, renamed workflow path, removed input/output, required new permission/secret, incompatible workflow/skill contract).
- **Minor**: additive capability that keeps old callers and copied skills working (new optional input, new reusable job, additive skill section).
- **Patch**: fixes/polish with no contract break.

## Pre-release stages

Pre-release suffixes:

- `-alpha.N`
- `-beta.N`
- `-rc.N`

Stage order for one target version is:

`alpha -> beta -> rc -> stable`

Do not move backward within a target version.

## Notes and changelog requirements

- Stable, beta, and rc releases require user-facing release notes.
- Alpha release notes are optional.
- `CHANGELOG.md` must include an entry for each stable, beta, and rc release.
- Notes summarize contract-impacting changes; they are not a raw commit dump.

## Broken releases

Tags are never moved or deleted, even when broken. A fix ships as the next tag, and the CHANGELOG plus the GitHub Release body of the broken tag say so.

| Tag              | Status | Reason                                                                                          | Use instead      |
| ---------------- | ------ | ----------------------------------------------------------------------------------------------- | ---------------- |
| `v1.0.0-alpha.1` | Broken | Reusable workflows declare the reserved `github_token` secret; the audit also had a YAML error. | `v1.0.0-alpha.3` |
| `v1.0.0-alpha.2` | Broken | Reserved `github_token` secret; invalid `vulnerability-alerts` permission in the audit.         | `v1.0.0-alpha.3` |

## Cutting a release

Maintainers cut tags from the default branch using `docs/cutting-releases.md` and `scripts/cut-release.sh`. The first public Pre-release on the `1.0.0` line was `v1.0.0-alpha.1`.
