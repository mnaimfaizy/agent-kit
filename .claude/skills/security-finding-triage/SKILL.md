---
name: security-finding-triage
description: Stress-check one security finding, confirm or reject with evidence, and produce a durable triage outcome for the Consumer ledger/advisory workflow.
disable-model-invocation: true
metadata:
  agent-kit-scope: user
---

# Security finding triage

One finding at a time. Discovery is `security-audit`; broader backlog management belongs to `security-response`.

Outcome shape: [OUTCOME-FORMAT.md](OUTCOME-FORMAT.md)

## Hard rules

1. Never produce weaponized exploit instructions or PoCs.
2. Keep private detail out of public channels.
3. Prefer current-tree evidence (`file:line`) over stale advisory text.
4. Do not open fix PRs unless explicitly requested.

## Process

1. Identify target finding (`concept-id` preferred).
2. Verify the current code path still matches the claim. For a finding from a deep scan, read its `Reproduced` value and Observation as evidence. Triage stays static: never build, run or probe the code to re-check them. Re-attempting a Reproduction on a fix is a Verification run, which the maintainer starts with the `agent-kit deep-scan` launcher, not this skill.
3. Decide outcome:
   - `confirmed`
   - `rejected`
   - `accepted-risk`
   - `duplicate`
4. Emit triage output using `OUTCOME-FORMAT.md`.
5. If a Consumer ledger is in use, update only fingerprint-safe fields there. It is the file the repository's security-audit Caller passes as `findings_ledger_path`; with no Caller, `.security/findings-ledger.md` (the `agent-kit init` default).
