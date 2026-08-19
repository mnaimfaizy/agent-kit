# Agent-kit

A reusable kit of agent skills, sub-agents, and GitHub Actions — the Consumer keeps the product-specific pack.

## Portable skills (v1)

Agent-kit currently ships four portable skills in `.claude/skills/`:

- `code-review`
- `security-audit` (with `report-format.md`)
- `security-finding-triage` (with `OUTCOME-FORMAT.md`)
- `security-response` (with `STATUS-FORMAT.md`)

Consumer setup is copy-based:

1. Copy those four folders into your repository at `.claude/skills/`.
2. Invoke them by name from your agent session.

Not vendored in Agent-kit:

- Consumer threat pack assets (such as `threat-model.md` and findings ledger files)
- Product playbooks
- Companion procedure skills (for example `implement`, `wayfinder`, `tdd`, `to-spec`)
- Native subagent definitions and Codex sidecar files

## Security-audit flow

The reusable security-audit First-class flow ships in:

- `.github/workflows/security-audit-reusable.yml`
- `.github/security-audit/` (prompt and helper scripts)
- `examples/security-audit-caller.yml` (Caller invocation pattern)
- `docs/security-audit.md` and `docs/security-model.md`

## Plan-implement-review flow

The reusable plan -> implement -> review First-class flow ships in:

- `.github/workflows/agent-plan-reusable.yml`
- `.github/workflows/agent-implement-reusable.yml`
- `.github/workflows/agent-review-reusable.yml`
- `.github/agent-pipeline/` (planner + implementer contracts and helper script)
- `examples/plan-implement-review-caller.yml`
- `docs/plan-implement-review.md`

## Security

Report kit vulnerabilities privately through GitHub Security Advisories. Do not open public issues for vulnerabilities. See `SECURITY.md`.

## License

This project is licensed under the MIT License. See `LICENSE`.
