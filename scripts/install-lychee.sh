#!/usr/bin/env bash
# Install the lychee link checker for CI, pinned by version and SHA-256.
#
# Replaces lycheeverse/lychee-action, whose single curl download (no retry)
# failed intermittently on GitHub-hosted runners with exit code 22. This
# retries transient errors, verifies the archive before extracting anything,
# and puts the binary on $GITHUB_PATH for later steps.
#
# To bump: change LYCHEE_VERSION and LYCHEE_SHA256 together, taking the digest
# from the release's lychee-x86_64-unknown-linux-gnu.tar.gz.sha256 asset.
set -euo pipefail

LYCHEE_VERSION="0.24.2"
LYCHEE_SHA256="1f4e0ef7f6554a6ed33dd7ac144fb2e1bbed98598e7af973042fc5cd43951c9a"
ASSET="lychee-x86_64-unknown-linux-gnu.tar.gz"
URL="https://github.com/lycheeverse/lychee/releases/download/lychee-v${LYCHEE_VERSION}/${ASSET}"

dest="${RUNNER_TEMP:?RUNNER_TEMP is not set; run this in GitHub Actions}/lychee"
rm -rf "$dest"
mkdir -p "$dest"

curl --fail --silent --show-error --location \
  --retry 5 --retry-all-errors --retry-delay 5 --connect-timeout 20 --max-time 120 \
  --output "$dest/$ASSET" "$URL"

echo "${LYCHEE_SHA256}  $dest/$ASSET" | sha256sum --check --strict -

# The archive holds one top-level folder; take only the binary from it.
tar -xzf "$dest/$ASSET" -C "$dest" --strip-components=1 --wildcards '*/lychee'
rm -f "$dest/$ASSET"

"$dest/lychee" --version
echo "$dest" >>"${GITHUB_PATH:?GITHUB_PATH is not set; run this in GitHub Actions}"
