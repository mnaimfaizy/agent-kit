# Security policy

## Report a vulnerability

Agent-kit vulnerabilities must be reported privately using a draft GitHub Security Advisory (GHSA).

- Do not open a public GitHub issue for vulnerability reports.
- Keep finding details out of public logs, issue threads, and artifacts.

## What is and is not a kit vulnerability

Consumer audit findings are not automatically Agent-kit bugs.

Treat a finding as a kit vulnerability only when root cause is in reusable kit assets, such as:

- a reusable Agent-kit job body, or
- a kit-shipped skill/procedure.

If the root cause is in Consumer-specific assets (for example threat pack content, repository configuration, or product code), it should stay with the Consumer repository and not be tracked as an Agent-kit vulnerability.
