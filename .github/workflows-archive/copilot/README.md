# Archived Copilot runner (inert)

This folder preserves a generalized Copilot runner archive for optional restore.
Files here are intentionally inert because they are outside `.github/workflows/`.

## Scope

- `agent-pipeline.yml` (plan + implement)
- `agent-pipeline-review.yml` (on-demand three-axis review)
- `security-audit.yml` (private GHSA delivery path)
- `copilot-setup-steps.yml` (optional environment setup)
- `prompts/` (Copilot-specific prompt pack fork)

## Important contract notes

- This archive is a restore path, not a second live first-class runner.
- Restore is choose-one with Claude callers. Archive Claude callers first.
- Kill-switch names intentionally differ from Claude naming to prevent accidental dual enablement.
- Restored flow still follows kit contracts: trusted verified plan, draft PR only, no workflow edits, no auto-fix loop, counts-only public audit comments.

## Inert by design

GitHub executes workflow YAML only from `.github/workflows/` on the default branch.
Keeping this archive in `.github/workflows-archive/copilot/` ensures no triggers run.
