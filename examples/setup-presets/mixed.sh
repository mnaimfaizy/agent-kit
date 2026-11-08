#!/usr/bin/env bash
# Agent-kit setup preset: Python and Node.js from the runner tool cache.
# Copy this file into your Caller's `setup_commands: |` block. Your copy is
# yours to edit; the Kit never overwrites it.
#
# setup_commands runs as one plain `shell: bash` step, so actions such as
# actions/setup-python and actions/setup-node cannot run here. Instead this
# picks versions the ubuntu-latest image already caches and puts them on
# $GITHUB_PATH: no download.
set -euo pipefail

PYTHON_VERSION="3.12" # major.minor; the newest cached patch release wins
NODE_VERSION="22"     # major; the newest cached release wins

# use_cached TOOL VERSION: put the newest cached TOOL VERSION.x on PATH for
# this step and, through $GITHUB_PATH, for later steps (the agent, verify_commands).
use_cached() {
  local tool="$1" version="$2" home
  local cache="${RUNNER_TOOL_CACHE:-/opt/hostedtoolcache}"
  local cached=()
  shopt -s nullglob
  cached=("$cache/$tool/$version".*/x64)
  shopt -u nullglob
  if [ "${#cached[@]}" -eq 0 ]; then
    echo "::error::$tool $version is not in the runner tool cache. Cached versions:"
    ls "$cache/$tool" || true
    exit 1
  fi
  home="$(printf '%s\n' "${cached[@]}" | sort -V | tail -n 1)"
  echo "$home/bin" >>"$GITHUB_PATH"
  export PATH="$home/bin:$PATH"
}

use_cached Python "$PYTHON_VERSION"
use_cached node "$NODE_VERSION"
python --version
node --version

# Dependencies. Swap in your own installers.
if [ -f requirements.txt ]; then
  python -m pip install --disable-pip-version-check -r requirements.txt
fi
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
fi
