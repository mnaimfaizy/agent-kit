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

## Private and org support

Public, private, and organization repositories use the same reusable security-audit job and same private sink.
