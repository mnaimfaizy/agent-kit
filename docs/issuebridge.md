# Issuebridge reference Consumer

Issuebridge is the first real **Consumer** of Agent-kit — the source of the current flows and the product that keeps the threat pack, glossary, and product CI. This page is **target state + stand-up checklist** only. It does not perform the extract or order PRs.

Companion-library skills already in Issuebridge stay in-tree until Issuebridge chooses otherwise. The named library is **[Matt Pocock's skills](https://github.com/mattpocock/skills)**; Agent-kit does not own Issuebridge's copies. See [README](../README.md) and [Adopt](adopt.md).

---

## Keeps (Consumer-only)

- Threat pack + findings ledger
- `CONTEXT.md`, `AGENTS.md`
- `commit`, `release`, `help-coverage` (+ help-coverage script)
- Product CI / Windows release workflows
- `docs/security-response.md`, `SECURITY.md`, `docs/agent-pipeline-pilot.md`
- Allowlists, trigger labels, secrets, model pins
- Verify commands (`npm` lint/typecheck, `src-tauri` clippy/fmt)
- Caller workflows (thin `uses:` wrappers)
- In-tree Companion skills (`implement`, `wayfinder`, …) and `ask-matt`

## Imports from Agent-kit

- `code-review` + security-audit / finding-triage / security-response → copy into `.claude/skills/`
- Caller workflows `uses: <owner>/agent-kit/.github/workflows/<file>@<semver-tag>`
- Dependabot `github-actions` on those refs

## Copilot

Stays **inert** (Issuebridge archive and/or kit archived copy). Restore-instead-of-Claude only — not Agentic Workflows. Kit contracts still apply if restored. See [Copilot restore](copilot-restore.md).

## Stand-up checklist (later extract)

1. Pin kit SemVer tags on Callers; enable Dependabot for `github-actions`.
2. Copy kit skills into `.claude/skills/` at the **same tag** as the Caller `uses:` pin, and copy `.github/agent-runtime/`, `.github/security-audit/`, and `.github/agent-pipeline/` from that tag. Keep the threat pack and ledger on Issuebridge paths passed into the audit Caller.
3. Keep kill switches, allowlists, labels, `CLAUDE_CODE_OAUTH_TOKEN`, advisories-write token, optional Resend.
4. Pass Issuebridge verify commands into the implement Caller.
5. Do not run Claude and Copilot generations together.
6. Leave Companion skill copies in `.agents/skills/` unless a later effort switches to the named Companion library.
