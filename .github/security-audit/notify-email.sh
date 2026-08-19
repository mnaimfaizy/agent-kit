#!/usr/bin/env bash
set -euo pipefail

REPORT_PATH="${1:-}"
if [[ -z "${REPORT_PATH}" ]]; then
  echo "usage: notify-email.sh <report-path>" >&2
  exit 1
fi

if [[ ! -f "${REPORT_PATH}" ]]; then
  echo "report not found at ${REPORT_PATH}" >&2
  exit 1
fi

if [[ -z "${NOTIFY_EMAIL_TO:-}" || -z "${NOTIFY_EMAIL_FROM:-}" ]]; then
  echo "email notification skipped: missing sender/recipient configuration"
  exit 0
fi

COUNT="$(grep -E '^- \*\*Finding count:\*\* ' "${REPORT_PATH}" | sed -E 's/^- \*\*Finding count:\*\* ([0-9]+)$/\1/' || true)"
if [[ -z "${COUNT}" ]]; then
  COUNT="0"
fi

SUBJECT="Security audit completed (${COUNT} findings)"
BODY="Security audit completed with ${COUNT} Medium+ finding(s). Full details are available in the private draft GHSA."
export SUBJECT BODY

python3 - <<'PY'
import os
import smtplib
from email.message import EmailMessage

to_addr = os.environ.get("NOTIFY_EMAIL_TO", "")
from_addr = os.environ.get("NOTIFY_EMAIL_FROM", "")
host = os.environ.get("NOTIFY_EMAIL_SMTP_HOST", "")
port = int(os.environ.get("NOTIFY_EMAIL_SMTP_PORT", "587"))
username = os.environ.get("NOTIFY_EMAIL_SMTP_USERNAME", "")
password = os.environ.get("NOTIFY_EMAIL_SMTP_PASSWORD", "")
subject = os.environ.get("SUBJECT", "")
body = os.environ.get("BODY", "")

if not host:
    print("email notification skipped: SMTP host is not configured")
    raise SystemExit(0)

msg = EmailMessage()
msg["Subject"] = subject
msg["From"] = from_addr
msg["To"] = to_addr
msg.set_content(body)

with smtplib.SMTP(host, port, timeout=30) as smtp:
    smtp.starttls()
    if username:
        smtp.login(username, password)
    smtp.send_message(msg)

print("email notification sent")
PY
