# Contributing

How to work on Agent-kit itself. To _use_ the kit, see [docs/getting-started.md](docs/getting-started.md). Vocabulary: [GLOSSARY.md](GLOSSARY.md).

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

| Check                    | Command                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Python contract tests    | `uv run pytest`                                                                     |
| Node contract tests      | `npm test` (also runs every `.claude/skills/*/*.test.mjs` suite)                    |
| Release snapshot paths   | `uv run python scripts/verify_release_snapshot.py`                                  |
| Workflow reference fresh | `uv run python scripts/gen_workflow_reference.py --check`                           |
| Generated blocks fresh   | `uv run python scripts/gen_doc_blocks.py --check` (also runs under `uv run pytest`) |
| Python lint / format     | `uv run ruff check .` · `uv run ruff format --check .`                              |
| Markdown / YAML / JSON   | `npx prettier --check .` (fix: `npm run format`)                                    |
| Shell                    | `shellcheck` on `git ls-files '*.sh'` (pre-commit bundles it)                       |
| Workflows                | `actionlint` (pre-commit bundles it; CI uses the digest-pinned image)               |
| All lint hooks at once   | `uv run pre-commit run --all-files`                                                 |

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs three jobs on every PR and push to `main`: **Tests**, **Lint and format**, **Internal links**. External links are checked weekly by [links.yml](.github/workflows/links.yml), which opens a tracking issue on failure.

## Repository layout

