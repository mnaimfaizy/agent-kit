# Google (Gemini CLI, Antigravity, Jules): worktrees, parallel agents, and the `orchestrate` verbs

Research for the `orchestrate` skill ([HARNESSES.md](../../.claude/skills/orchestrate/HARNESSES.md)): how Google's three agent harnesses run agents in parallel and in isolated checkouts, and how the four verbs (`spawn`, `message`, `await`, `report`) map onto each.

- **Read on:** 2026-11-14. Neither docs site dates its pages (geminicli.com shows "Last updated: Apr 17, 2026" on its home page only), so a fact from a docs page is dated by the read, and by the version the page or changelog names.
- **Versions in force on the read date:**
  - **Gemini CLI** v0.68.0, the latest stable GitHub release (2026-11-10, [releases](https://github.com/google-gemini/gemini-cli/releases)). The docs changelog page still shows v0.64.0 (2026-10-13, [changelog](https://geminicli.com/docs/changelogs/latest/)), so repo docs were read at tag `v0.68.0`.
  - **Antigravity** App v2.32.0 and Antigravity CLI (`agy`) v1.5.8, both 2026-11-13 ([changelog](https://antigravity.google/docs/changelog/)).
  - **Jules:** read-only since 2026-11-11, shutting down 2026-12-31 (see section 3).
- **The state of the product line.** Google's blog (Dmitry Lyalin and Taylor Mullen, 2026-05-19, [Transitioning Gemini CLI to Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)) made Antigravity CLI the successor to Gemini CLI. On 2026-06-18, Gemini CLI stopped serving Google AI Pro and Ultra subscribers and free Gemini Code Assist users. It "will remain accessible via paid Gemini and Gemini Enterprise Agent Platform API keys" and for Code Assist Standard and Enterprise licences. The geminicli.com banner adds: "Gemini CLI has not been optimized for Gemini 4 Argon. To use Gemini 4 Argon, please use Antigravity." Antigravity CLI shares one agent harness with the Antigravity 2.0 desktop App. The post promises "Agent Skills, Hooks, Subagents, and Extensions (now as Antigravity plugins)", but not "1:1 feature parity right out of the gate".
- **Sources:** primary only.
  - The geminicli.com docs, and the `google-gemini/gemini-cli` repo at `v0.68.0` (its `docs/` and, where the docs are silent, its source; those facts are marked **read in source**).
  - The antigravity.google docs and changelog.
  - The jules.google docs and changelog, and the Jules API page on developers.google.com.
  - The Google Developers Blog.
  - No staff forum posts were needed.
- **Local install:** none of `gemini`, `agy`, `antigravity` or `jules` is on this machine (`which`, 2026-11-14), so no `--help` output was read. CLI facts come from the CLI reference pages and the changelogs.
- **UNCONFIRMED** marks anything no primary source states. Every one is listed again at the end.

The three are not equals on the read date. **Jules** takes no new work. **Gemini CLI** is maintained, but only for paid API-key and enterprise users. **Antigravity** (App, IDE, CLI) is where Google's parallel-agent features now ship. Each section covers all three; Antigravity gets the most room because it has the most to map.

## 1. Worktrees

**Gemini CLI** ([Git worktrees](https://geminicli.com/docs/cli/git-worktrees/), experimental):

- **Enable:** `"experimental": { "worktrees": true }` in `settings.json`, or **Enable Git Worktrees** in `/settings`. Turning it on is a persistent-config change, so the human approves it.
- **Start:** `gemini --worktree [name]` (`-w`).
- **Location:** `<project root>/.gemini/worktrees/<name>`, inside the main checkout. Whether `.gemini/worktrees/` is git-ignored is **UNCONFIRMED**. An unnamed one gets a generated name.
- **Branch, and the docs disagree with themselves.** The page says the name "becomes both the directory name … and the branch name", but its own cleanup example deletes branch `worktree-feature-search`. The source settles it: **read in source** (`packages/core/src/services/worktreeService.ts`, v0.68.0), it runs `git worktree add <path> -b worktree-<name>`. The base is the main checkout's `HEAD`, recorded as `baseSha`. An unnamed worktree gets a timestamp and a 4-character suffix as its name.
- **Headless:** worktree setup runs before the CLI splits into interactive and headless modes (`gemini.tsx`, **read in source**), so `-p` with `-w` should create one. No doc states it: **UNCONFIRMED** in practice.
- **Setup:** no setup hook. The page tells you to install dependencies and build in each new worktree yourself.
- **Cleanup:** exiting keeps the worktree and branch, and the CLI prints how to resume or remove them. An **unmodified** worktree (no changes, `HEAD` still at `baseSha`) is removed automatically (`maybeCleanup`, **read in source**). The page gives no limits.
- **Applying back:** not covered. Manual removal is `git worktree remove … --force` then `git branch -D`. The page also shows a plain `git worktree add ../x -b x` as the alternative.

**Antigravity App** ([Projects](https://antigravity.google/docs/projects/)):

- A conversation starts in **Local mode** (the agent works in your folders) or **New worktree mode**, which "Creates a new Git worktree for the conversation". With several repositories open, it makes one worktree per checkout.
- In the Knowledge Work layout (v2.30.0+), new conversations "run directly in your project's folders without showing the worktree selector".
- The page gives no path, branch naming, setup script, cap or merge-back: **UNCONFIRMED**.

**Antigravity subagents** ([Subagents](https://antigravity.google/docs/subagents/)):

- `invoke_subagent` takes a workspace mode: `inherit` (the parent's workspace), `branch` ("isolated Git worktree") or `share` (a new working copy that shares repository storage). The same modes appear in Dynamic Workflows' `agent(…, workspace=…)` ([Dynamic Workflows](https://antigravity.google/docs/dynamic-workflows/)).
- **Isolation is a tool parameter, not a request in words** as it is on Cursor.
- **Where they live:**
  - Under `.system_generated/worktrees` in the conversation's own storage (CLI changelog v1.1.26, 2026-09-04, and v1.2.2, 2026-09-12).
  - Moved under a `worktrees/` directory in v1.2.10 (2026-09-24).
  - The absolute path is **UNCONFIRMED**.
- **Branch naming:** not documented: **UNCONFIRMED**.
- **What a new worktree carries:** since CLI v1.5.5 (2026-11-10), "their worktree now includes your staged, unstaged, and untracked changes". App v2.29.0 fixed worktrees that "did not carry over uncommitted local changes". Whether git-ignored files (such as the run folder) are copied too is **UNCONFIRMED**.
- **Cleanup:** when a subagent is **killed**, "Temporary worktrees are cleaned up". CLI v1.1.26 also stopped orphaned worktrees piling up when subagents are killed or conversations deleted. In `/swarm`, "Removing a worker deletes its working copy" ([Swarm](https://antigravity.google/docs/swarm/)). **So a Delegation's work exists only in that worktree until it is pushed.**

**Antigravity CLI** ([CLI reference](https://antigravity.google/docs/cli/reference/)):

- There is **no `--worktree` flag**.
- Conversations are scoped "directly to your current working directory" ([Conversations](https://antigravity.google/docs/cli/conversations/)). So a headless run in a worktree the Chief of Staff makes with plain `git worktree add` keeps its history there, and is resumed from there.
- `/fork` copies the conversation, "not your local Git checkout".

**Jules** cloned into its own cloud VM and worked on a branch it pushed ([Getting started](https://jules.google/docs/)); there were no local worktrees.

**Ports, env, shared services:** none of the three documents per-worktree ports or env: **UNCONFIRMED**.

## 2. Subagents and parallel agents in a session

**Gemini CLI** ([Subagents](https://geminicli.com/docs/core/subagents/), v0.68.0 docs):

- **Built-in:** `codebase_investigator`, `cli_help`, `generalist`, and `browser_agent` ("disabled by default", needs Chrome 144+).
- **Custom:** Markdown with YAML frontmatter in `.gemini/agents/*.md` (project) or `~/.gemini/agents/*.md` (user). Fields:
  - `name`, `description`
  - `kind` (`local` or `remote`)
  - `tools` (wildcards allowed; inherits all when omitted)
  - `mcpServers`
  - `model` (default `inherit`)
  - `temperature`, `max_turns` (30), `timeout_mins` (10)
  - No worktree or isolation field.
- **Invocation:** the main agent calls the subagent as "a tool of the same name". `@agent_name` at the start of a prompt forces it.
- **Isolation:** "Isolation" means a separate context loop and tool set, not a separate checkout.
- **Nesting:** subagents "**cannot** call other subagents."
- **Not documented:** parallel or background runs, resume or follow-up after the result, messaging while running: **UNCONFIRMED** (none appear in the docs). v0.68.0 added "support SubagentStop event mapping" to hooks (release note, PR #30111); the hooks reference does not list it yet.
- **Remote subagents** speak A2A (`kind: remote`, `agent_card_url`) to an agent hosted elsewhere ([Remote subagents](https://geminicli.com/docs/core/remote-agents/)). They are not Gemini executors with a checkout.

**Antigravity** ([Subagents](https://antigravity.google/docs/subagents/), App and CLI):

- **Built-in:** `research`, `browser`, and `self` ("a clone of the calling agent with the same system instructions and toolset"). The parent starts one with `invoke_subagent` (a role and a prompt). The subagent "does not inherit the parent's existing conversation history".
- **Custom:** `.agents/agents/<name>.md` or `.agents/agents/<name>/agent.md` (workspace), `~/.gemini/config/agents/…` (global), or `plugins/<plugin>/agents/`. Fields:
  - `name`, `description`
  - `tools` (allowlist)
  - `mainAgent`, `subagent`
  - `model` (`inherit`, `flash` or `pro`)
  - `commandExecutionPolicy` (`off`, `auto`, `eager`, `sandbox`)
  - `mcpServers`, `skills` and `plugins`
  - `hooks` (App v2.17.0)
  - Project beats global on a name clash (section 5).
- **Model:** a **tier**, not a model id. Dynamic Workflows add `flash_lite`. Swarm workers may take any model in the picker. Whether `invoke_subagent` takes an exact model id is **UNCONFIRMED**.
- **Parallel and background:** "A parent agent can invoke multiple subagents concurrently." They run "asynchronously in the background".
- **States:** Running, then **Idle** (has "sent a result message to its parent agent, and paused execution"), then Killed (cannot be reawoken).
- **Message after finishing, and while running:**
  - An idle subagent "automatically re-awakens" on a message and keeps its context.
  - "The parent can interrupt a running subagent by sending a message".
  - Agents message each other by conversation ID and can read each other's transcripts.
  - In the App, the human opens the subagent's conversation and types into it (App v2.19.1, 2026-09-30: "send a message directly to a subagent from the message box"). In the CLI the human types `@<name> <text>`.
- **Nesting:** up to 10 levels, "strictly enforced".
- **Tools:**
  - Shell is `run_command`, under `commandExecutionPolicy`. There is no git tool.
  - Browser: the `browser` subagent, through `/browser` in the CLI.
  - Subagents inherit the parent's "allowed terminal command prefixes, file read/write directory scopes, and sandbox settings", and approval requests "bubble up".
  - The CLI's main agent "decides which tools and permissions each subagent gets".
- **Known issue on the page:** a misspelled tool name in `tools` "may cause the subagent process to hang".
- **Monitoring:** `/agents` (the CLI's Agent Manager) lists subagents as `running`, `done`, `error` or `killed`, with approvals inline ([/agents](https://antigravity.google/docs/cli/commands/agents/)).
- **Orchestrators on top:**
  - `/swarm`: a coordinator, named workers and a `@verifier` on a message board. Pro and Ultra, preview. App v2.31.0, CLI v1.5.5.
  - `/teamwork`: long projects in `~/teamwork_projects/<name>`. Paid plans.
  - `/boost`.
  - `/run-workflow` (Dynamic Workflows: a Python script with `agent()`, `parallel()`, `pipeline()`). Pro and Ultra.
- **Writing outside the working copy:** "Non-workspace file access defaults to Ask" in App and CLI; only the **Turbo** preset grants full filesystem access ([Permissions](https://antigravity.google/docs/permissions/)). A `write_file(<abs path>)` allow rule pre-approves one folder.
- **Sandbox:** under Default and Auto, commands run in a sandbox limited to the workspace and temp folders, **with no network**. So `git push` needs `command(git push)` in the allow list, which runs "inside or outside the sandbox".

**Jules** had no in-session subagents. `jules remote new --parallel <n>` started n sessions on one prompt ([CLI reference](https://jules.google/docs/cli/reference)).

## 3. Cloud and remote agents

**Jules, shutting down.**

- The changelog entry "Jules Turndown" (2026-10-29, [changelog](https://jules.google/docs/changelog/)) says:
  - "Jules will wind down on December 31, 2026."
  - "After November 11, 2026, we will be turning Jules to read-only until the end of the year."
  - An export tool, run from a CLI coding agent such as Antigravity CLI, saves settings, setup scripts and sessions; code and PRs stay in GitHub.
- On the read date it can take no new Delegations, so the rest of this list is history, recorded for completeness.
- **API:** `https://jules.googleapis.com/v1alpha` ("alpha … experimental", `X-Goog-Api-Key`, at most 3 keys). Sessions take `prompt`, `sourceContext.githubRepoContext.startingBranch`, `automationMode: AUTO_CREATE_PR` and `requirePlanApproval`. Calls are `:sendMessage` and `:approvePlan`; progress came from polling `GetSession` or `ListActivities`, with no webhook or stream ([Jules API](https://developers.google.com/jules/api)).
- **PR work:** it acted on PR review comments (2025-09-23) and fixed its own PRs' CI failures (2026-02-19).
- **Limits:** 3, 15 or 60 concurrent tasks by plan ([Usage limits](https://jules.google/docs/usage-limits/)).

**Antigravity Remote Agents** ([Remote Agents](https://antigravity.google/docs/remote-agents/), CLI 1.4.12+):

- **What they are:** sessions in a "Google-managed remote environment" that keep running while the laptop sleeps.
- **Who gets them:** Google AI Pro and Ultra on a personal account, "rolling out gradually" (App v2.29.0, 2026-11-03; v2.30.0). Not on free, AI Plus or business accounts.
- **Starting one:**
  - From the App: a remote project, or a GitHub repository chosen in the project picker.
  - From the web: antigravity.google.com.
  - From the CLI: `agy --remote-agent` (in `--help` since CLI v1.5.0, 2026-11-04).
  - Continued with `-c`, `--conversation=<id>` or `/resume`, from CLI, App or web.
- **Can a local agent start one programmatically?** The docs name no API and no Slack route. Print mode is unavailable in CLI remote sessions, so a shell call cannot start one headlessly.
- **What they cannot reach:**
  - They "can't read or change files on your machine". Repositories are cloned in; other files must be attached (8 MiB each, 20 MiB in remote sessions since v1.5.3).
  - Local MCP servers and local skills are unavailable (skills from connected cloud plugins load since v1.5.2).
- **Branches, PRs, completion notification:** not documented: **UNCONFIRMED**.
- **Cost:** plan quota, then AI credits at Gemini Enterprise rates ([Plans](https://antigravity.google/docs/plans/)).

**Antigravity Remote Control** is not a cloud agent. It lets the human drive a **local** App or CLI session from a browser on another device ([Remote Control](https://antigravity.google/docs/remote-control/)):

- Start it with `agy --remote-control`, `/remote-control`, or `agy remote-control start` as an OS service.
- Prompts typed remotely "stream live into your local terminal TUI", and approvals can be answered from either side.
- It is behind a feature flag ("Remote control is not enabled for your account").

**Gemini CLI** has no cloud agent of its own. Its "Gemini Code Assist for GitHub" stopped taking new installs on 2026-06-18 for individual accounts (blog, above).

## 4. Headless CLI as a tier 2 Executor

**Gemini CLI** ([Headless](https://geminicli.com/docs/cli/headless/), [CLI reference](https://geminicli.com/docs/cli/cli-reference/), [Session management](https://geminicli.com/docs/cli/session-management/)):

- **Start:** `gemini -p "<brief>" -m <model> -o json|stream-json [--approval-mode default|auto_edit|yolo|plan] [--include-directories <dir>] [-w <name>]`.
  - `-y`/`--yolo` is deprecated in favour of `--approval-mode=yolo`.
  - `--allowed-tools` is deprecated in favour of the Policy Engine.
  - `--skip-trust` trusts the folder for one run.
- **Output:**
  - `json` returns `response`, `stats` and `error`, and **no session id is documented** in it.
  - `stream-json`'s `init` event carries "Session metadata (session ID, model)".
  - **So the handle must come from the `init` event,** or from `gemini --list-sessions` run in the same folder.
  - Exit codes: 0 success, 1 error, 42 input error, 53 turn limit.
- **Resume:** `gemini -r <session-uuid> -p "<text>"` (the reference's own example is `gemini -r "abc123" "Finish this PR"`); `-r latest` or an index also work.
  - Sessions live in `~/.gemini/tmp/<project_hash>/chats/` and are "project-specific". So resume from the same folder the run started in; the worktree page says to `cd` into the worktree first.
  - Default retention is 30 days (`sessionRetention.maxAge`).
- **Permissions:**
  - A source comment says "ShellTool is excluded in non-interactive mode unless 'YOLO mode' is active" (`nonInteractiveCliCommands.ts`, **read in source**). So a headless Executor that runs tests, commits and pushes needs `--approval-mode yolo`, a choice the human approves in the Dispatch Plan. That a finer policy rule can replace YOLO for `git push` is **UNCONFIRMED**.
  - `--include-directories <run folder>` adds the run folder to the workspace, so the run can write `report.md` there. That this lifts every out-of-workspace refusal is **UNCONFIRMED**.
- **Verdict for Q4:** yes, Gemini CLI fits tier 2. Start each run in its own worktree, take the handle from `stream-json`, and resume by UUID from that worktree. Two Gemini-specific checks remain: YOLO for shell, and the handle being absent from plain `json`.

**Antigravity CLI** ([Headless](https://antigravity.google/docs/cli/headless/), [CLI reference](https://antigravity.google/docs/cli/reference/)):

- **Start:** `agy -p "<brief>" --model <id> --output-format json|stream-json [--mode accept-edits|auto|plan] [--add-dir <dir>] [--agent <name>] [--effort <level>] [--print-timeout <d>] [--json-schema <s>]`.
  - Since CLI v1.5.7 (2026-11-12) headless runs "start in Auto" by default.
  - `auto` "isn't available to business or enterprise accounts".
- **Output:**
  - The `json` envelope carries `conversation_id`, `status`, `response`, `num_turns`, `usage` and `duration_seconds`, plus `finished_reason` (v1.4.11) and `denied_actions` (v1.1.27).
  - `stream-json` emits `init`, then `step_update`, then `result`.
  - **The handle is `conversation_id`.**
- **Resume:** `agy -p "<text>" --conversation <id>` (or `-c`), each in a new process, from the same folder (conversations are scoped to the working directory). `--input-format stream-json` keeps several turns in one process.
- **Permissions:**
  - "there is no interactive prompt in headless mode". An action needing approval is **soft-denied**: the run goes on and exits 0, with a notice on stderr and an entry in `denied_actions`.
  - Pre-approve with `permissions.allow` rules in `~/.gemini/antigravity-cli/settings.json`, such as `command(git)`, `command(git push)` and `write_file(<run folder>)`. Or use `--dangerously-skip-permissions`, which "approves all tool calls". Both are the human's choice.
  - Headless runs use cached credentials: an unauthenticated run "exits with an `authentication required` error".
- **Skills and slash commands in `-p`:** since CLI v1.1.9 (2026-07-31), print mode expands slash commands and skills; `--disable-slash-commands` turns that off. Section 5 has the catch.
- **Verdict for Q4:** yes, Antigravity CLI fits tier 2, and better than Gemini CLI: the handle is in the JSON, and refusals are reported rather than silent. It has no worktree flag, so the Chief of Staff makes the worktree and starts `agy` inside it.

**Jules CLI** (`jules remote new --repo … --session "<prompt>"`, `jules remote pull --session <id>`) was a cloud-start tool, not a headless local run. It is read-only now.

## 5. Skills and slash commands

**Gemini CLI** ([Skills](https://geminicli.com/docs/cli/skills/), [Custom commands](https://geminicli.com/docs/cli/custom-commands/)):

- **Directories,** lowest to highest precedence: built-in, extension, user (`~/.gemini/skills/` or the `~/.agents/skills/` alias), workspace (`.gemini/skills/` or `.agents/skills/`). Within one tier, `.agents/skills/` beats `.gemini/skills/`. **`.claude/skills/` is not read.**
- **Frontmatter:** only `name` and `description` are documented. No `disable-model-invocation` handling exists in the repo (code search on `google-gemini/gemini-cli`, 2026-11-14). So a skill marked user-invoked elsewhere is offered to the model here.
- **Activation:** the model calls `activate_skill`, and the user approves a consent prompt.
- **Interactive `/<skill>`:** `SkillCommandLoader` turns each skill into a slash command that calls `activate_skill` (**read in source**).
- **Headless:** `handleSlashCommand` loads only built-in, MCP-prompt and TOML-file commands, **not** skill commands (`nonInteractiveCliCommands.ts`, **read in source**). So `gemini -p "/qa-plan 12"` does not run the skill as the user's invocation; what the model makes of the bare text is **UNCONFIRMED**.
- **Custom commands:** TOML (`prompt`, `description`, `{{args}}`) in `.gemini/commands/` or `~/.gemini/commands/`; the project one wins. These **are** expanded in `-p` (`FileCommandLoader`, **read in source**).

**Antigravity** ([Skills](https://antigravity.google/docs/skills/), [Customization discovery](https://antigravity.google/docs/customization-discovery/)):

- **Directories:**
  - Workspace `.agents/skills/` (also `.agent/`, `_agents/`, `_agent/`), and the same in each parent folder up to the repository root.
  - Global `~/.gemini/config/skills/`.
  - Plugins, whose skills are named `<plugin>:<skill>`.
  - CLI only: `~/.gemini/skills/` and `~/.gemini/antigravity-cli/skills/`.
  - **`.claude/skills/`, `~/.claude/skills/` and `~/.agents/skills/` are not listed.** Claude Code skills arrive only by importing them into a plugin (App v2.30.0; CLI v1.5.5 and v1.5.6).
- **Precedence on a name clash:** a personal folder inside the repository, then workspace, then `~/.gemini/config/`, then built-in. In the CLI, `~/.gemini/skills/` beats all of them.
- **Frontmatter:** `name` and `description` are documented. `disable-slash-command: true` (CLI v1.1.12) hides a skill from the `/` menu "while leaving it invocable by the model", the opposite of what `qa-plan` and `manual-qa` need. `disable-model-invocation` appears nowhere: **UNCONFIRMED** whether it is honoured, and likely not.
- **Invocation:** each skill is a slash command; the agent may also apply one on its own. In `-p`, `/skill` text is expanded (v1.1.9).
- **The distinction the skill relies on may not exist here.** Since nothing documents a model-invocation block, a headless `agy -p "/qa-plan 12"` is the same expansion a user's typing would get. But the skill must first be found, under `.agents/skills/` or `~/.gemini/config/skills/`, not `.claude/skills/`.

**Jules** read `AGENTS.md` at the repository root; skills are not documented.

## 6. Events the parent can wait on

- **Gemini CLI:** the parent waits on the background process; the end of `stream-json` (the `result` event) or the exit code marks it done.
  - Hooks ([reference](https://geminicli.com/docs/hooks/reference/), in `settings.json`): `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `BeforeModel`, `BeforeToolSelection`, `AfterModel`, `Notification`, `PreCompress`. `AfterAgent` can force a retry.
  - A `SubagentStop` mapping landed in v0.68.0 but is undocumented.
  - No CI or PR subscription.
- **Antigravity subagents:** an idle subagent has "sent a result message to its parent agent". App v2.30.0 shows "subagent messages and background-task completions" in the conversation.
  - Whether a result **wakes an idle main conversation** with no user input is **UNCONFIRMED**.
  - `/schedule` gives a documented wake ([/schedule](https://antigravity.google/docs/commands/schedule/)). A one-shot timer's `TimerCondition` takes "the ID of a specific subagent or background task", and a matching message "cancels the timer early and wakes the agent". Schedules are "Conversation-scoped".
- **Antigravity hooks** ([Hooks](https://antigravity.google/docs/hooks/), `.agents/hooks.json` or `~/.gemini/config/hooks.json`):
  - Events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation` (`force_continue`), `Stop` (`decision: "continue"` re-enters the loop).
  - There is no subagent start or stop event; `invoke_subagent` can only be matched as a tool name.
  - Adding a hook is a persistent-config change.
- **CI and PR comments:**
  - None of the three local surfaces documents a CI or PR **subscription**.
  - `/schedule` documents cron polling that wakes the same conversation, e.g. "poll the CI status for PR #482 and tell me when it goes green". That is the Chief of Staff's route for CI, and for review comments read with `gh`.
  - Automations start "a fresh agent conversation" on a schedule only, with no GitHub-event triggers ([Automations](https://antigravity.google/docs/commands/automation/)), so they cannot wake the Chief of Staff.
  - Jules's PR-comment handling ends with Jules.
- **Notifications for the human:** Antigravity CLI alerts on pending questions (v1.3.1) and reports working, waiting, done or failed over OSC 7501 (v1.4.0). The App has a Notifications settings page (v2.26.0).

## Recommendation: the four verbs on Google's harnesses

Four ways to run an Executor:

|                               | (a) Antigravity subagent, `branch` workspace                                        | (b) `agy -p` headless                                 | (c) `gemini -p` headless                                            | (d) Antigravity Remote Agent               |
| ----------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| Own branch and working copy   | Yes, by tool parameter; path and branch name undocumented.                          | Only in a worktree the Chief of Staff makes.          | `-w <name>` (branch `worktree-<name>`), or a worktree made by hand. | Cloud clone; branch handling undocumented. |
| Model per Delegation          | A tier: `inherit`, `flash`, `pro`.                                                  | `--model <id>`.                                       | `-m <id>`.                                                          | Picker; unconfirmed.                       |
| Human can open and talk to it | Yes: App message box, CLI `@name`.                                                  | No (Remote Control drives interactive sessions only). | No.                                                                 | Yes: App, web, CLI.                        |
| `message` after it ends       | A message re-awakens the idle subagent.                                             | `--conversation <id>`.                                | `-r <uuid>`, from the same folder.                                  | `--conversation=<id>`.                     |
| `message` while it runs       | Yes: interrupts it.                                                                 | No.                                                   | No.                                                                 | **UNCONFIRMED**                            |
| `await` without polling       | Result message to parent; `/schedule` `TimerCondition` on its id.                   | Wait on the process.                                  | Wait on the process.                                                | **UNCONFIRMED**                            |
| Reaches the run folder        | Writes Ask by default; a `write_file` allow rule.                                   | `--add-dir` plus a `write_file` rule.                 | `--include-directories`.                                            | No: report as last message.                |
| User-invoked skills           | Only if found in `.agents/skills`; the model block is undocumented.                 | `-p "/qa-plan 12"` expands, if found.                 | Not in `-p` (read in source).                                       | Local skills unavailable.                  |
| Local QA Stack and browser    | Same machine; `/browser` through Chrome DevTools MCP, with the human's Allow click. | Same machine; browser unconfirmed.                    | Same machine; `browser_agent` off by default.                       | No.                                        |
| PR review comments and CI     | Chief of Staff polls by `/schedule`.                                                | No.                                                   | No.                                                                 | Undocumented.                              |
| Needs                         | Antigravity, signed in; allow rules for push and the run folder.                    | `agy` signed in once interactively.                   | Paid API key or enterprise licence; YOLO for shell.                 | Pro or Ultra, personal account.            |

Jules is not a column: it accepts no new work after 2026-11-11.

**Per Delegation, with the Chief of Staff in Antigravity (App or CLI):**

- **Building.**
  - `spawn`: ask the main agent to call `invoke_subagent` with workspace `branch`, type `self` (or a custom `.agents/agents/delegation.md` that lists the tools it needs exactly; a misspelled tool name hangs it), and the plan's model as a tier. The handle is the subagent's name and conversation id.
  - Straight after `spawn`, check its working directory is not the Chief of Staff's checkout. Have the brief's first step put the work on the Delegation's branch (`git switch -c <branch>`), since the generated branch name is undocumented.
  - `message`: send to the subagent by id; it wakes from idle, or is interrupted if running.
  - `await`: end the turn on the result message. Where that does not wake the conversation, set a `/schedule` timer whose `TimerCondition` is the subagent's id.
  - `report`: the absolute path, allowed by a `write_file(<run folder>)` rule; or, failing that, the result message.
  - Push early: killing the subagent deletes its worktree. `git push` needs `command(git push)`, because the sandbox has no network.
- **Analysis.** The `research` built-in (read-only) or `self` with `inherit` for a read-only question; `branch` for anything that runs code. Same `message`, `await` and `report`.
- **QA.** Not a subagent; the skill's rule stands.
  - `spawn`: `agy -p "<brief>" --model <id> --output-format json --add-dir <run folder>` as a background process, in a worktree the Chief of Staff made with `git worktree add` at the head under test.
  - `message`: `agy -p "/qa-plan <n>" --conversation <id>` from that worktree, and later `/manual-qa <plan file>`.
  - It works only if `qa-plan` and `manual-qa` are found under `.agents/skills/` or `~/.gemini/config/skills/`.
  - The browser is Chrome DevTools MCP against the human's running Chrome, with an **Allow** click within 60 seconds ([/browser](https://antigravity.google/docs/commands/browser/)). So the human must be present anyway.
  - Fallback, as HARNESSES.md names it: a session the human starts in that worktree, where the human types the two commands.

**Per Delegation, with the Chief of Staff in Gemini CLI:** tier 2, like the Claude Code CLI.

- `spawn`: `git worktree add` on the Delegation's branch, then `gemini -p "<brief>" -m <id> -o stream-json --approval-mode yolo --include-directories <run folder>` in it, in the background, with output written to `delegations/<id>/output.jsonl`. The handle is the `init` event's session id.
- `message`: `gemini -r <id> -p "<text>"` from the worktree.
- `await`: process end.
- `report`: the file, or `response`.
- Prefer a hand-made worktree over `-w`: it names the branch, and it stays out of `.gemini/worktrees/` inside the Chief of Staff's checkout.
- Analysis: a `codebase_investigator` or `generalist` subagent, blocking.
- QA: a session the human starts (`gemini` in the worktree, the human types `/qa-plan <n>`). `-p` does not run skills, and `.claude/skills` is not read: install to `.agents/skills`.

## Tier

- **Antigravity (App and CLI): tier 1 on its documentation, pending a first run.**
  - It starts parallel subagents in their own worktrees by a tool parameter.
  - The human can open each one and type into it while it works (App message box, CLI `@name`, Remote Control from a browser).
  - The parent gets a result message when one goes idle, and `/schedule` can wait on a subagent id.
  - That is the tier 1 definition, and more than Cursor documents.
  - Three things keep it short of a plain "tier 1": models are tiers, not ids; worktree paths and branch names are undocumented; and whether a result wakes an idle Chief of Staff is unconfirmed.
  - The CLI is also a good tier 2 Executor for QA.
- **Gemini CLI: tier 2.** Headless start, resume by UUID, and its own worktrees are all documented. Its subagents are blocking helpers with no documented parallelism, messaging or worktree. Since 2026-06-18 it is available only on paid API keys and enterprise licences.
- **Jules: unusable.** Read-only since 2026-11-11, gone after 2026-12-31. Do not write a HARNESSES.md block for it.

## Verdict: cloud agents, or local?

**Local, on every Google harness.** No Google cloud agent can serve as an Executor on the read date.

**For local (Antigravity subagents and `agy -p`):**

- Isolation is a parameter (`branch`), not a request in words.
- Messaging an idle or running subagent is documented.
- `/schedule` gives a documented wake-up for both subagent ends and CI polling.
- They see the local QA Stack, the human's Chrome, and the run folder (with an allow rule).
- No extra plan for subagents; `/swarm` and Dynamic Workflows need Pro or Ultra.

**Against local:**

- **Skills are found only under `.agents/skills` and `~/.gemini/…`,** not `.claude/skills`. The kit's skills must be installed there or imported as a plugin, and `disable-model-invocation` is not documented as honoured.
- **Killing a subagent deletes its worktree.** A Delegation pushes as soon as it has a commit.
- **The sandbox blocks the network,** so pushing needs an allow rule. That, the run-folder write rule, and any hook are persistent config the human approves.
- **No PR or CI subscription;** the Chief of Staff polls by `/schedule`.
- **Models are coarse tiers** for subagents.

**For cloud (Antigravity Remote Agents):**

- They survive the laptop closing.
- They are reachable from App, web and CLI.

**Against cloud:**

- Pro and Ultra personal accounts only, still "rolling out".
- No API, and no print mode, so a local Chief of Staff cannot start or follow one from a shell.
- No local files, skills, MCP servers or QA Stack.
- Branch, PR and notification behaviour undocumented.
- **Jules,** the one Google cloud agent with an API, PR-comment handling and CI fixing, is shutting down.

**So:** default to (a) for building and analysis and (b) for QA when the Chief of Staff runs in Antigravity; to (c) when it runs in Gemini CLI. Offer (d) only if the human asks, and only after a first run has shown how it lands its branch.

## UNCONFIRMED

1. Path and branch naming of Antigravity worktrees (App New worktree mode, and subagent `branch` mode); only `.system_generated/worktrees` and a later `worktrees/` folder appear in changelogs.
2. Whether a subagent's `branch` worktree copies git-ignored files (such as the run folder) from the parent's checkout.
3. Whether an Antigravity subagent's result wakes an idle main conversation with no user input, without a `/schedule` timer.
4. Whether `invoke_subagent` takes an exact model id, or only `inherit`, `flash` and `pro`.
5. Whether Antigravity honours `disable-model-invocation` (undocumented; `disable-slash-command` is its own, opposite flag).
6. Whether Antigravity reads `.claude/skills/` or `~/.agents/skills/` (not listed in its discovery paths).
7. Whether `agy -p "/qa-plan 12"` counts as the user's own invocation of a skill (print mode expands skills since v1.1.9; nothing marks the difference).
8. A browser in `agy -p` and `gemini -p` runs; the Chrome DevTools MCP route needs a human's Allow click.
9. Whether `gemini -p` with `-w` creates a worktree in practice (read in source only).
10. Whether `.gemini/worktrees/` is git-ignored in the main checkout.
11. What `gemini -p "/qa-plan 12"` does with skill text that is not expanded, and whether the model's `activate_skill` consent prompt can be passed headless.
12. Whether a Gemini CLI policy rule can allow `git push` and tests headless without `--approval-mode yolo`.
13. Whether `--include-directories` lets a Gemini headless run write to the run folder without approval.
14. Gemini CLI subagents: parallel or background runs, follow-ups after the result, messages while running.
15. Gemini CLI `SubagentStop` hook event (in the v0.68.0 release notes, not in the hooks reference).
16. Antigravity Remote Agents: branch and PR behaviour, completion notification, and any programmatic start.
17. Port and env isolation between worktrees' dev servers, on all three.
18. Whether Antigravity's `/schedule` timers run in headless `agy -p`, and what happens to them when the conversation is closed.
