#!/usr/bin/env bash
# Step 1 of a cut: write the release-prep branch for a tag (scripts/release.py prepare).
# Usage: bash scripts/prepare-release.sh --tag <vX.Y.Z[-stage.N]> [--commit|--push|--open-pr]
# See docs/cutting-releases.md.
set -euo pipefail

# Relative paths in the arguments (--notes-file) are relative to where you ran this.
export AGENT_KIT_RELEASE_CWD="$PWD"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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

exec "$PYTHON" scripts/release.py prepare "$@"
