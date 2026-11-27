# Agent-kit: agent instructions

How to work on Agent-kit itself: see [CONTRIBUTING.md](CONTRIBUTING.md). Vocabulary: [GLOSSARY.md](GLOSSARY.md).

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `mnaimfaizy/agent-kit`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage roles, each label equal to its role name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Docs map

Doc pages for each code area. See `docs/agents/docs-map.md`.

### Antigravity permissions

Repository `PreToolUse` command policy (`.agents/hooks.json`, `.agents/command-policy.mjs`) and native Antigravity permission template (`.agents/permissions.example.json`). See `docs/agents/antigravity-permissions.md`.
