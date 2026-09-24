#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAG=""
APPLY=0
PUBLISH=0
NOTES_FILE=""

usage() {
  cat <<'EOF'
Usage: scripts/cut-release.sh --tag <vX.Y.Z[-stage.N]> [options]

Cut an Agent-kit whole-kit Release from the default branch.
Default is dry-run: verifies the snapshot and prints the planned steps.

Options:
  --tag <tag>           Required SemVer tag (example: v1.0.0-alpha.1)
  --apply               Create the annotated git tag locally
  --publish             Also push the tag and create the GitHub Release (requires --apply and gh)
  --notes-file <path>   Release notes body for beta/rc/stable (required then)
  -h, --help            Show this help

No release branch. No attached binaries or skills zip.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --publish)
      PUBLISH=1
      shift
      ;;
    --notes-file)
      NOTES_FILE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$TAG" ]]; then
  echo "Missing --tag. Example first cut: v1.0.0-alpha.1" >&2
  usage
  exit 1
fi

# Pick the first interpreter that actually runs, not just one on PATH: on
# Windows, `python3` can be the Microsoft Store stub, which exists but fails.
PYTHON=""
for candidate in python3 python; do
  if "$candidate" -c 'import sys' >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
if [[ -z "$PYTHON" ]]; then
  echo "Python is required: neither python3 nor python runs on PATH." >&2
  exit 1
fi

"$PYTHON" scripts/verify_release_snapshot.py

DEFAULT_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)"
if [[ -z "$DEFAULT_BRANCH" ]]; then
  DEFAULT_BRANCH="main"
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$DEFAULT_BRANCH" ]]; then
  echo "Refusing to cut from branch '$CURRENT_BRANCH'; use '$DEFAULT_BRANCH'." >&2
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag already exists: $TAG" >&2
  exit 1
fi

"$PYTHON" - <<PY
import sys
from pathlib import Path
sys.path.insert(0, str(Path("scripts").resolve()))
from verify_release_snapshot import notes_required_for_tag, parse_tag

tag = "$TAG"
if parse_tag(tag) is None:
    print(f"Invalid tag format: {tag}", file=sys.stderr)
    sys.exit(1)
if notes_required_for_tag(tag) and not Path("${NOTES_FILE}").is_file():
    print("Release notes are required for beta, rc, and stable tags.", file=sys.stderr)
    print("Pass --notes-file or skip notes for alpha.", file=sys.stderr)
    sys.exit(1)
PY

if [[ "$APPLY" -eq 0 ]]; then
  echo "Dry run OK for $TAG on $DEFAULT_BRANCH."
  echo "Next: move [Unreleased] in CHANGELOG.md if needed, then rerun with --apply."
  if [[ "$PUBLISH" -eq 1 ]]; then
    echo "Note: --publish is ignored until --apply is set."
  fi
  exit 0
fi

if [[ "$PUBLISH" -eq 1 ]] && ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required for --publish." >&2
  exit 1
fi

git tag -a "$TAG" -m "Release $TAG"
echo "Created annotated tag $TAG locally."

if [[ "$PUBLISH" -eq 0 ]]; then
  echo "Push the tag: git push origin $TAG"
  exit 0
fi

# Push first so the Release attaches to this exact annotated tag instead of
# gh creating a lightweight one from the remote default branch.
git push origin "$TAG"

PRERELEASE_FLAG=()
if [[ "$TAG" == *"-alpha."* || "$TAG" == *"-beta."* || "$TAG" == *"-rc."* ]]; then
  PRERELEASE_FLAG=(--prerelease)
fi

if [[ -n "$NOTES_FILE" ]]; then
  gh release create "$TAG" "${PRERELEASE_FLAG[@]}" --verify-tag --title "$TAG" --notes-file "$NOTES_FILE"
else
  gh release create "$TAG" "${PRERELEASE_FLAG[@]}" --verify-tag --title "$TAG" --notes "Pre-release $TAG"
fi

echo "Published GitHub Release $TAG (no assets attached)."
