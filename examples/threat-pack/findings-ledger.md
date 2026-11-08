# Findings ledger

Fingerprints of known security findings, so repeat audits skip what is already known (`findings_ledger_path` in the security audit Caller). Each finding the audit reports carries a **concept id**, a stable kebab-case name; the `security-finding-triage` skill updates the row after triage.

This file is committed and may be public. Record **only** the concept id, status, dates, advisory id and a short note. Never the attack path, evidence, file location or exploit detail: those stay in the private draft advisory.

> Skeleton from Agent-kit's `examples/threat-pack/`. This copy is yours. Replace the example row with your first real finding, or leave the table empty.

Status values: `open`, `confirmed`, `fixed`, `released <tag>`, `rejected`, `accepted-risk`, `duplicate`.

| Concept id                     | Status   | First seen | Advisory | Notes                                              |
| ------------------------------ | -------- | ---------- | -------- | -------------------------------------------------- |
| `example-concept-id-to-delete` | rejected | 2026-01-01 | n/a      | example row; delete it with the first real finding |
