# Harness capabilities a Stage needs

Research for [#439](https://github.com/mnaimfaizy/agent-kit/issues/439), a child of the map [#438](https://github.com/mnaimfaizy/agent-kit/issues/438) (Stages run on a Consumer-chosen harness). The question: for Claude Code, Codex CLI, Gemini CLI, opencode and Cursor CLI, run headless in CI or in a sandboxed container, what controls does each one give a Stage? That means tool allow and deny, confining reads and writes, blocking `git push`, hooks, sandbox and approval modes, the prompt on stdin, structured output, a turn limit you can detect, skipping project config, version pinning, and CI auth.

- **Read on:** 2026-11-22. Docs pages carry no publish date, so a fact from a docs page is dated by the read.
- **Versions read** (latest stable on the read date):
  - **Claude Code** `2.1.330` (npm `latest`, 2026-11-20; `stable` is `2.1.323`). The Deep scan pins `2.1.328` (`cli/src/deep-scan/claude-code.mjs`). Read from the [CLI reference](https://code.claude.com/docs/en/cli-reference) and the [Hooks](https://code.claude.com/docs/en/hooks) page.
  - **Codex CLI** `rust-v0.171.0` (2026-11-20; npm `@openai/codex@0.171.0`). Source read at that tag (`codex-rs/exec`, `codex-rs/hooks`, `codex-rs/core`), plus the docs export [`llms-full.txt`](https://developers.openai.com/codex/llms-full.txt) and the learn.chatgpt.com pages [Hooks](https://learn.chatgpt.com/docs/hooks) and [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).
  - **Gemini CLI** `v0.70.0` (2026-11-19; npm `@google/gemini-cli@0.70.0`). Source and `docs/` read at that tag.
  - **opencode** `v2.3.2` (2026-11-18; npm `@opencode/cli@2.3.2`). Source (`packages/cli`, `packages/core`) and docs (`services/site/src/docs/content/`) read at that tag. GitHub still marks `v1.19.6` (npm `opencode-ai@1.19.6`) as "Latest", and V1 uses different config names (see §4).
  - **Cursor CLI** `v2026.11.17`, from its [changelog](https://cursor.com/docs/cli/changelog.md). The CLI is closed source, so only its docs were read: [Parameters](https://cursor.com/docs/cli/reference/parameters.md), [Permissions](https://cursor.com/docs/cli/reference/permissions.md), [Configuration](https://cursor.com/docs/cli/reference/configuration.md), [Headless](https://cursor.com/docs/cli/headless.md), [Output format](https://cursor.com/docs/cli/reference/output-format.md), [Hooks](https://cursor.com/docs/hooks.md), [Sandbox](https://cursor.com/docs/reference/sandbox.md) and [Installation](https://cursor.com/docs/cli/installation.md).
- **Not redone here:** base URL, model proxy and egress facts are settled in `docs/research/deep-scan-model-apis.md` (branch `research/deep-scan-model-apis`, #441). Each harness's GitHub Action is covered in `docs/research/harness-github-actions.md` (branch `research/harness-github-actions`, #440). This file answers three of #440's UNCONFIRMED items (Codex hooks under `exec`, Gemini `deny` under `--yolo`, Cursor hooks in the CLI).
- **Sources:** primary only. **From source** marks a fact read in source code but not in the docs. **UNCONFIRMED** marks anything no primary source states. No harness was run with a prompt.

## 0. What our Stages lean on today (the baseline)

In the reusable workflows, through `claude-code-action`'s `settings` input (`.github/agent-runtime/`):

- **Read confinement:** a `PreToolUse` hook on `Read|Grep|Glob` (`confine-reads-to-workspace.mjs`). It resolves the path, symlinks included, and denies anything outside `$GITHUB_WORKSPACE`. A hook is used because an `--allowedTools` scope can't revoke the action's base grant; only a deny decides a call.
- **Write confinement** (implementer): a `PreToolUse` hook on `Edit|Write|MultiEdit|NotebookEdit` (`confine-writes-to-worktree.mjs`). It keeps writes in the tree and out of `.git`, `.claude/settings*.json` and `.mcp.json`.
- **Push guard** (implementer): a `PreToolUse` hook on `Bash` (`guard-implementer-push.mjs`). It allows only `git-push.sh origin <ref>`, diffs the branch against a staged base, and refuses changes under `.github/workflows|actions`. It also refuses commands that could leak a file or secret into publishable output. It hardens git with `-c core.fsmonitor=false -c core.hooksPath=/dev/null`.
- **Untamperable:** the scripts and settings are staged to `$RUNNER_TEMP`, outside the workspace, and each command ends `|| exit 2` because a crashing hook doesn't block in Claude Code. The settings hash is checked after the run.
- **Plus** `--allowedTools`/`--disallowedTools` `Tool(specifier)` rules, `--max-turns`, `--model`/`--effort`, and `execution_file` (the transcript, which the security audit sends only to the private advisory).

In the Deep scan (`cli/src/deep-scan/agent.mjs`), Claude Code runs in a container whose only route out is the model proxy:

- **Flags:** `--bare --print`, the launcher's own `--settings` (base URL, `DISABLE_AUTOUPDATER`, allow and deny lists), `--setting-sources user`, `--tools`/`--allowedTools` set to `Bash,Read,Write,Edit,Glob,Grep`, `--disallowedTools WebFetch,WebSearch`, `--permission-mode dontAsk`, `--add-dir /agent-kit`, `--no-session-persistence` and `--max-turns`.
- **Brief:** passed on stdin.
- **Turn limit:** detected by grepping stderr for `^Error: Reached max turns`.
- **Subscription path:** drops `--bare` and adds `disableAllHooks` and `--strict-mcp-config` instead.
- **Install:** the pinned npm version, with the auto-updater off by environment and by `/etc/claude-code/managed-settings.json`.

So a Stage needs, per harness:

1. A tool allowlist and denylist.
2. Read confinement and write confinement.
3. A push gate.
4. A gate the agent can't tamper with, that fires headless and fails closed.
5. A non-interactive approval mode.
6. The brief on stdin.
7. A machine-readable result or transcript.
8. A turn cap whose hit can be detected.
9. A way to skip the scanned repo's own config.
10. A pinned version with no self-update.
11. CI auth.

## 1. Capability matrix

`✓` documented, `src` from source, `✗` absent, `?` UNCONFIRMED.

| Need | Claude Code 2.1.330 | Codex CLI 0.171.0 | Gemini CLI 0.70.0 | opencode 2.3.2 | Cursor CLI 2026.11.17 |
| --- | --- | --- | --- | --- | --- |
| **Headless entry** | `claude -p` | `codex exec` | `gemini -p`, or any non-TTY run | `opencode run` (`--standalone` in CI) | `agent -p` |
| **Tool allow/deny grammar** | ✓ `--tools`, `--allowedTools`, `--disallowedTools`, `Tool(specifier)`, deny wins | Partial. No per-tool list. Filesystem and network **permission profiles** (`:read-only`, `:workspace`, `:danger-full-access`, or named ones with per-path `read`/`write`/`deny`). Shell **rules** (`prefix_rule`, Starlark, `forbidden` > `prompt` > `allow`). `web_search = "disabled"` | ✓ `tools.core` (allowlist), `tools.exclude`, `tools.allowed`, policy-engine TOML (`toolName`, `commandPrefix`, `argsPattern`, `decision`, `priority`, `modes`) | ✓ ordered `permissions` (`action`, `resource`, `effect`; last match wins), plus binary `policies` (`tool.use` `<action>:<value>`) | ✓ `permissions.allow`/`deny`: `Shell(cmd[:args])`, `Read(glob)`, `Write(glob)`, `WebFetch(domain)`, `Mcp(server:tool)`; deny wins |
| **Read confinement** | Hook (ours) today. New: `--restricted` (v2.1.248+) "confines the built-in file tools to the working directories" | Sandbox profile `deny` paths, enforced on every process (bwrap + seccomp on Linux). No Read tool to hook: reads go through the shell | Built-in file tools "operate within a `rootDirectory`" ✓. Shell isn't confined unless `--sandbox` | `external_directory` permission (`deny`) or `policies` `tool.use` `read:*` / `external_directory:*`. Shell paths are "best effort" inferred | `sandbox.json` `readBoundary: "workspace"` (sandboxed shell). `Read(glob)` deny for the read tool. Per-repo `sandbox.json` "replaces per-user" |
| **Write confinement** | Hook (ours) | `workspace-write` sandbox (`.git` read-only, no network), `--add-dir` | File tools held to the root ✓. Shell, only under `--sandbox` | `edit` permission rules, `external_directory` | Print mode rejects "writes outside the workspace or to protected paths like `.vscode/` and `.git/hooks/`" ✓. `.cursor/*.json` is protected from writes |
| **Block `git push`** | Hook (ours), or deny `Bash(git push *)` | `prefix_rule(pattern=["git","push"], decision="forbidden")` ?: the docs scope rules to "commands Codex can run outside the sandbox". `workspace-write` has no network, so a push fails anyway | Admin policy `run_shell_command` with `commandPrefix = "git push"`, `decision = "deny"` ✓. How compound commands are split ? | `policies` `tool.use` `shell:git push *` deny ✓. The scanner splits compound commands ✓ | `permissions.deny` `Shell(git:push*)`-style ? (exact arg syntax for a subcommand unconfirmed). `beforeShellExecution` hook ✓ |
| **PreToolUse equivalent** | `PreToolUse` ✓ | `PreToolUse` ✓. Matches `Bash`/`exec_command`, `apply_patch` (as `Edit`/`Write`), and MCP; hosted tools like web search aren't covered | `BeforeTool` ✓ (and `BeforeToolSelection`) | Plugin `ctx.tool.hook("execute.before")` (V1 `tool.execute.before`), in-process JS; throw to block | `preToolUse`, `beforeShellExecution`, `beforeReadFile`, `beforeMCPExecution` ✓ |
| **Hooks fire headless** | ✓ (our workflows rely on it) | src: `exec` handles `HookStarted`/`HookCompleted` and carries `--dangerously-bypass-hook-trust` | Only in a **trusted** folder (src, `hookRegistry.ts`). Headless with `--yolo` needs trust anyway | ? (plugins load into the server `run` talks to, so likely yes) | ✓ in the CLI (changelog: hooks "emit in the CLI", "Hooks that ask for approval now prompt"). `-p` specifically ? |
| **Hook fails closed** | Opt-in `onFailure: "block"` (v2.1.295+); before that, `\|\| exit 2` | ✗ src: an error, timeout, other exit code, or exit 2 **without stderr text** is `Failed`, and the call goes ahead. The docs: "a useful guardrail, not a complete enforcement boundary" | ✗ by default: "Other: non-fatal… proceeds". Exit 2 blocks. Non-JSON stdout means "Allow" | A throw blocks. A plugin that fails to load ? | Opt-in `failClosed: true`. Invalid JSON blocks permission hooks |
| **Hook agent-untamperable** | Settings staged outside the workspace and passed with `--settings`; managed settings with `allowManagedHooksOnly`; `disableAllHooks` outside managed settings "can't disable managed hooks" ✓ | Managed hooks (`requirements.toml`, `/etc/codex/hooks.json`) are "trusted by policy"; `allow_managed_hooks_only = true`. Project hooks load only when `.codex/` is trusted ✓ | Weak. Project hooks merge in and are auto-trusted after a warning (src). `hooksConfig.disabled` merges by **UNION** (src, `settingsSchema.ts`), so a checkout's `.gemini/settings.json` can disable a system hook by name. The untamperable layer is **admin policy** in root-owned `/etc/gemini-cli/policies` | System `/etc/opencode/` config and plugins. `policies` from system config "outrank all of them". `plugin.use` deny keeps project plugins out ✓ | Enterprise `/etc/cursor/hooks.json` ranks Enterprise → Team → Project → User ✓. Whether a non-Enterprise CLI honours that file ? The CLI also reads **Claude Code `settings.json` hooks** (changelog v2026.06.09) |
| **Sandbox modes** | Optional native sandbox. The Deep scan uses the outer container | `read-only` (exec default), `workspace-write`, `danger-full-access`. bwrap "may not work" in Docker, so use `danger-full-access` inside a container that isolates | `--sandbox` (docker, podman, seatbelt, gVisor, LXC), profiles `permissive-*`/`restrictive-*`/`strict-*`; `security.toolSandboxing` (off). Nested in our container ? | None: "`shell` runs with the host user's filesystem, process, and network authority" | `--sandbox enabled\|disabled`; `sandbox.json` `type`, `readBoundary`, network. Linux mechanism ?; "fails fast… when sandboxing is enabled but unavailable" |
| **Approval modes (headless)** | `--permission-mode` `default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`bypassPermissions` | `exec` forces `approval_policy = Never` (src). Every approval request is rejected and marks the run failed (src). `--approve-for-me` sends them to auto-review. `--full-auto` is gone | `--approval-mode default\|auto_edit\|yolo\|plan`. `ask_user` is treated as `deny` headless. An untrusted folder forces `default` (src) | Unanswered `ask` is auto-rejected (src, `noninteractive.ts`). `--auto` approves everything not explicitly denied | No `--force`: what's allowed runs, what needs approval is rejected. `--force`/`--yolo`: all "unless explicitly denied". `approvalMode` `allowlist\|auto-review\|unrestricted` |
| **Prompt on stdin** | ✓ (Deep scan does it) | ✓ "If you omit the prompt argument, Codex reads the prompt from stdin", or `-` | ✓ src: reads stdin when not a TTY; `-p` text is appended | ✓ src: stdin is read in full with no message argument | ? Docs show only a prompt argument. The changelog says `-p` no longer blocks on an open stdin pipe |
| **Structured output** | `--output-format json\|stream-json`, `--json-schema` | `--json` (JSONL: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`), `--output-schema FILE`, `-o` | `--output-format json\|stream-json` (`init`, `message`, `tool_use`, `tool_result`, `error`, `result`). No schema flag | `--format json` (NDJSON). No schema flag | `--output-format json\|stream-json` (`system/init`, `assistant`, `tool_call`, terminal `result` with `usage`). No schema flag |
| **Turn limit** | `--max-turns` | ✗ none in `exec` (src grep for max turns: nothing). Use a wall-clock timeout | `model.maxSessionTurns` (default `-1`) | Agent `steps: N`: "On the final step, OpenCode removes tools and asks the model to summarize" | ✗ none documented |
| **Turn limit detectable** | ✓ stderr `Error: Reached max turns` and a non-zero exit (we rely on it) | n/a | ✓ **exit 53** (`FatalTurnLimitedError`) | ✗ the run ends normally with a summary. Any marker in JSON events ? | n/a |
| **Exit codes** | 0, or non-zero on error or turn limit | src: 1 on a fatal error, a `Failed`/`Interrupted` turn, or a rejected approval; else 0 | 0, 1, 42 (input), 53 (turn limit) ✓ | src: 1 on a run error, else 0 | Non-zero on failure, and stderr; `json` emits nothing on failure ✓ |
| **Skip project config** | `--bare` (hooks, skills, plugins, MCP, CLAUDE.md, memory); also `--safe-mode`, `--restricted`, `--setting-sources`, `--strict-mcp-config` | Partial. Project `.codex/` (config, hooks, rules, MCP) loads only if trusted. AGENTS.md is skipped when `trust_level = "untrusted"` or `project_doc_max_bytes = 0` (src, `agents_md.rs`). `--ignore-user-config` and `--ignore-rules` exist. `.agents/skills` skip ? | ✗ no single flag. Headless writes need a trusted folder, which loads project settings, `.env`, MCP, hooks and GEMINI.md. Pieces: `-e none`, `mcp.allowed`, system **override** settings (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`), `context.fileName` | ✓ `OPENCODE_DISABLE_PROJECT_CONFIG=1` (project config and AGENTS.md), `OPENCODE_DISABLE_CLAUDE_CODE=1` (CLAUDE.md and `.claude` skills), config by `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT` | ✗ none. With `--trust`/`--force` the run loads `.cursor/rules`, AGENTS.md, `.cursor/cli.json` permissions, `.cursor/hooks.json`, `.cursor/sandbox.json` and Claude `settings.json` hooks |
| **Version pin, no self-update** | npm pin + `DISABLE_AUTOUPDATER=1` + managed settings ✓ | npm pin. The update check is TUI-only (src, per #441); `check_for_update_on_startup = false` | npm pin + `general.enableAutoUpdate: false`, `general.enableAutoUpdateNotification: false` | npm pin + `"update": "disable"` (global only; "Project-level values are ignored") or `OPENCODE_DISABLE_AUTOUPDATE=1` (src) | ✗ the installer fetches latest, and the CLI "will try to auto-update by default". `--disable-auto-update` appears only in the changelog (v2026.06.09), not on the Parameters page ?. No documented way to pin a version |
| **CI auth** | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | `CODEX_API_KEY` ("set it inline rather than job-wide"); `CODEX_ACCESS_TOKEN`; **workload identity** (`OPENAI_IDENTITY_TOKEN_FILE` = an OIDC token, `OPENAI_FEDERATION_RULE_ID`) | `GEMINI_API_KEY`; Vertex (ADC, or WIF through the action) | The provider's own env var (e.g. `ANTHROPIC_API_KEY`) | `CURSOR_API_KEY` or `--api-key` |

## 2. Claude Code (the reference)

- **`--restricted`** (v2.1.248+) is new to us. Use it "when an evaluation harness drives `claude` on a shared machine". It removes the tools that run commands or code, plus WebFetch, "unless you name them individually in `--tools`". It "confines the built-in file tools to the working directories". It "loads only managed settings and `--settings`" and refuses `bypassPermissions` ([CLI reference](https://code.claude.com/docs/en/cli-reference)). Once `Bash` is named back in, Bash isn't confined, so this replaces the read hook only for Stages whose Bash is already narrowed.
- **`onFailure: "block"`** (v2.1.295+) makes a hook that times out or crashes block the call. Without it, "a timed-out `command`… hook doesn't block the tool call", and an exit other than 0 or 2 is a "non-blocking error" ([Hooks](https://code.claude.com/docs/en/hooks)). Our `|| exit 2` covers a crash but not a timeout; the default timeout is 600 s.
- **Managed hooks:** `allowManagedHooksOnly` blocks user, project, local and plugin hooks. "The `disableAllHooks` setting can't disable managed hooks from outside managed settings."
- **`--bare`** skips hooks, skills, custom commands, subagents, plugins, MCP servers, auto memory and CLAUDE.md. `--safe-mode` disables customizations but keeps auth, model and permissions. Managed policy still applies under it.
- **`--json-schema`** gives validated JSON (print mode only). `--max-budget-usd` caps spend on a client-side estimate, print mode only.

## 3. Codex CLI

- **Headless:** `codex exec [PROMPT|-]`. With no prompt, or `-`, it reads stdin. "If stdin is piped and a prompt is also provided, stdin is appended as a `<stdin>` block" (src, `exec/src/cli.rs`).
- **Exit codes:** `exec` exits **1** when the turn ends `Failed` or `Interrupted`, on a non-retrying error, or when a server request (an approval) is rejected (src, `exec/src/lib.rs`).
- **Approvals:** `exec` sets `approval_policy = Never` (src, `lib.rs:642`). Any `CommandExecutionRequestApproval`, `FileChangeRequestApproval` or `ApplyPatchApproval` is rejected with "…approval is not supported in exec mode", and the run counts as failed.
- **No turn limit.** No `max_turns` flag or setting exists in `codex-rs` at the tag. `[goals] max_goal_token_budget` is a token budget for `/goal`, not a turn cap. A Stage needs a wall-clock timeout, plus the model proxy's token cap where the proxy fronts Codex.
- **Sandbox:**
  - `exec` defaults to `read-only`. `workspace-write` allows edits in the workspace and `--add-dir` roots, makes `.git` read-only, and has no network unless `sandbox_workspace_write.network_access`.
  - Permission profiles can `deny` reads of exact paths or globs (`[permissions.<name>.filesystem]`).
  - On Linux the sandbox is `bwrap` + seccomp. In Docker it "may not work if the host or container configuration blocks the namespace, setuid `bwrap`, or `seccomp` operations". The docs then say to isolate with the container and run `--sandbox danger-full-access` ([OS-level sandbox](https://developers.openai.com/codex/llms-full.txt), "Agent approvals & security"). **For our Deep scan container this means Codex's own sandbox is probably off, and confinement has to come from the container itself.**
- **Hooks:**
  - Events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SessionStart`, `Stop` and more. `PreToolUse` sees shell (`Bash`), unified exec, `apply_patch` (as `Edit`/`Write`) and MCP tools. Hosted tools (web search) aren't covered, and `write_stdin` into a running exec session doesn't rerun it ([Hooks](https://learn.chatgpt.com/docs/hooks)).
  - Non-managed hooks are "skipped until trusted" by hash. `--dangerously-bypass-hook-trust` skips that check for one run.
  - Managed hooks (`requirements.toml`, `/etc/codex/hooks.json`) are trusted by policy. `allow_managed_hooks_only = true` skips every other source.
  - **Fails open** (src, `hooks/src/events/pre_tool_use.rs`): a spawn error, a timeout, any exit code but 0 or 2, invalid JSON, or exit 2 with empty stderr all mark the hook `Failed` and the tool call runs. Only a `deny` decision or exit 2 with a reason blocks. **A Codex hook can't be the security boundary, and a port of our `|| exit 2` must also write a reason to stderr.**
  - There's no Read tool, so read confinement can only come from the sandbox profile or the container, never from a hook.
- **Project config:**
  - Project `.codex/` layers (config, hooks, rules, MCP) load only for trusted projects, and the repo layer can't set the provider or base URL (#441).
  - AGENTS.md: `load_project_instructions` returns nothing when the project is `untrusted` or `project_doc_max_bytes == 0` (src, `core/src/agents_md.rs:65`). So `-c project_doc_max_bytes=0` skips the scanned repo's AGENTS.md. `is_untrusted()` needs an explicit `trust_level = "untrusted"`; an unknown project isn't untrusted for this check.
  - `--ignore-user-config` skips `$CODEX_HOME/config.toml`, and `--ignore-rules` skips the `.rules` files.
  - Whether `.agents/skills` discovery can be switched off as a whole: UNCONFIRMED. `[[skills.config]]` disables a skill by name or path.
- **Auth:**
  - `CODEX_API_KEY` for `exec`. The docs: "Avoid setting `OPENAI_API_KEY` or `CODEX_API_KEY` as a job-level environment variable in workflows that run repository-controlled code."
  - **Workload identity:** `OPENAI_IDENTITY_TOKEN_FILE` (an OIDC token or SPIFFE JWT-SVID) plus `OPENAI_FEDERATION_RULE_ID` ([Environment variables](https://developers.openai.com/codex/llms-full.txt)). That could let a GitHub Actions OIDC token stand in for a stored key. Whether OpenAI federation accepts GitHub's OIDC issuer: UNCONFIRMED.

## 4. Gemini CLI

- **Headless:** headless is "triggered when the CLI is run in a non-TTY environment or when providing a query with the `-p`". stdin is read when it isn't a TTY (src, `gemini.tsx`).
- **Exit codes:** **0** success, **1** general or API error, **42** input error, **53** turn limit exceeded ([headless.md](https://github.com/google-gemini/gemini-cli/blob/v0.70.0/docs/cli/headless.md)). 53 is `FatalTurnLimitedError`, raised when `turnCount > maxSessionTurns` (src, `core/src/utils/errors.ts`, `cli/src/nonInteractiveCli.ts`). That makes Gemini the only harness besides Claude with a turn cap that has its own exit code.
- **Policy engine (resolves #440 UNCONFIRMED 2):**
  - The `--yolo` allow-all rule is in the **Default** tier at priority 998, so its final priority is 1.998 (src, `policy/policies/yolo.toml`: "998: YOLO mode allow-all (becomes 1.998 in default tier)").
  - User and Admin tiers sit above it: base 4 and 5 in the tier table. The worked examples give 3.x and 4.x, so the doc contradicts itself on the base, but both are above 1.998. **A User or Admin `deny` beats `--yolo`.**
  - The Workspace tier (`.gemini/policies`) "is currently non-functional", so a checkout can't add policy.
  - Admin policies in `/etc/gemini-cli/policies` must be root-owned and not group- or world-writable, or they're ignored. `--admin-policy` supplements are ignored if the standard directory has any `.toml`.
  - `ask_user` is treated as `deny` in non-interactive mode.
- **Trust:**
  - Folder trust is off by default, and then every folder counts as trusted (src, `core/src/utils/trust.ts`: `if (!options.isFolderTrustEnabled) return { isTrusted: true }`).
  - `GEMINI_CLI_TRUST_WORKSPACE=true` forces trust. `=false` or `GEMINI_RESTRICTED_MODE=true` forces untrusted.
  - An untrusted folder forces approval mode back to `default` (src, `config.ts:839`) and ignores workspace settings, `.env`, MCP and auto memory. **So a writing Stage runs trusted, and trusted means the checkout's `.gemini/settings.json`, `.env`, MCP servers, hooks and GEMINI.md all load.**
- **Hooks:**
  - `BeforeTool` blocks with `{"decision":"deny"}` or exit 2. Any other exit is a warning, and "the interaction proceeds".
  - Hooks run only in a trusted folder: in an untrusted one, "Project hooks disabled because the folder is not trusted", and that skip covers the whole merged `hooks` config (src, `hooks/hookRegistry.ts`).
  - Project hooks are auto-trusted after one warning (src).
  - `hooksConfig.disabled` uses merge strategy `UNION` (src, `settingsSchema.ts`), so the project file can name a system hook and turn it off. `hooksConfig.enabled` takes the system override's value, because system settings merge last.
  - **A Gemini hook isn't agent-untamperable unless the launcher removes or overwrites the checkout's `.gemini/` before the run.** Admin policy is the reliable gate.
- **Read and write confinement:** "All file system tools operate within a `rootDirectory`", plus `--include-directories`. The shell tool isn't confined without `--sandbox` (container or seatbelt) or `security.toolSandboxing` (off by default). Whether Gemini's container sandbox nests inside our Deep scan container: UNCONFIRMED.
- **No `--bare`.** The pieces are `-e none` (no extensions), `mcp.allowed`/`--allowed-mcp-server-names`, `tools.exclude`, a system **override** file via `GEMINI_CLI_SYSTEM_SETTINGS_PATH` (precedence over project), and `context.fileName`. Whether `context.fileName` can be set so no GEMINI.md loads: UNCONFIRMED. The reliable route is for the launcher to strip `.gemini/`, `GEMINI.md` and `.env` from the copy it scans or builds in.

## 5. opencode

- **Headless:**
  - `opencode run [message]`. With no message, stdin is read in full; with one, a piped stdin is appended (src, `cli/src/run/run.ts`).
  - CI docs use `--standalone` so the private server gets the env key.
  - `--format json` emits NDJSON events. On error it writes a `{"type":"error"}` event and exits **1** (src, `reportRunError`).
  - An `ask` that no one can answer is auto-rejected with "This non-interactive run cannot ask the user for permission…". `--auto` approves it ("decision: once") unless explicitly denied (src, `run/noninteractive.ts`).
- **Permissions (V2):** an ordered array of `{action, resource, effect}`; "The last matching rule wins". Actions: `read`, `edit`, `glob`, `grep`, `shell`, `subagent`, `skill`, `webfetch`, `websearch`, `external_directory`, `<server>_<tool>`.
  - The default policy allows everything, `external_directory` included, so "reads and edits outside the Location and worktree proceed without a prompt" until you add a rule ([permissions.mdx](https://github.com/anomalyco/opencode/blob/v2.3.2/services/site/src/docs/content/permissions.mdx)).
  - The shell scanner splits compound commands and refuses dynamic evaluation it can't analyse. It still warns that `shell` "runs with the host user's filesystem, process, and network authority".
  - V1 names differ: `permission`, `bash`, `task`.
- **Policies** are the agent-untamperable layer. They're binary and never prompt. `tool.use` with `<action>:<value>` "hard-deny[s] a permission check… applies after agent rules and saved approvals". System `/etc/opencode/opencode.json` policies outrank Console, global and project files ([policies.mdx](https://github.com/anomalyco/opencode/blob/v2.3.2/services/site/src/docs/content/policies.mdx)). Examples: `shell:git push *`, `external_directory:*`, `read:*/.ssh/*`. `plugin.use`, `mcp.use` and `skill.use` deny keep a checkout's plugins, MCP servers and skills out.
- **Hooks:** plugin code, `ctx.tool.hook("execute.before")` (V2) or `tool.execute.before` (V1). It runs in-process and throws to block. System plugins live in `/etc/opencode/plugins/`. Whether plugins run under `opencode run --standalone`: UNCONFIRMED (likely, since `run` drives the same server).
- **Turn limit:** the agent's `steps: N`. At the cap it strips tools and asks for a summary, so the run **ends normally**. No exit code or event marks it (UNCONFIRMED whether the JSON stream carries a marker).
- **No OS sandbox.**
- **Skip project config:** `OPENCODE_DISABLE_PROJECT_CONFIG=1` (alias `OPENCODE_CONFIG_PROJECT_DISABLE`) turns off project config and project AGENTS.md (src, `cli/src/server-process.ts`). `OPENCODE_DISABLE_CLAUDE_CODE=1` skips CLAUDE.md and `.claude` skills. `OPENCODE_CONFIG_CONTENT` passes inline config. opencode reads `.claude/skills` and `.agents/skills` by default.
- **Pinning:** `npm i -g @opencode/cli@2.3.2` (V2) or `opencode-ai@1.19.6` (V1). Updates are off with `"update": "disable"` in global config (project values ignored) or `OPENCODE_DISABLE_AUTOUPDATE=1` (src, `services/updater.ts`). The default is `"notify"`.

## 6. Cursor CLI

- **Headless:** `agent -p`.
  - Without `--force`, "anything that runs without approval still runs, and anything that would need approval is rejected". "Print mode writes to files in your workspace even without `--force`" and rejects "writes outside the workspace or to protected paths like `.vscode/` and `.git/hooks/`" ([Headless](https://cursor.com/docs/cli/headless.md)).
  - `--force`/`--yolo` runs everything "except what `permissions.deny` and team policies block".
  - Untrusted workspaces fail headless unless `--trust` or `--force` is passed (changelog v2026.06.09).
  - Team admins can disable headless mode, but "Treat the setting as a usage policy, not a security boundary".
- **Output:** `json` emits one `result` object on success. "On failure, the process exits with a non-zero code and writes an error message to stderr. No well-formed JSON object is emitted" ([Output format](https://cursor.com/docs/cli/reference/output-format.md)). `stream-json` carries `system/init`, `assistant`, `tool_call` started/completed and a terminal `result` with `usage`. There's no schema flag and **no turn limit**.
- **Permissions:** `Shell(commandBase)` matches "the first token in the command line", with an optional `command:args` form. Plus `Read`, `Write`, `WebFetch` and `Mcp`.
  - The project file `.cursor/cli.json` can set permissions: "Only permissions can be configured at the project level". "Deny takes precedence", so a checkout can widen `allow` but not undo a global `deny`.
  - Whether `Shell(git:push*)` matches `git push origin x`: UNCONFIRMED.
- **Hooks:** `preToolUse`, `beforeShellExecution`, `beforeReadFile` and `beforeMCPExecution` deny with `permission: "deny"` or exit 2. "Other exit codes – Hook failed, action proceeds (fail-open by default)", unless `failClosed: true`.
  - Sources rank "Enterprise → Team → Project → User". Enterprise is `/etc/cursor/hooks.json` on Linux ([Hooks](https://cursor.com/docs/hooks.md)).
  - Hooks run in the CLI: the changelog says `afterAgentThought`/`afterAgentResponse` "emit in the CLI", and "Hooks that ask for approval now prompt" in the CLI. That resolves #440's UNCONFIRMED 4 for the CLI. `-p` specifically isn't stated.
  - Project hooks need a trusted workspace, and `--trust` makes it trusted.
  - **Cursor also reads and merges Claude Code `settings.json` hooks** (v2026.06.09). A checkout's `.claude/settings.json` hooks would run under Cursor in a trusted headless run.
  - Whether `/etc/cursor/hooks.json` is honoured without an Enterprise plan: UNCONFIRMED.
- **Sandbox:** `--sandbox enabled|disabled`, and `sandbox.json` (`type` `workspace_readwrite`/`workspace_readonly`, `readBoundary` `system`/`workspace`, network modes). The per-repo `.cursor/sandbox.json` has **higher** priority than per-user, and `readBoundary` "per-repo replaces per-user". Only team-admin policy and Cursor's hard-coded rules "cannot be weakened" ([Sandbox](https://cursor.com/docs/reference/sandbox.md)). The Linux mechanism is UNCONFIRMED.
- **Nothing skips project config**, and **nothing pins a version**: the installer is `curl https://cursor.com/install | bash`, and the CLI "will try to auto-update by default". `--disable-auto-update` is named in the changelog (v2026.06.09) but not on the Parameters page (UNCONFIRMED). The `channel` setting picks a release channel, not a version.
- **Auth:** `CURSOR_API_KEY` or `--api-key`. The model proxy can't front it (#441, #446).
- **Prompt on stdin:** UNCONFIRMED. The docs show only an argument.

## 7. What this means for the map

1. **Confinement doesn't port as one hook.** There are three mechanisms:
   - **Hook-gated** (Claude; Cursor with `failClosed`).
   - **Policy or sandbox-gated** (Codex sandbox profiles; Gemini admin policy plus the root directory; opencode system `policies`).
   - **Container-gated**, for whatever the harness can't hold itself: Codex inside Docker, Gemini's shell, opencode's shell.

   Codex and Gemini hooks fail open, and Codex has no Read tool, so no harness but Claude and Cursor can take our read-confinement hook. The adapter contract should state confinement as an outcome ("no read outside the workspace, no write to `.git` or harness config, no push changing `.github/`"), with each adapter naming how it gets there.
2. **The push guard belongs outside the agent for every non-Claude harness.** Its job is to refuse a push that changes workflow files before CI runs it. The robust form for all harnesses is that the agent never holds a push credential, and a workflow step after the agent diffs and pushes. Review response already works this way. The implementer's in-session push through `claude-code-action` is the exception.
3. **Agent-untamperable config needs a root-owned system layer or files outside the workspace:**
   - `/etc/claude-code/managed-settings.json` or `--settings` from `$RUNNER_TEMP`.
   - `/etc/codex/requirements.toml` with `allow_managed_hooks_only`.
   - `/etc/gemini-cli/policies/*.toml`, root-owned.
   - `/etc/opencode/opencode.json` `policies`.
   - `/etc/cursor/hooks.json` (?).

   On a GitHub runner the job can write `/etc` with `sudo` before the agent step; the agent must then run without sudo. That's codex-action's `drop-sudo` pattern, which #438 lists as out of scope for the Claude path but which the other harnesses need.
4. **Turn-limit detection splits.** Claude reports it (stderr plus a non-zero exit), and Gemini has exit 53. opencode stops quietly with a summary, and Codex and Cursor have no turn cap. The contract should treat "turn cap" as optional, with a wall-clock timeout as the universal fallback, and a Stage that must report "stopped at its limit" (the Deep scan) should say so per harness.
5. **Skipping project config:**

   | Level | Harnesses |
   | --- | --- |
   | Clean | Claude (`--bare`), opencode (env vars) |
   | Partial | Codex (untrusted-by-default `.codex/`; `project_doc_max_bytes=0`) |
   | Absent | Gemini (a writing run must be trusted, which loads everything), Cursor (loads everything, including Claude's hooks) |

   For the last two, the Deep scan and the security Stages need the launcher to strip `.gemini/`, `GEMINI.md`, `.env`, `.cursor/` and `.claude/settings*.json` from the copy, or must refuse the harness.
6. **Structured output with a schema** exists only on Claude (`--json-schema`) and Codex (`--output-schema`). Every harness has a JSON or JSONL event stream for the transcript.
7. **Version pinning:** four harnesses pin through npm with updates off by config or env. Cursor can't be pinned per the docs, which by itself stops it reaching `supported` for a security Stage.

## 8. Newly surfaced (possible tickets)

- **Adopt `claude --restricted` and `onFailure: "block"`** on the Claude path. `--restricted` confines the file tools natively and loads only managed settings and `--settings`. `onFailure: "block"` closes the hook-timeout gap that `|| exit 2` leaves open (the default timeout is 600 s). This hardens the default path, so it may be out of #438's scope; see "Out of scope".
- **Codex hooks fail open on exit 2 with empty stderr.** Any port of our hooks to Codex must print a reason to stderr. The Codex adapter can't rely on hooks for a security Stage.
- **Gemini: a checkout can disable a system hook** (`hooksConfig.disabled` merges by UNION) and adds its own hooks after one warning. Decide whether a Gemini Stage strips `.gemini/` from the checkout, or puts every gate in admin policy.
- **Cursor runs Claude Code `settings.json` hooks from the checkout** in trusted headless runs, and its per-repo `sandbox.json` overrides the user's `readBoundary`. Combined with no version pin, that argues for Cursor at `documented` only, refused for security Stages, as #438's custom-harness rule already does.
- **Codex workload identity** (`OPENAI_IDENTITY_TOKEN_FILE` + federation rule) might let CI use GitHub OIDC instead of a stored `OPENAI_API_KEY`. Worth a check for the secrets design in ADR 0022.
- **Root-owned system config and dropping sudo** become a contract need for every non-Claude harness on a GitHub runner (point 3 above).

## 9. UNCONFIRMED (collected)

1. Whether a Codex `prefix_rule` with `forbidden` blocks a command that would run *inside* the sandbox (the docs scope rules to commands run outside it).
2. Whether `.agents/skills` discovery in Codex can be turned off as a whole.
3. Whether OpenAI workload identity federation accepts a GitHub Actions OIDC token.
4. How Gemini's policy engine splits compound shell commands for `commandPrefix` matching.
5. Whether Gemini's container sandbox can run nested inside the Deep scan container.
6. Whether Gemini's `context.fileName` can be set so no GEMINI.md loads.
7. Whether opencode plugins (`execute.before`) run under `opencode run --standalone`, and what happens when a plugin fails to load.
8. Whether opencode's JSON stream marks a run that hit its `steps` cap.
9. Whether Cursor hooks fire under `-p` specifically, and whether `/etc/cursor/hooks.json` is honoured without an Enterprise plan.
10. Whether Cursor's `Shell(git:push*)` grammar matches `git push <remote> <ref>`.
11. Cursor's Linux sandbox mechanism, and whether it works in a container.
12. Whether Cursor's `--disable-auto-update` still exists, and whether any way to pin a version exists.
13. Whether Cursor reads the prompt from stdin in `-p`.
