## What and why

<!-- One or two sentences. Link the issue: Closes #123 -->

## Checklist

- [ ] `uv run pytest` and `npm test` pass locally
- [ ] `uv run pre-commit run --all-files` is clean
- [ ] Caller-facing change (inputs, secrets, permissions)? Examples and docs updated, and CHANGELOG `[Unreleased]` notes it
- [ ] New shipped path? Added to `scripts/release-snapshot-manifest.txt`
- [ ] Security-relevant? Checked against `docs/security-model.md` (Public-log rule, Verified plan, read confinement)
