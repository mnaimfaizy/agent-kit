# Findings ledger

Fingerprints of known findings for the dogfood security audit, so repeat runs dedupe. This file is public: record **only** the concept id, status, and dates — never the attack path, evidence, or location. Full detail lives in the private draft advisory.

| Concept id                                          | Status                  | First seen | Advisory            | Notes                                                                  |
| --------------------------------------------------- | ----------------------- | ---------- | ------------------- | ---------------------------------------------------------------------- |
| `read-confinement-symlink-bypass`                   | released v1.0.0-alpha.6 | 2026-09-24 | GHSA-pwx3-m47m-qfm5 | fixed in 5e35265                                                       |
| `hook-script-writable-by-agent`                     | released v1.0.0-alpha.6 | 2026-09-24 | GHSA-pwx3-m47m-qfm5 | fixed in 80a1940                                                       |
| `implementer-unconfined-reads`                      | released v1.0.0-alpha.6 | 2026-09-24 | GHSA-pwx3-m47m-qfm5 | fixed in 7d6bcd9                                                       |
| `git-prefix-rule-output-write`                      | released v1.0.0-alpha.6 | 2026-09-24 | GHSA-pwx3-m47m-qfm5 | fixed in 1709d76                                                       |
| `caller-command-expression-injection`               | rejected                | 2026-09-24 | GHSA-pwx3-m47m-qfm5 | Caller-owned command runs as its own step, as documented               |
| `extra-allowed-tools-grammar-escape`                | rejected                | 2026-09-24 | GHSA-pwx3-m47m-qfm5 | trusted Caller input; the check prevents argument breakout as designed |
| `changed-file-names-unfenced-in-brief`              | rejected                | 2026-09-24 | GHSA-pwx3-m47m-qfm5 | git escapes control characters in paths; fenced anyway in 97d102b      |
| `audit-missing-fork-guard`                          | released v1.0.0-alpha.6 | 2026-09-24 | GHSA-pwx3-m47m-qfm5 | root cause: full mode accepted head_sha; fixed in b5d2217              |
| `advisory-body-predictable-temp-path`               | rejected                | 2026-09-24 | GHSA-pwx3-m47m-qfm5 | single-use GitHub-hosted runners only; hardened anyway in 97d102b      |
| `smtp-starttls-unverified-context`                  | released v1.0.0-alpha.6 | 2026-09-24 | GHSA-pwx3-m47m-qfm5 | certificate check; fixed in db758f4 (downgrade half rejected)          |
| `gh-body-file-read-bypass`                          | released v1.0.0-alpha.6 | 2026-09-24 | GHSA-pwx3-m47m-qfm5 | found in triage, advisory F11; fixed in 70e2d33                        |
| `implement-verify-runs-agent-code-with-write-creds` | released v1.0.0-alpha.6 | 2026-09-24 | GHSA-8787-cwm5-fvcj | fixed in 492082d                                                       |
| `email-notifier-python-imports-from-workspace`      | released v1.0.0-alpha.6 | 2026-09-24 | GHSA-8787-cwm5-fvcj | fixed in 3ad3f1c                                                       |
| `readonly-bash-auto-approved`                       | confirmed               | 2026-09-25 | n/a                 | below the Medium floor; hardening only, no advisory                    |
| `implementer-push-grant-unrestricted-by-ref`        | rejected                | 2026-09-25 | GHSA-cmmp-gv5v-5x7h | the action's push wrapper refuses flags and refspecs                   |
| `release-refs-unprotected-from-app`                 | confirmed               | 2026-09-25 | GHSA-cmmp-gv5v-5x7h | found in triage of F1; maintainer repository settings                  |
| `project-settings-widen-agent-grants`               | accepted-risk           | 2026-09-25 | GHSA-cmmp-gv5v-5x7h | trusted Consumer config, same tier as Caller inputs; documented        |
| `action-transcript-echoed-to-public-log`            | rejected                | 2026-09-25 | GHSA-cmmp-gv5v-5x7h | run log shows the action hides the transcript                          |
