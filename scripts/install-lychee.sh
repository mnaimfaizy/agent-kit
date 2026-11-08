#!/usr/bin/env bash
# Install the lychee link checker for CI, pinned by version and SHA-256.
#
# Replaces lycheeverse/lychee-action, whose single curl download (no retry)
# failed on GitHub-hosted runners with exit code 22. github.com's release
# download path can return 504 for minutes at a time while api.github.com
# keeps working, so this downloads through the REST API first and falls back
# to the github.com URL, retrying each. The archive is checked against the
# pinned SHA-256 before anything is extracted, whichever path served it.
#
# Set GH_TOKEN (the job's github.token is enough) to avoid the API's
# unauthenticated rate limit. It is sent through curl's config on stdin, never
# on the command line or in the log.
#
# To bump: change LYCHEE_VERSION, LYCHEE_SHA256 and LYCHEE_ASSET_ID together:
#   gh api repos/lycheeverse/lychee/releases/tags/lychee-v<version> \
#     --jq '.assets[] | select(.name=="lychee-x86_64-unknown-linux-gnu.tar.gz") | "\(.id) \(.digest)"'
set -euo pipefail

LYCHEE_VERSION="0.24.2"
LYCHEE_SHA256="1f4e0ef7f6554a6ed33dd7ac144fb2e1bbed98598e7af973042fc5cd43951c9a"
LYCHEE_ASSET_ID="409959156"
ASSET="lychee-x86_64-unknown-linux-gnu.tar.gz"
API_URL="https://api.github.com/repos/lycheeverse/lychee/releases/assets/${LYCHEE_ASSET_ID}"
WEB_URL="https://github.com/lycheeverse/lychee/releases/download/lychee-v${LYCHEE_VERSION}/${ASSET}"

dest="${RUNNER_TEMP:?RUNNER_TEMP is not set; run this in GitHub Actions}/lychee"
rm -rf "$dest"
mkdir -p "$dest"
archive="$dest/$ASSET"

# Retries transient failures (5xx, timeouts, resets) for up to ~2 minutes.
CURL_RETRY=(--fail --silent --show-error --location
  --retry 8 --retry-all-errors --retry-delay 10 --retry-max-time 120
  --connect-timeout 20 --max-time 120)

download_via_api() {
  local config=""
  if [[ -n "${GH_TOKEN:-}" ]]; then
    config="header = \"Authorization: Bearer ${GH_TOKEN}\""
  fi
  printf '%s\n' "$config" | curl "${CURL_RETRY[@]}" --config - \
    --header "Accept: application/octet-stream" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    --output "$archive" "$API_URL"
}

download_via_web() {
  curl "${CURL_RETRY[@]}" --output "$archive" "$WEB_URL"
}

if download_via_api; then
  echo "Downloaded lychee ${LYCHEE_VERSION} through api.github.com."
elif download_via_web; then
  echo "Downloaded lychee ${LYCHEE_VERSION} through github.com (API download failed)."
else
  echo "::error::Could not download lychee ${LYCHEE_VERSION} from api.github.com or github.com."
  exit 1
fi

echo "${LYCHEE_SHA256}  $archive" | sha256sum --check --strict -

# The archive holds one top-level folder; take only the binary from it.
tar -xzf "$archive" -C "$dest" --strip-components=1 --wildcards '*/lychee'
rm -f "$archive"

"$dest/lychee" --version
echo "$dest" >>"${GITHUB_PATH:?GITHUB_PATH is not set; run this in GitHub Actions}"
