#!/usr/bin/env bash
# Agent-kit setup preset: Node.js from the runner tool cache.
# Copy this file into your Caller's `setup_commands: |` block. Your copy is
# yours to edit; the Kit never overwrites it.
#
# setup_commands runs as one plain `shell: bash` step, so actions such as
# actions/setup-node cannot run here. Instead this picks a Node.js the
# ubuntu-latest image already caches and puts it on $GITHUB_PATH: no download.
set -euo pipefail

NODE_VERSION="22" # major; the newest cached release wins

shopt -s nullglob
cached=("${RUNNER_TOOL_CACHE:-/opt/hostedtoolcache}"/node/"$NODE_VERSION".*/x64)
shopt -u nullglob
if [ "${#cached[@]}" -eq 0 ]; then
  echo "::error::Node.js $NODE_VERSION is not in the runner tool cache. Cached versions:"
  ls "${RUNNER_TOOL_CACHE:-/opt/hostedtoolcache}/node" || true
  exit 1
fi
node_home="$(printf '%s\n' "${cached[@]}" | sort -V | tail -n 1)"

# $GITHUB_PATH reaches later steps (the agent, verify_commands); export for this one.
echo "$node_home/bin" >>"$GITHUB_PATH"
export PATH="$node_home/bin:$PATH"
node --version

# Dependencies. Swap in your own installer (pnpm, yarn, ...).
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
fi