| Path                                         | What                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/*-reusable.yml`           | The product: reusable job bodies Consumers reference.                                                                     |
| `.github/workflows/dogfood-*.yml`            | This repository as its own Caller (off by default).                                                                       |
| `.github/workflows/ci.yml`, `links.yml`      | This repository's CI.                                                                                                     |
| `.github/workflows/publish-cli.yml`          | Creates the GitHub Release and publishes `cli/` to npm on each Release tag.                                               |
| `.github/agent-*`, `.github/security-audit/` | Runtime files Consumers copy.                                                                                             |
| `.github/CODEOWNERS`                         | Review owners for kit-critical paths.                                                                                     |
| `.claude/skills/`                            | Portable skills Consumers copy; a skill may carry its own `*.test.mjs` suites, which CI runs.                             |
| `kit-owned-paths.txt`                        | The Kit-owned paths Consumers replace whole on upgrade.                                                                   |
| `cli/`                                       | The `@mnaimfaizy/agent-kit` npm CLI (`init`, `doctor`, `upgrade`).                                                        |
| `examples/`                                  | Caller templates, setup presets, Threat pack skeletons, QA config and Hazard pack templates, and an `orchestrate` config. |
| `scripts/*.test.py`, `*.test.mjs`            | Contract tests.                                                                                                           |
| `scripts/gen_workflow_reference.py`          | Generates `docs/reference.md` from the workflows.                                                                         |
| `scripts/gen_doc_blocks.py`, `doc-facts.mjs` | Write the Generated blocks in the docs from their Doc facts ([how](#docs-that-are-generated-and-how-to-add-one)).         |
| `security/`                                  | This repository's own Threat pack (dogfood audit).                                                                        |

## Contract tests

The tests are contracts, not unit tests: they pin behavior a Consumer depends on (inputs, gates, the Public-log rule, doc promises). When you change a workflow or doc:

- If a test fails, decide whether the contract changed. If it did, update the test **and** the CHANGELOG `[Unreleased]` section, and classify the bump per [docs/releases.md](docs/releases.md).
- New test files follow the existing shape: `scripts/<area>-contract.test.py`, plain `assert`s, and an `if __name__ == "__main__":` block calling each test so the file also runs with plain `python`.
- `readme-freshness-contract.test.py` keeps the root README in step with the repository: the status line's stage and the Quickstart tag (from `cli/package.json`), a link to every `docs/*.md` page, to `docs/adr/` and to `cli/README.md`, a "What ships" row for every Kit-owned path and the other shipped paths, a "The CLI" row for every command, and a real file behind every workflow badge and local image. It checks that a row exists, not what the row says, so re-read the row when you change what a path does.
- `workflow-validity-contract.test.py` covers what GitHub rejects at load time but actionlint misses (reserved secret names, undeclared secrets, invalid permission scopes, Caller/reusable mismatches). Keep it passing; a failure there means Consumers get "Invalid workflow file".
- Changed a reusable workflow's inputs, secrets, or permissions? Regenerate the reference:

  ```bash
  uv run python scripts/gen_workflow_reference.py && npx prettier --write docs/reference.md
  ```

- New shipped path? Add it to `scripts/release-snapshot-manifest.txt`.

## Docs that are generated, and how to add one

A list or table in the docs that has one source in code (a **Doc fact**, such as the Review response protected paths) is a **Generated block** ([ADR 0010](docs/adr/0010-doc-facts-are-generated-and-renames-are-registered.md)). It sits inside the page that explains it, between two markers that name the fact, and the prose around it stays hand-written:

```markdown
<!-- generated:<fact> -->

(written by the generator; do not edit by hand)

<!-- /generated:<fact> -->
```

Changed a Doc fact's source? Regenerate every block with one command. It rewrites only the text between markers, then runs prettier on the pages it changed:

```bash
uv run python scripts/gen_doc_blocks.py
```

`generated-blocks-contract.test.py` runs the same script with `--check` under `uv run pytest`, so a stale block fails the Tests job and names the page, the block and that command. The script reads the gated docs: `README.md`, `CONTRIBUTING.md`, `GLOSSARY.md`, `AGENTS.md`, `cli/README.md`, and the Markdown under `docs/` and `examples/` apart from `docs/adr/`, `docs/research/` and `docs/agents/`.

To add a new kind of Doc fact, in the pull request that introduces the list:

1. Write a renderer in [scripts/gen_doc_blocks.py](scripts/gen_doc_blocks.py) that returns the block's Markdown, and add it to `FACTS` under the fact's name (lowercase words and hyphens). Write output prettier leaves as it is.
2. Read the source where it lives. A fact held in a JavaScript constant goes in [scripts/doc-facts.mjs](scripts/doc-facts.mjs), which imports the module and prints the constants as JSON (it can read a constant the module does not export; the module must do no work at import time); the renderer reads it from `sources.js`. A fact in another file, such as YAML, is read in Python: add a reader to `Sources`. Never parse JavaScript from Python.
3. Put the empty markers where the list belongs, replacing any hand-written copy, and run the command above.
4. Add a case to `generated-blocks-contract.test.py` that changes the source in a temporary copy and asserts the check fails, like the protected-paths case.

The check also fails, naming the page, on an unknown fact name, a mistyped marker, a marker with no partner or one block opened inside another, and on a fact in `FACTS` that no page holds. Running the generator does not fix those, and it writes no page until they are gone: correct the marker by hand.

## Action and dependency pins

- Every `uses:` in `.github/workflows/` is pinned to a full commit SHA with a `# vX.Y.Z` comment. Dependabot bumps them weekly.
- `anthropics/claude-code-action` is excluded from Dependabot and asserted by the contract tests. To bump it: read its release notes, update the SHA in all five reusable workflows and in `CLAUDE_ACTION_SHA` in the tests, and note it in the CHANGELOG. Also re-check the implement workflow's "Check branch naming inputs" step against the new version's branch naming (`validateBranchName`'s pattern, the default name and its 50-character cut, the fallback to default naming when a template's branch exists, and empty path-segment collapsing), and update the step and its tests if any of these changed. Then add the new SHA to `BUN_FOR_ACTION` in `scripts/bun-install-contract.test.py`, with the `bun-version` from that commit's `action.yml`. If the Bun version changed, update `BUN_VERSION`, `NPM_SHA256`, `RELEASE_SHA256` and the release asset id in the "Install Bun" step of all five reusable workflows. The npm registry publishes no SHA-256 (`dist.shasum` is SHA-1 and `dist.integrity` is base64 SHA-512). So download the tarball given as `dist.tarball` at `registry.npmjs.org/@oven/bun-linux-x64/<version>`, check it against `dist.integrity` (`openssl dgst -sha512 -binary <file> | openssl base64 -A` must print the text after its `sha512-` prefix), and record its `sha256sum` as `NPM_SHA256`. Take `RELEASE_SHA256` from that release's `SHASUMS256.txt`, and the asset id of `bun-linux-x64.zip` from `gh api repos/oven-sh/bun/releases/tags/bun-v<version>`.
- The actionlint image in `ci.yml` is pinned by digest; update the tag and digest together.
- Keep `.pre-commit-config.yaml` hook versions in step with `uv.lock` (ruff) and CI.

## Dogfood flows

`dogfood-security-audit.yml`, `dogfood-agent-pipeline.yml` and `dogfood-review-response.yml` run this repository's own reusable workflows from the same commit (`uses: ./…`), so changes are exercised before they are tagged. All three stay off until you enable them.

One-time setup:

```bash
# Secrets (paste values when prompted)
gh secret set CLAUDE_CODE_OAUTH_TOKEN              # from `claude setup-token`
gh secret set AGENT_KIT_ADVISORIES_TOKEN           # fine-grained PAT: Repository security advisories RW
gh secret set AGENT_KIT_DEPENDABOT_ALERTS_TOKEN    # optional; fine-grained PAT: Dependabot alerts R

# Labels
gh label create "agent:plan"           --color 1D76DB --description "Agent-kit: plan this issue"
gh label create "agent:implement"      --color 0E8A16 --description "Agent-kit: implement the Verified plan"
gh label create "agent:review"         --color 5319E7 --description "Agent-kit: review this PR"
gh label create "agent:audit"          --color B60205 --description "Agent-kit: security audit this PR"
gh label create "agent:address-review" --color FBCA04 --description "Agent-kit: answer the review on this PR"

# Turn on
gh variable set CLAUDE_SECURITY_AUDIT_ENABLED --body true
gh variable set CLAUDE_AGENT_FLOW_ENABLED --body true
gh variable set CLAUDE_REVIEW_RESPONSE_ENABLED --body true

# Optional: model and effort for every dogfood run (defaults: claude-opus-5-5,
# no --effort), and a per-Stage override, CLAUDE_<STAGE>_MODEL or
# CLAUDE_<STAGE>_EFFORT with PLAN, IMPLEMENT, REVIEW, REVIEW_RESPONSE or
# SECURITY_AUDIT.
# CLAUDE_<STAGE>_ENABLED=false turns one Agent flow Stage off.
gh variable set CLAUDE_MODEL --body claude-opus-5-5
gh variable set CLAUDE_SECURITY_AUDIT_MODEL --body claude-fable-5-2
gh variable set CLAUDE_PLAN_EFFORT --body low

# Optional: auto mode (needs CLAUDE_REVIEW_RESPONSE_ENABLED=true as well: the
# review's handoff does not check it, so without it each review with findings
# dispatches a run that skips). A dogfood review that leaves findings hands off
# to dogfood-review-response.yml, at most two rounds per PR. Unset is manual:
# apply agent:address-review yourself.
gh variable set CLAUDE_REVIEW_RESPONSE_MODE --body auto
```

Also: install the [Claude GitHub App](https://github.com/apps/claude) on the repository (implementer) (see [getting-started §7](docs/getting-started.md#7-prepare-the-security-audit) for the audit). Review [security/threat-model.md](security/threat-model.md) before the first audit; it is a draft.

The Allowlist in every dogfood Caller is `mnaimfaizy`; edit it to add maintainers. For Review response, also edit `response_allowlist_actors` in `dogfood-agent-pipeline.yml`'s review job, so it stays equal to `dogfood-review-response.yml`'s `allowlist_actors`.

The dogfood Review response refuses many of this repository's pull requests, by design. Its gate refuses one that changes a protected path:

<!-- generated:review-response-protected-paths -->

- Files named `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.mcp.json`, `.claude.json` or `.gitmodules`, at any depth.
- Anything under `.claude/`, `.agents/skills/` or `.husky/`, at any depth.
- Anything under `.github/agent-runtime/`, from the repository root.
- Every Kit-owned path, from the repository root: `.claude/skills/code-review/`, `.claude/skills/security-audit/`, `.claude/skills/security-finding-triage/`, `.claude/skills/security-response/`, `.claude/skills/explainer/`, `.claude/skills/instruction-drift-audit/`, `.claude/skills/qa-plan/`, `.claude/skills/manual-qa/`, `.claude/skills/plain-prose/`, `.claude/skills/orchestrate/`, `.claude/skills/address-pr-review/`, `.github/agent-runtime/`, `.github/agent-pipeline/`, `.github/security-audit/` and `.github/agent-review-response/`.

<!-- /generated:review-response-protected-paths -->

The list is generated from `PROTECTED_FILES`, `PROTECTED_DIRS_ANY_DEPTH`, `PROTECTED_ROOT_DIRS` and `KIT_OWNED_PATHS` in [review-response.mjs](.github/agent-review-response/review-response.mjs) ([how](#docs-that-are-generated-and-how-to-add-one)); `KIT_OWNED_PATHS` is kept equal to [kit-owned-paths.txt](kit-owned-paths.txt). The agent also cannot change `.github/workflows`, so it declines a finding that needs one. Rounds here mostly cover docs, `cli/`, `scripts/` and `examples/` pull requests; a refusal is not a bug. The round reads its trusted script, hooks and skill from `main`, so a change to them is exercised only after it merges.

## Branch protection

Two rulesets keep the implementer's Claude GitHub App token, which code run through `extra_allowed_tools` can use, away from `main` and the release tags. Only the Admin role bypasses them, so `cut-release.sh` still tags. Run once; needs admin.

The `main branch` ruleset (id `23917207`) blocks deletion and force pushes, and requires a pull request and green CI (`Tests`, `Lint and format`, `Internal links`, each pinned to GitHub Actions so another app cannot report a check under the same name). Its `update` rule lets only the Admin bypass change `main`, so the App cannot merge its own pull request. The maintainer merges every pull request, Dependabot's included, with the bypass, and waits for CI first: the bypass skips the required checks too. Approvals stay at zero: while `@mnaimfaizy` is the sole owner in [.github/CODEOWNERS](.github/CODEOWNERS), a required review would block the maintainer's own PRs, since GitHub never counts a PR author as a reviewer.

```bash
gh api -X PUT repos/mnaimfaizy/agent-kit/rulesets/23917207 --input - <<'EOF'
{"name":"main branch","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH","refs/heads/main"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},
  {"type":"update","parameters":{"update_allows_fetch_and_merge":false}},
  {"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false}},
  {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,"do_not_enforce_on_create":false,
   "required_status_checks":[{"context":"Tests","integration_id":15368},{"context":"Lint and format","integration_id":15368},{"context":"Internal links","integration_id":15368}]}}],
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
- Changes under the paths in [.github/CODEOWNERS](.github/CODEOWNERS) — everything in `.github/workflows/`, the runtime files, Portable skills, and Caller templates Consumers copy, `scripts/`, the npm CLI (`cli/`), this repository's Threat pack, and the review/dependency routing files — request review from the maintainer once the PR is marked ready for review (draft PRs, including every pipeline PR, request no one until then).

## Releasing

See [docs/cutting-releases.md](docs/cutting-releases.md). In short, two steps. First the release-prep pull request, from a clean working tree:

```bash
bash scripts/prepare-release.sh --tag v1.0.0-beta.7   # branch, pins, CHANGELOG, notes template
```

Fill in `release-notes/<tag>.md`, commit, and open the pull request (or re-run with `--open-pr`). Once it is merged:

```bash
git switch main && git pull --ff-only
bash scripts/cut-release.sh --tag v1.0.0-beta.7                     # dry run
bash scripts/cut-release.sh --tag v1.0.0-beta.7 --apply --publish   # tag and push
```

The tag push runs [publish-cli.yml](.github/workflows/publish-cli.yml), which creates the GitHub Release from `release-notes/<tag>.md` and then publishes the npm CLI after you approve the `npm` deployment. If a cut fails part-way, re-run the same command: it finishes the steps left or says what is left.
