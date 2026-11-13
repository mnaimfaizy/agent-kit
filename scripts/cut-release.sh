#!/usr/bin/env bash
# Step 2 of a cut: tag the default branch and push the tag (scripts/release.py cut).
# Usage: bash scripts/cut-release.sh --tag <vX.Y.Z[-stage.N]> [--apply [--publish]]
#
# Default is a dry run: every check, nothing written. --apply creates the
# annotated tag locally, or reuses a valid unpushed one. --publish (with
# --apply) pushes it; the push starts publish-cli.yml, which creates the GitHub
# Release from release-notes/<tag>.md and publishes the npm CLI. Safe to re-run
# after a failure at any point. See docs/cutting-releases.md.
set -euo pipefail

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

exec "$PYTHON" scripts/release.py cut "$@"
