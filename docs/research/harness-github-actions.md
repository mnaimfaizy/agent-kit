# Each harness's own GitHub Action, against what we use from `claude-code-action`

Research for [#440](https://github.com/mnaimfaizy/agent-kit/issues/440), a child of the map [#438](https://github.com/mnaimfaizy/agent-kit/issues/438) (Stages run on a Consumer-chosen harness). The question: what do the official GitHub Actions for Codex CLI, Gemini CLI, opencode and Cursor CLI supply, compared with what our reusable workflows take from `anthropics/claude-code-action` today, and where is there no official action?

- **Read on:** 2026-11-22. Action facts come from each action's own `action.yml`, README, source and changelog, read through `gh api` at the ref named in each section. Docs pages carry no publish date, so a docs fact is dated by the read.
- **Sources:** primary only: the action repositories, the harness repositories, and the vendors' own docs sites. No blog, forum or third-party action was used.
- **UNCONFIRMED** marks anything no primary source states. Each is listed again at the end.

## Short answer

Only `claude-code-action` is a **GitHub integration**: it owns the trigger (tag, label, assignee), the App token, the progress comment, branch and PR plumbing, the GitHub MCP tools (inline review comments, PR creation) and a transcript output. The others are much thinner:

- **Codex** (`openai/codex-action@v1.14`, 2026-11-16) is a **hardened runner for `codex exec`** and nothing more: install, an API-key proxy so the key stays out of Codex's reach, privilege drop, permission profiles, a write-access check, and one output (`final-message`). No trigger handling, no GitHub token of its own, no comments, no PR or review tools. Its README tells you to post the result yourself with `actions/github-script`.
- **Gemini** (`google-github-actions/run-gemini-cli@v0.1.22`, 2026-04-24) is a **runner plus example workflows**: it installs Gemini CLI, writes a `settings` JSON to `.gemini/settings.json`, and runs `gemini --yolo --prompt … --output-format json`. Trigger handling, the acknowledgement comment, the App token (your own App, through `actions/create-github-app-token`) and the GitHub tools (the GitHub MCP server in Docker) all live in the **example workflows**, not in the action.
- **opencode** had the closest analogue (`anomalyco/opencode/github`: mention trigger, OIDC exchange for the `opencode-agent` App token, PR creation, reply comment), but **upstream removed it on 2026-10-25** ([anomalyco/opencode#59032](https://github.com/anomalyco/opencode/pull/59032): "We no longer support the GitHub Action"). The old tags still resolve and are locked.
- **Cursor** has **no official action**. Its docs show installing the CLI with `curl https://cursor.com/install | bash` in a `run:` step and calling `agent -p`.

So for every non-Claude harness, Agent-kit would own the GitHub side itself: the trigger, the token, the progress comment, PR creation and inline review comments. The pieces our workflows already do in their own steps (draft-PR fallback, `review-threads.mjs`, gating) are the start of that.

## What our workflows use from `claude-code-action`

All five reusable workflows pin `anthropics/claude-code-action@8cf3482550831fb35a4fc3fbf7ca139cf8028b4c # v1.0.233` (latest tag on the read date: `v1.0.286`, 2026-11-20).

| Workflow | Inputs used | Token | Action-supplied features leaned on |
| --- | --- | --- | --- |
| `agent-plan-reusable.yml` | `prompt`, `settings`, `claude_args`, `claude_code_oauth_token`, `path_to_bun_executable` | `github_token: github.token` (job token, not the App) | `settings` PreToolUse read-confinement hook; `--allowedTools`/`--disallowedTools` grammar |
| `agent-implement-reusable.yml` | `label_trigger`, `track_progress: true`, `branch_prefix`, `branch_name_template`, `settings`, `claude_args` (no `prompt`: tag/label mode builds it) | **Claude App token via OIDC** (`id-token: write`, no `github_token`) | Label-trigger mode, progress (tracking) comment, branch creation, the action's base git add/commit/push tools, `mcp__github__create_pull_request`, `settings` hooks (read confinement, `guard-implementer-push.mjs`). The App token is why CI runs on the agent's PR. |
| `agent-review-reusable.yml` | `track_progress: true`, `prompt`, `settings`, `claude_args`, `github_token: github.token` | job token | Progress comment as the report channel; `mcp__github_inline_comment__create_inline_comment`; hooks |
| `agent-review-response-reusable.yml` | `prompt`, `settings`, `claude_args`, `github_token: github.token`, env `CLAUDE_BRANCH` | job token, read-only | Agent mode on an existing branch; hooks; no push (workflow pushes) |
| `security-audit-reusable.yml` | `prompt`, `settings`, `claude_args`, `github_token: github.token` | job token | **`execution_file` output** (transcript, `jq` for the final `result` line, sent only to the private advisory); hooks |

Cross-cutting: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`; `--model`/`--effort`/`--max-turns`; Claude Code's `Tool(specifier)` allow/deny grammar (`Read(./.git/**)`, `Bash(git diff:*)`, `mcp__…`); and the settings file carries `PreToolUse` hooks whose hash is checked after the run.

## Feature-by-feature

| Feature | `claude-code-action` (v1.0.286) | Codex `openai/codex-action` (v1.14) | Gemini `run-gemini-cli` (v0.1.22) | opencode `anomalyco/opencode/github` | Cursor |
| --- | --- | --- | --- | --- | --- |
| **Status** | Maintained | Maintained | Maintained, pre-1.0 (`@v0`) | **Removed upstream 2026-10-25**; frozen tags `@latest` (commit 2026-03-25), `@github-v1*` | **No official action** |
| **Tag / label / assignee trigger** | Yes: `trigger_phrase`, `label_trigger`, `assignee_trigger` | No. Caller's `on:`/`if:` | Not in the action. `gemini-dispatch.yml` example parses `@gemini-cli /review` etc. with `github-script` | Yes, mention only: `mentions` (default `/opencode,/oc`); no label trigger | No |
| **Actor gating** | Write access; `allowed_bots`, `allowed_non_write_users` | Yes: write-access check, `allow-users`, `allow-bots`, `allow-bot-users` | Example `if:` on `author_association` | Collaborator permission check (`getCollaboratorPermissionLevel`) | No |
| **GitHub App token (so CI runs on the agent's PR)** | Yes: OIDC exchange for the Claude App token, or `github_token` override | **No**. No token handling at all | **No hosted App.** Examples mint your own App token with `actions/create-github-app-token` (manifest in `examples/github-app/`) | Yes: OIDC exchange for the `opencode-agent` App token at `api.opencode.ai`; `use_github_token` override | No |
| **Progress comment** | Yes: `track_progress`, `use_sticky_comment` | No. README posts `final-message` from a later job | Not in the action. Dispatch example posts an acknowledgement comment | No tracking comment: an 👀 reaction while running, then one reply comment | No |
| **Branch + PR creation** | Branch from `branch_prefix`/`branch_name_template`; `mcp__github__create_pull_request` tool | No | Agent does it through GitHub MCP server if the caller configures it | Yes, done by the action's code (push, then "Created PR #n" comment), not an agent tool | Docs: agent runs `git`/`gh` itself, or later CI steps do |
| **Inline review comment tool** | `mcp__github_inline_comment__create_inline_comment` | No. Bring an MCP server (README tip) | Via GitHub MCP server in Docker (`ghcr.io/github/github-mcp-server`, tools `add_comment_to_pending_review`, `pull_request_review_write`) set in `settings` | No | No (`gh` or an MCP server) |
| **Settings / hooks** | `settings` (file or JSON) → Claude Code settings incl. `PreToolUse` hooks | Trusted `codex-home/config.toml`; Codex hooks exist (`PreToolUse` can deny) but need trust, and the action **rejects `--dangerously-bypass-hook-trust`** on protected runs, so a hook must be pre-trusted or managed (`/etc/codex/`, `requirements.toml`) | `settings` JSON written into the **workspace** `.gemini/settings.json`; Gemini CLI has hooks (`BeforeTool` can block) | `opencode.json` in repo; plugins with `tool.execute.before` | `.cursor/cli.json` permissions; `.cursor/hooks.json` hooks exist, CLI coverage beyond `workspaceOpen` **UNCONFIRMED** |
| **Tool allow/deny grammar** | `--allowedTools`/`--disallowedTools`, `Tool(specifier)` | Permission profiles (`:read-only`, `:workspace`, named in `config.toml`) for filesystem/network; no per-tool list in the action | Policy engine TOML: `toolName`, `commandPrefix`, `argsPattern`, `mcpName`, `decision` allow/deny/ask_user, `priority`; also `tools.core`/`tools.exclude`. The action hard-codes `--yolo` (a high-priority allow-all rule) | `permission` map: `allow`/`ask`/`deny` per tool, bash patterns; explicit deny wins under `--auto` | `permissions.allow`/`deny`: `Shell(cmd)`, `Read(glob)`, `Write(glob)`, `WebFetch(domain)`, `Mcp(server:tool)`; deny wins |
| **Transcript output** | `execution_file` (JSON), `session_id`, `structured_output`, `conclusion` | `final-message` only; `output-file` writes the last message. A full JSONL stream needs `codex-args: --json`, which goes to the step log | `summary`, `error` outputs (final JSON response); full stdout/stderr/telemetry only as an uploaded artifact (`upload_artifacts`) | None. Session **shared publicly by default on public repos** (`share` input; link posted in the comment) | DIY: `agent -p --output-format json` or `stream-json` |
| **Structured output** | `structured_output` (JSON schema via `claude_args`) | `output-schema` / `output-schema-file` | No | No | No |
| **Model / effort** | `claude_args --model/--effort` | `model`, `effort` | `gemini_model` | `model` (`provider/model`), `variant` | `--model` |
| **Credential isolation** | Key in env | Key held by a proxy; Codex runs without sudo (`safety-strategy: drop-sudo`, irreversible on reused runners) | Key or Workload Identity Federation to Google Cloud | Provider key in env | `CURSOR_API_KEY` in env |

## Per-action notes

### Codex: `openai/codex-action`

Ref `v1.14` (2026-11-16, [CHANGELOG](https://github.com/openai/codex-action/blob/main/CHANGELOG.md)). No GitHub release objects; tags only.

- Composite action: setup-node, a write-access check, `npm install -g @openai/codex`, the Responses API proxy (the key is passed on stdin and the proxy's environment scrubbed), optional privilege drop, then `codex exec --skip-git-repo-check --cd … --output-last-message …` ([action.yml](https://github.com/openai/codex-action/blob/main/action.yml), `src/runCodexExec.ts`).
- `codex-args` is validated on protected runs: it rejects `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--full-auto` with a profile, `--add-dir`, `--profile`, `--ignore-rules`, `--dangerously-bypass-hook-trust`, most `--enable`/`--disable`, and `-c` overrides of permission, trust, provider or command keys (`src/runCodexExec.ts`).
- README: "`codex-home/config.toml` and named profile definitions … must not come from an untrusted checkout."
- Hooks: Codex supports `PreToolUse` (deny via `permissionDecision: "deny"` or exit 2), configured in `hooks.json` or `[hooks]` in `config.toml`; non-managed hooks are skipped until trusted against their hash ([Hooks](https://learn.chatgpt.com/docs/hooks)). Whether hooks run under `codex exec`: **UNCONFIRMED**.
- OpenAI's GitHub-native review (Codex cloud code review) is a hosted product, not a runner action; out of scope here.

### Gemini: `google-github-actions/run-gemini-cli`

Ref `v0.1.22` (2026-04-24, latest release); default branch last pushed 2026-11-19. Gemini CLI itself: `v0.70.0` (2026-11-19).

- The run step is fixed: `gemini --yolo --prompt "$PROMPT" --output-format json` ([action.yml](https://github.com/google-github-actions/run-gemini-cli/blob/main/action.yml)). No input adds flags, so tool narrowing must come from `settings` (written to the workspace's `.gemini/settings.json`, where the agent can edit it) or policy files.
- The step summary echoes the **whole prompt** into `$GITHUB_STEP_SUMMARY`, and `gemini_debug` streams output to the log with a warning about sensitive data.
- The action also copies its own custom commands into `.gemini/commands/` and verifies an "approved plan" for `gemini-plan-execute`.
- Example workflows (`examples/workflows/{gemini-dispatch,pr-review,issue-triage,gemini-assistant}`) carry the trigger, acknowledgement comment, App token minting and GitHub MCP server config. Review uses `GEMINI_CLI_TRUST_WORKSPACE: 'true'` (headless refuses an untrusted folder otherwise: [trusted folders](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/trusted-folders.md)).
- Policy engine: under `yolo` "a high-priority rule allows all tools" ([policy engine](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md)). Whether a higher-priority `deny` rule still wins under `--yolo`: the priority model implies it, but no doc sentence says so: **UNCONFIRMED**.
- Hooks: `BeforeTool` can block a tool ([hooks](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md)).

### opencode: `anomalyco/opencode/github` (removed)

- Removed from `dev` by [#59032](https://github.com/anomalyco/opencode/pull/59032), merged 2026-10-25: "We no longer support the GitHub Action." Existing tags "keep pointing at older commits … locked by the release-tag ruleset".
- What the frozen action did (`github/action.yml` and `packages/opencode/src/cli/cmd/github.ts` at tag `latest`, commit `77fc88c`, 2026-03-25): resolve the latest release, install via `curl https://opencode.ai/install | bash`, run `opencode github run`; mention trigger; collaborator check; 👀 reaction; OIDC → `api.opencode.ai/exchange_github_app_token`; push and open a PR from its own code; one reply comment; `share` (default true for public repos) posts an `opencode.ai/s/<id>` session link.
- The docs page ([GitHub](https://opencode.ai/docs/github), source `services/site/src/docs/v1/content/github.mdx` on `dev`) still describes the action and `opencode github install|run`. Whether the current CLI (`v1.19.6`, 2026-11-17) still ships `opencode github run`: the CLI docs list it, but the command's source is no longer at its old path on `dev`: **UNCONFIRMED**.
- Usable headless pieces: `opencode run --format json --auto` ("Explicit `deny` rules are still enforced") and the `permission` config ([permissions](https://opencode.ai/docs/permissions), [CLI](https://opencode.ai/docs/cli)); plugins with `tool.execute.before` ([plugins](https://opencode.ai/docs/plugins)).

### Cursor: no official action

- The `cursor` GitHub organisation has no action repository (its repos on the read date: `cursor`, `community-plugins`, `mcp-servers`, `plugins`, `plugin-template`, `cookbook`, `terraform-provider-cursor`, `minisqlite`, `sdk-bridge`, `mixture-of-kittens`).
- [GitHub Actions docs](https://cursor.com/docs/cli/github-actions): install with `curl https://cursor.com/install -fsS | bash`, add `$HOME/.cursor/bin` to the path, `CURSOR_API_KEY` from a secret, run `agent -p "…" --model …`. Two patterns: "full autonomy" (agent runs `git`/`gh`) or the recommended restricted one, where the agent only edits and later steps commit, push and `gh pr comment`.
- [CLI parameters](https://cursor.com/docs/cli/reference/parameters): `-p/--print`, `--output-format text|json|stream-json`, `-f/--force` (alias `--yolo`, "unless explicitly denied"), `--sandbox enabled|disabled`, `--approve-mcps`, `--trust` (headless only), `--mode plan|ask`.
- [Permissions](https://cursor.com/docs/cli/reference/permissions): `~/.cursor/cli-config.json` or `<project>/.cursor/cli.json`; deny takes precedence.
- [Hooks](https://cursor.com/docs/agent/hooks): `preToolUse`, `beforeShellExecution`, `beforeReadFile` and others can deny; the page says only `workspaceOpen` "runs in the Cursor desktop app and CLI". Agent hooks in the headless CLI: **UNCONFIRMED**.

## What this means for the map

- **None of the four supplies the GitHub side**, and two of them (opencode, Cursor) have no maintained action at all. The harness contract cannot assume an action per harness; the reusable workflows need a harness-neutral GitHub layer (trigger, token, progress comment, PR creation, inline review comments) and call each CLI directly or through a thin runner.
- **The App token question is ours to solve for every harness but Claude.** Gemini's own answer is "bring your own App" with `actions/create-github-app-token`; that is likely the general shape.
- **Transcript parity differs:** Claude's `execution_file` has a counterpart only as a CLI flag (`codex exec --json`, `gemini --output-format stream-json`, `opencode run --format json`, `agent --output-format stream-json`), and the official actions either drop it (Codex, Gemini) or send it to the step log or a public share link. The security audit's private-only transcript rule needs the CLI called directly, or `codex-args: --json` redirected, never the log.
- **Hooks exist in every harness but with different trust gates:** Codex skips untrusted hooks and the action forbids the bypass; Gemini's settings live in the workspace the agent can write; Cursor's CLI hook coverage is unconfirmed. Our read-confinement and push-guard hooks do not port as one file.
- **Codex's action is worth keeping as the Codex runner** for its credential proxy and privilege drop, which are stronger than what we do for Claude; it composes with our own GitHub steps because it does nothing on GitHub.

## UNCONFIRMED

1. Whether Codex hooks run under `codex exec` (and so inside `codex-action`).
2. Whether a higher-priority Gemini policy `deny` rule still wins under the action's hard-coded `--yolo`.
3. Whether the current opencode CLI (`v1.19.6`) still ships `opencode github run`.
4. Whether Cursor agent hooks (other than `workspaceOpen`) fire in the headless CLI.
