# Security model

## Public-log rule

Security finding bodies must never appear in:

- GitHub Actions logs
- uploaded artifacts
- public issue or PR text

## Private delivery

The required sink for successful security-audit runs is a draft GitHub Security Advisory (GHSA). Optional email notifications are additive.

## Consumer ownership

Consumers own their threat pack paths, allowlists, kill switch controls, advisory token, and optional scanner wiring.

## Agent pipeline gates

Plan/implement/review reusable jobs require kill switch + allowlist + trigger-label consumption.

## Verified plan

Implement must use only a verified plan produced by the trusted plan job (trusted author + marker-at-start). Issue/PR text remains untrusted input.

## Runner seam

Runner seam is explicit and narrow:

- v1 live path is Claude Code in GitHub Actions reusable jobs.
- Copilot is an inert restore path (separate docs/contracts), not a second live first-class runner.
- No provider adapter layer is required in v1.

## Private and org support

Public, private, and organization repositories use the same reusable security-audit job and same private sink.
