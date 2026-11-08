#!/usr/bin/env bash
# Agent-kit setup preset: Python from the runner tool cache.
# Copy this file into your Caller's `setup_commands: |` block. Your copy is
# yours to edit; the Kit never overwrites it.
#
# setup_commands runs as one plain `shell: bash` step, so actions such as
# actions/setup-python cannot run here. Instead this picks a Python the
# ubuntu-latest image already caches and puts it on $GITHUB_PATH: no download.
set -euo pipefail

PYTHON_VERSION="3.12" # major.minor; the newest cached patch release wins

shopt -s nullglob
cached=("${RUNNER_TOOL_CACHE:-/opt/hostedtoolcache}"/Python/"$PYTHON_VERSION".*/x64)
shopt -u nullglob
if [ "${#cached[@]}" -eq 0 ]; then
  echo "::error::Python $PYTHON_VERSION is not in the runner tool cache. Cached versions:"
  ls "${RUNNER_TOOL_CACHE:-/opt/hostedtoolcache}/Python" || true
  exit 1
fi
python_home="$(printf '%s\n' "${cached[@]}" | sort -V | tail -n 1)"

# $GITHUB_PATH reaches later steps (the agent, verify_commands); export for this one.
echo "$python_home/bin" >>"$GITHUB_PATH"
export PATH="$python_home/bin:$PATH"
python --version

# Dependencies. Swap in your own installer (uv sync, poetry install, ...).
if [ -f requirements.txt ]; then
  python -m pip install --disable-pip-version-check -r requirements.txt
fi
if [ -f requirements-dev.txt ]; then
  python -m pip install --disable-pip-version-check -r requirements-dev.txt
fi
