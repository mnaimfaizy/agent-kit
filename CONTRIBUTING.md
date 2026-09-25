# Contributing

How to work on Agent-kit itself. To _use_ the kit, see [docs/getting-started.md](docs/getting-started.md). Vocabulary: [CONTEXT.md](CONTEXT.md).

## Setup

Requirements: [uv](https://docs.astral.sh/uv/) ≥ 0.9, Node.js ≥ 22 (`.nvmrc` pins the CI version), Git, and optionally Docker (for running actionlint the way CI does).

```bash
uv sync                      # Python 3.12 venv + pytest, pyyaml, ruff, pre-commit
npm ci                       # prettier
uv run pre-commit install    # run the lint hooks on every commit
```

On Windows, work in Git Bash. `.gitattributes` forces LF working copies; a CRLF `*.sh` breaks bash on the runner and fails CI.

## Checks

Everything CI runs, locally:

| Check                    | Command                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| Python contract tests    | `uv run pytest`                                                       |
| Node contract tests      | `npm test`                                                            |
| Release snapshot paths   | `uv run python scripts/verify_release_snapshot.py`                    |
| Workflow reference fresh | `uv run python scripts/gen_workflow_reference.py --check`             |
| Python lint / format     | `uv run ruff check .` · `uv run ruff format --check .`                |
| Markdown / YAML / JSON   | `npx prettier --check .` (fix: `npm run format`)                      |
| Shell                    | `shellcheck` on `git ls-files '*.sh'` (pre-commit bundles it)         |
| Workflows                | `actionlint` (pre-commit bundles it; CI uses the digest-pinned image) |
| All lint hooks at once   | `uv run pre-commit run --all-files`                                   |

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs three jobs on every PR and push to `main`: **Tests**, **Lint and format**, **Internal links**. External links are checked weekly by [links.yml](.github/workflows/links.yml), which opens a tracking issue on failure.

## Repository layout

| Path                                         | What                                                  |
| -------------------------------------------- | ----------------------------------------------------- |
| `.github/workflows/*-reusable.yml`           | The product: reusable job bodies Consumers reference. |
| `.github/workflows/dogfood-*.yml`            | This repository as its own Caller (off by default).   |
| `.github/workflows/ci.yml`, `links.yml`      | This repository's CI.                                 |
| `.github/agent-*`, `.github/security-audit/` | Runtime files Consumers copy.                         |
| `.github/CODEOWNERS`                         | Review owners for kit-critical paths.                 |
| `.claude/skills/`                            | Portable skills Consumers copy.                       |
| `examples/`                                  | Caller templates.                                     |
| `scripts/*.test.py`, `*.test.mjs`            | Contract tests.                                       |
| `scripts/gen_workflow_reference.py`          | Generates `docs/reference.md` from the workflows.     |
| `security/`                                  | This repository's own Threat pack (dogfood audit).    |

## Contract tests

The tests are contracts, not unit tests: they pin behavior a Consumer depends on (inputs, gates, the Public-log rule, doc promises). When you change a workflow or doc:

- If a test fails, decide whether the contract changed. If it did, update the test **and** the CHANGELOG `[Unreleased]` section, and classify the bump per [docs/releases.md](docs/releases.md).
- New test files follow the existing shape: `scripts/<area>-contract.test.py`, plain `assert`s, and an `if __name__ == "__main__":` block calling each test so the file also runs with plain `python`.
- `workflow-validity-contract.test.py` covers what GitHub rejects at load time but actionlint misses (reserved secret names, undeclared secrets, invalid permission scopes, Caller/reusable mismatches). Keep it passing; a failure there means Consumers get "Invalid workflow file".
- Changed a reusable workflow's inputs, secrets, or permissions? Regenerate the reference:

  ```bash
  uv run python scripts/gen_workflow_reference.py && npx prettier --write docs/reference.md
  ```

- New shipped path? Add it to `scripts/release-snapshot-manifest.txt`.

## Action and dependency pins

- Every `uses:` in `.github/workflows/` is pinned to a full commit SHA with a `# vX.Y.Z` comment. Dependabot bumps them weekly.
- `anthropics/claude-code-action` is excluded from Dependabot and asserted by the contract tests. To bump it: read its release notes, update the SHA in all four reusable workflows and in `CLAUDE_ACTION_SHA` in the tests, and note it in the CHANGELOG.
- The actionlint image in `ci.yml` is pinned by digest; update the tag and digest together.
- Keep `.pre-commit-config.yaml` hook versions in step with `uv.lock` (ruff) and CI.

## Dogfood flows

`dogfood-security-audit.yml` and `dogfood-agent-pipeline.yml` run this repository's own reusable workflows from the same commit (`uses: ./…`), so changes are exercised before they are tagged. Both stay off until you enable them.

One-time setup:

```bash
# Secrets (paste values when prompted)
gh secret set CLAUDE_CODE_OAUTH_TOKEN              # from `claude setup-token`
gh secret set AGENT_KIT_ADVISORIES_TOKEN           # fine-grained PAT: Repository security advisories RW
gh secret set AGENT_KIT_DEPENDABOT_ALERTS_TOKEN    # optional; fine-grained PAT: Dependabot alerts R

# Labels
gh label create "agent:plan"      --color 1D76DB --description "Agent-kit: plan this issue"
gh label create "agent:implement" --color 0E8A16 --description "Agent-kit: implement the Verified plan"
gh label create "agent:review"    --color 5319E7 --description "Agent-kit: review this PR"
gh label create "agent:audit"     --color B60205 --description "Agent-kit: security audit this PR"

# Turn on
gh variable set CLAUDE_SECURITY_AUDIT_ENABLED --body true
gh variable set CLAUDE_PIPELINE_ENABLED --body true

# Optional: model for every dogfood run (default claude-opus-5), and a
# per-flow override: CLAUDE_MODEL_PLAN, _IMPLEMENT, _REVIEW, or _AUDIT
gh variable set CLAUDE_MODEL --body claude-opus-5-5
gh variable set CLAUDE_MODEL_AUDIT --body claude-fable-5-1
```

Also: install the [Claude GitHub App](https://github.com/apps/claude) on the repository (implementer) (see [getting-started §7](docs/getting-started.md#7-prepare-the-security-audit) for the audit). Review [security/threat-model.md](security/threat-model.md) before the first audit; it is a draft.

The Allowlist in both dogfood Callers is `mnaimfaizy`; edit it to add maintainers.

## Branch protection

Require CI before merging to `main` (run once; needs admin):

```bash
gh api -X PUT repos/mnaimfaizy/agent-kit/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["Tests", "Lint and format", "Internal links"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

The payload deliberately leaves `required_pull_request_reviews` at `null`: while `@mnaimfaizy` is the sole owner in [.github/CODEOWNERS](.github/CODEOWNERS), requiring any approving review (with or without `require_code_owner_reviews`) would block the maintainer's own PRs, since GitHub never counts a PR author as a reviewer. Merging would then require an admin bypass.

Two rulesets keep the implementer's Claude GitHub App token, which code run through `extra_allowed_tools` can use, away from `main` and the release tags. Only the Admin role bypasses them, so `cut-release.sh` still tags. The `main branch` ruleset (id `23917207`) blocks deletion and force pushes and requires a pull request with zero approvals, which the maintainer's own PRs satisfy:

```bash
gh api -X PUT repos/mnaimfaizy/agent-kit/rulesets/23917207 --input - <<'EOF'
{"name":"main branch","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH","refs/heads/main"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},
  {"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false}}],
 "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}]}
EOF
```

The `release tags` ruleset blocks creating, moving, or deleting a `v*` tag:

```bash
gh api -X POST repos/mnaimfaizy/agent-kit/rulesets --input - <<'EOF'
{"name":"release tags","target":"tag","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},
 "rules":[{"type":"creation"},{"type":"update"},{"type":"deletion"}],
 "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}]}
EOF
```

## Pull requests

- Branch from `main`; use [Conventional Commits](https://www.conventionalcommits.org/) (`fix:`, `feat:`, `ci:`, `docs:`, `chore:`).
- Fill in the PR template checklist. Add an `[Unreleased]` CHANGELOG line for anything a Consumer would notice.
- Security issues: never in a public PR or issue. See [SECURITY.md](SECURITY.md).
- Changes under the paths in [.github/CODEOWNERS](.github/CODEOWNERS) — everything in `.github/workflows/`, the runtime files, Portable skills, and Caller templates Consumers copy, `scripts/`, this repository's Threat pack, and the review/dependency routing files — request review from the maintainer once the PR is marked ready for review (draft PRs, including every pipeline PR, request no one until then).

## Releasing

See [docs/cutting-releases.md](docs/cutting-releases.md). In short, after the release-prep PR merges:

```bash
git switch main && git pull
bash scripts/cut-release.sh --tag v1.0.0-alpha.7                 # dry run
bash scripts/cut-release.sh --tag v1.0.0-alpha.7 --apply --publish --notes-file release-notes/v1.0.0-alpha.7.md
```

`--publish` pushes the tag and creates the GitHub Release on it.
