#!/usr/bin/env bash
set -euo pipefail

REPORT_PATH="${1:-}"
REPO="${2:-}"

if [[ -z "${REPORT_PATH}" || -z "${REPO}" ]]; then
  echo "usage: publish-draft-advisory.sh <report-path> <owner/repo>" >&2
  exit 1
fi

if [[ ! -f "${REPORT_PATH}" ]]; then
  echo "report not found at ${REPORT_PATH}" >&2
  exit 1
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GITHUB_TOKEN is required" >&2
  exit 1
fi

DATE_UTC="$(date -u +%F)"
SUMMARY="Agent-kit security audit (${DATE_UTC})"
DESCRIPTION="Automated security audit report. Full findings are in this draft advisory body."

# Private delivery sink: required draft GHSA.
# Note: the full report body is uploaded to GHSA only; it is never echoed to logs.
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  "/repos/${REPO}/security-advisories" \
  -f summary="${SUMMARY}" \
  -f description="${DESCRIPTION}" \
  -F severity="medium" \
  -F cvss_vector_string="CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N" \
  -f cwe_ids[]="CWE-693" \
  -F vulnerabilities[]="$(cat "${REPORT_PATH}")" \
  >/tmp/ghsa_create_response.json

GHSA_ID="$(jq -r '.ghsa_id // empty' /tmp/ghsa_create_response.json || true)"
if [[ -z "${GHSA_ID}" ]]; then
  echo "Draft advisory created." >&2
else
  echo "Draft advisory created: ${GHSA_ID}"
fi
