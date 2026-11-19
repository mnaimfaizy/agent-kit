# Findings ledger

Fingerprints of known security findings, so repeat audits skip what is already known (`findings_ledger_path` in the security audit Caller). Each finding the audit reports carries a **concept id**, a stable kebab-case name. Only a Security Response Run's `close` (the `security-response` skill) writes it, once the response is done, or the maintainer, by hand: `security-finding-triage` never edits it.

This file is committed and may be public. Record **only** the concept id, status, dates, advisory id and a short note. Never the attack path, evidence, file location or exploit detail: those stay in the private draft advisory.

> Skeleton from Agent-kit's `examples/threat-pack/`. This copy is yours. Delete the example row by hand before your first real line, or leave the table empty: `close` only appends lines, and never edits or removes one.

Status values: `released <tag>`, `fixed`, `accepted-risk`, `rejected`.

These are the values `close` writes. A duplicate is written `rejected`, its Notes naming the concept id it duplicates.

| Concept id                     | Status   | First seen | Advisory | Notes                                              |
| ------------------------------ | -------- | ---------- | -------- | -------------------------------------------------- |
| `example-concept-id-to-delete` | rejected | 2026-01-01 | n/a      | example row; delete it with the first real finding |
