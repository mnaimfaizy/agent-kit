# OpenCode: worktrees, parallel agents, and the `orchestrate` verbs

Research for the `orchestrate` skill ([HARNESSES.md](../../.claude/skills/orchestrate/HARNESSES.md)): how OpenCode runs agents in parallel and in isolated checkouts, and how the four verbs (`spawn`, `message`, `await`, `report`) map onto it.

- **Read on:** 2026-11-14. OpenCode's docs pages carry no publish date or version, so a fact from a docs page is dated by the read and by the release current that day: **v2.3.0** (released 2026-11-13, [release notes](https://github.com/anomalyco/opencode/releases/tag/v2.3.0)).
- **Two product lines.** OpenCode 2 (first tag `v2.0.0`, committed 2026-09-11; GitHub releases from v2.2.0, 2026-10-27) is current, and its docs are at `opencode.ai/docs/...`. OpenCode 1 is still released (latest v1.19.5, 2026-10-28) and its docs moved to `opencode.ai/v1/docs/...`. The two "are no longer installed side by side by default" ([Migrate from V1](https://opencode.ai/docs/migrate-v1)). This study is about **v2** unless a line says v1.
- **Repository:** `sst/opencode` now redirects to **`anomalyco/opencode`** (default branch `dev`). Source facts cite files at commit `cbe7159` (`dev`, 2026-11-14), as `src: <path>`, which is `https://github.com/anomalyco/opencode/blob/cbe71595e1f370ff91b3081872b96bbe56519c41/<path>`. The docs pages are built from `services/site/src/docs/content/*.mdx` in the same tree (v1: `services/site/src/docs/v1/content/`), so docs and source were read at one commit. The live site was spot-checked against it ([Tools](https://opencode.ai/docs/tools) matched).
- **Local install:** `opencode` **1.17.4** (v1, released 2026-06-12) at `~/.opencode/bin/opencode`. Its `--help`, `run --help`, `serve --help`, `session`, `agent create`, `github run`, `pr` and `attach --help` were read. The v2 CLI is not installed, so v2 CLI facts come from the docs and the CLI source (`packages/cli/src/commands/commands.ts`).
- **Sources:** primary only: docs, release notes, source. No staff forum posts were needed; OpenCode has no official forum comparable to Cursor's.
- **UNCONFIRMED** marks anything no primary source states, and **source only** marks a fact read in the code but not in the docs (it may change without notice). Every UNCONFIRMED item is listed again at the end.

## 1. Worktrees

**Built in, v2 only.** Git is the built-in strategy; a plugin can register another ([Config: Worktrees](https://opencode.ai/docs/config#worktrees), [Server plugins: Worktrees](https://opencode.ai/docs/build/plugins/server#worktrees)). v1 has no worktree feature in its docs or its 1.17.4 `--help`.

**Ways to make one (v2):**

- **CLI:** `opencode run --worktree [name]` (alias `-w`): "Start a new session in a new git worktree, optionally with this name". It cannot be combined with `--continue` or `--session` (src: `packages/cli/src/commands/commands.ts`, `packages/cli/src/run/run.ts`). **Source only**: the [CLI commands](https://opencode.ai/docs/cli/commands) page does not list the flag. The created path is printed to stderr as `worktree <root>` (src: `packages/cli/src/run/ui.ts`).
- **From inside a session:** the Code Mode `opencode` namespace has `worktree_create` (`name`, returns `directory`), `worktree_list`, `worktree_remove` (`force` discards uncommitted changes), and `session_move`, which moves the current or a named session to another directory "at a safe boundary". The docs' own example: "Create a worktree named "login" and move this session into it" ([Tools: Sessions, Worktrees](https://opencode.ai/docs/tools#worktrees)).
- **API, SDK and plugins:** `worktree.create({ projectID, name, directory?, from?, branch? })`, `list`, `refresh`, `remove` ([SDK](https://opencode.ai/docs/build/sdk#worktrees), [Server plugins](https://opencode.ai/docs/build/plugins/server#operations)). From a shell, `opencode api <operation>` calls the running server ([CLI commands: api](https://opencode.ai/docs/cli/commands#api)).
- **TUI and desktop:** the TUI has a worktree-name dialog (src: `packages/tui/src/component/dialog-worktree-name.tsx`). How a human starts a worktree session from the TUI or desktop app is not documented: **UNCONFIRMED**.

**Where they live.** Without config, under the server's data directory at `worktree/<first six characters of the project ID>/<name>`. `worktree.directory` in `opencode.jsonc` sets the parent directory instead; relative paths resolve against the project's canonical checkout, and changing it does not move existing worktrees ([Config](https://opencode.ai/docs/config#worktrees)). With no name, a random slug is used; on a clash `-2` … `-10` is appended, and creation fails after that (src: `packages/core/src/worktree.ts`).

**Branch naming: none.** The Git strategy runs `git worktree add --detach -- <dir> <ref ?? HEAD>` (src: `packages/core/src/git.ts`, `Git.worktree.create`). A worktree therefore starts on a **detached HEAD**, at the given ref, or else the HEAD of the source checkout. `opencode run --worktree` passes `from: <project directory>` and no ref, so it starts at the **canonical checkout's current HEAD** (src: `packages/cli/src/session-target.ts`, `createWorktreeLocation`). The Executor must create its branch itself (`git switch -c <branch> <base>`). **Source only.**

**Setup scripts.** The project record has `commands.start`, a "Startup script to run when creating a new workspace (worktree)" (src: `packages/schema/src/project.ts`). After creating a worktree, OpenCode runs it with `bash -lc` in the worktree, with `OPENCODE_WORKTREE_BASE` (source checkout) and `OPENCODE_WORKTREE_PATH` set, and a non-zero exit fails the creation (src: `packages/core/src/worktree.ts`). **Source only**: where a user sets it (the desktop app's project settings, judging by its i18n strings, or `project.update` through the API) is not documented: **UNCONFIRMED**. No `worktrees.json`-style file exists.

**Cleanup and limits.** No cap and no automatic cleanup are documented or in the worktree code. A worktree stays until `worktree_remove` / `worktree.remove` (which uses the strategy that made it) or `git worktree remove`. `refresh` prunes inventory entries whose directories are gone ([Server plugins: Operations](https://opencode.ai/docs/build/plugins/server#operations)). `worktree_remove` is checked against the `edit` permission on the worktree directory; the other worktree utilities ask no permission ([Tools](https://opencode.ai/docs/tools#worktrees)).

**Applying changes back.** No apply or merge command exists. A worktree is an ordinary Git worktree of the same repository, so the Executor commits on its branch and pushes, as the skill already requires.

**Ports and env.** No per-worktree port or env mechanism beyond the startup script's two variables: **UNCONFIRMED** that anything else isolates dev servers.

## 2. Subagents (the `subagent` tool)

From [Agents](https://opencode.ai/docs/agents) and [Tools: Subagent](https://opencode.ai/docs/tools#subagent) unless noted. v1 calls the tool `task` and the permission `task`; v2 renamed both to `subagent` ([Permissions](https://opencode.ai/docs/permissions)).

- **Built-ins:** `general` (subagent: broad tools, "cannot launch more subagents") and `explore` (subagent: read, search, shell and web only, no edits). Primary agents: `build` and `plan`. Hidden: `compaction`, `title`, `summary`.
- **Custom agents:** Markdown with YAML frontmatter at `~/.config/opencode/agents/<name>.md` (global) or `.opencode/agents/<name>.md` (project, searched from the current directory up to the project root; a nested path becomes part of the ID, `team/reviewer`). Or JSONC under `agents` in any config file. Fields: `description`, `mode` (`primary` default for a new agent, `subagent`, `all`), `model` (`provider/model#variant`), `system` (the Markdown body), `permissions` (ordered rules), `steps`, `hidden`, `color`, `disabled`, `request`. v1 also reads `agent/`, `mode/` and `modes/` folders ([Migrate from V1](https://opencode.ai/docs/migrate-v1#agent-files)). **Not** read: `.claude/agents/`. There is **no worktree, isolation or directory field**.
- **Model:** the agent's `model`, else the parent session's model. The tool also takes a `model` parameter, whose description tells the model: "NEVER set this unless the user explicitly asks for a particular model" (src: `packages/core/src/tool/plugin/subagent.ts`). The Dispatch Plan the human approved is that explicit ask; the brief should say so.
- **Background and parallel: always.** Since v2.3.0 (2026-11-13, [#63382](https://github.com/anomalyco/opencode/pull/63382)): "Subagents now return immediately, continue in the background, and report back whenever they become idle." The call returns a `sessionID`, and the parent gets a `<subagent>` message "when the child goes idle, and again after each later round of work". Several may run at once. Since v2.3.0, a child that goes idle with its own background work still running says so, "so the parent waits for the final report" ([v2.3.0 notes](https://github.com/anomalyco/opencode/releases/tag/v2.3.0)).
- **Own worktree: no, not by default.** The child is created with `parentID`, title, agent and model only, so it works in the parent's location (src: `packages/core/src/tool/plugin/subagent.ts`, `sessions.create`). A child could make its own with `worktree_create` and then `session_move` itself into it ([Tools](https://opencode.ai/docs/tools#sessions)); that a **child** session can be moved this way, and that its later shell and edit calls then run there, is **UNCONFIRMED**.
- **Message after it ends, and while it runs: both.** "Pass the returned `sessionID` to continue that same child conversation; a follow-up to a running child joins its current run" ([Tools](https://opencode.ai/docs/tools#subagent)). The tool's own text: "To send it follow-ups or change its instructions while it runs, call subagent again with this sessionID." Only the parent that made the child can do this (src: the tool rejects a `sessionID` whose `parentID` differs).
- **Nesting:** default depth 1, so a subagent cannot start another; `experimental.subagent_depth` raises it ([Config](https://opencode.ai/docs/config#subagent-depth)).
- **Tools:** a custom subagent "uses its own permissions, not a subset of its parent's" ([Permissions](https://opencode.ai/docs/permissions#agents)). The base policy for every agent is allow-all except asking for `.env` reads, so shell, `git commit` and `git push` are allowed unless config narrows them ([Permissions: Defaults](https://opencode.ai/docs/permissions#defaults)). `general` additionally denies questions and subagents.
- **Writing outside the working copy:** `external_directory` is **allowed by default**: "reads and edits outside the Location and worktree proceed without a prompt" ([Permissions: Directories](https://opencode.ai/docs/permissions#directories)). A Delegation can write `delegations/<id>/report.md` in the Chief of Staff's checkout by absolute path unless the repository's config adds an `ask` or `deny`.
- **Browser:** the Code Mode `browser` namespace "controls the browser attached by the OpenCode desktop app" (tabs, snapshots, clicks, forms, screenshots, console, network, Lighthouse) ([Tools: Browser](https://opencode.ai/docs/tools#browser)). Whether it exists when no desktop app is attached (a TUI or `opencode run` session) is **UNCONFIRMED**. MCP tools reach subagents through Code Mode, so a Playwright MCP server is the fallback (the migration guide's MCP examples use `@playwright/mcp`, [Migrate from V1](https://opencode.ai/docs/migrate-v1#mcp-servers)).
- **The human:** v1 lets the human step into child sessions in the TUI (`session_child_first`, `session_child_cycle`) ([v1 Agents](https://opencode.ai/v1/docs/agents)). v2.3.0 fixed "directly driven child sessions not resuming after a restart", which implies a human can drive a child directly; that a human can type into a running v2 child from the TUI or desktop is **UNCONFIRMED**.
- **v1 difference:** the v1 `task` tool and `@agent` mentions start child sessions; whether a v1 subagent runs in the background is not stated: **UNCONFIRMED**.

## 3. Cloud and remote agents

- **OpenCode has no cloud agent.** No docs page, release note or CLI command offers a hosted agent that clones the repository and opens a PR. **OpenCode Console** is a model gateway and billing service (workspaces, members, credits, budgets, providers, policies), connected with `/connect`; it runs no agents ([Console: workspaces](https://opencode.ai/docs/console/workspaces)).
- **Remote, self-hosted:** run `opencode serve --hostname 0.0.0.0 --port 4096` on any host and connect with `opencode --server <url>`, or the web UI after `opencode pair`. `opencode pair --remote` exposes the local server to the internet through an OpenTunnel address, end-to-end encrypted and password-protected ([Web](https://opencode.ai/docs/cli/web)). This is the same agent on a machine you run, not a hosted service.
- **GitHub agent: v1 only, and gone in v2.** v1's `opencode github install` sets up a workflow that runs OpenCode on `/oc` or `/opencode` in issue and **PR review comments**, in your GitHub Actions runner; it works "in a new branch and submits a PR" ([v1 GitHub](https://opencode.ai/v1/docs/github)). v2.2.0 (2026-10-27): "The OpenCode GitHub Action is no longer published. Remove it from your workflows" ([v2.2.0 notes](https://github.com/anomalyco/opencode/releases/tag/v2.2.0)). The v2 CLI has no `github`, `pr` or `share` command (src: `packages/cli/src/commands/commands.ts`). The docs' replacement for CI is a plain `opencode run --standalone` step ([CLI commands: CI](https://opencode.ai/docs/cli/commands#ci)).
- **Session sharing:** v1 has `opencode run --share` (1.17.4 `--help`). The v2 docs and CLI have no sharing: **UNCONFIRMED** whether it exists elsewhere in v2.
- **Cost:** OpenCode is free and open source; you pay your model provider, or OpenCode Console / Go ($10 a month) ([Intro](https://opencode.ai/docs/)). No plan gates any feature in this study.

## 4. Headless CLI (`opencode run`) as an Executor

From [CLI commands: run](https://opencode.ai/docs/cli/commands#run), [CLI intro](https://opencode.ai/docs/cli), and src `packages/cli/src/commands/commands.ts`, `packages/cli/src/run/run.ts`, `packages/cli/src/run/noninteractive.ts`.

- **One shared server.** "By default, OpenCode discovers or starts one shared background server for your user account. Every local OpenCode client connects to that server, which owns sessions, configuration, integrations, permissions, and tool execution." `--standalone` uses a private one ([CLI intro](https://opencode.ai/docs/cli#background-service)). A one-off `run` uses the background service when it is already up, and does not start one (src: `packages/cli/src/commands/handlers/run.ts`).
- **Start:** `opencode run --worktree <name> --model <provider/model#variant> [--agent <id>] --format json --title <t> "<brief>"`. `--format json` emits newline-delimited JSON events, each with `type`, `timestamp` and `sessionID` (src: `noninteractive.ts`, `emit`). `--archived` keeps the session out of lists and the inbox.
- **Resume / message:** `opencode run --session <id> "<text>"` ("Session ID to continue, or to create if it does not exist"). The CLI submits the prompt with `delivery: "steer"` (src: `noninteractive.ts`), the same delivery the TUI's Enter uses while a session works ("Enter steers the active session", [TUI](https://opencode.ai/docs/cli/tui)). So on the shared server a message **can** reach a run that is still working; **UNCONFIRMED** in practice, since a second `run` process on a busy session was not tried.
- **When it exits:** after the session goes idle **and** every subagent, shell or other job its prompt started has ended (src: `noninteractive.ts`, `background()`). The exit code comes from the first idle marker after the prompt.
- **Permissions:** a `run` cannot ask, so any `ask` is rejected with feedback telling the agent to continue without it; `--auto` approves every request that is not explicitly denied (`--yolo` and `--dangerously-skip-permissions` are hidden aliases). Configured `deny` rules always hold (src: `noninteractive.ts`; [Permissions: Approvals](https://opencode.ai/docs/permissions#approvals)). Under the **default** policy nothing asks except `.env` reads, so commit, push and the out-of-worktree report write need no flag; a repository whose config asks for `shell` or `external_directory` needs `--auto`, which is the human's choice in the Dispatch Plan.
- **Rules:** project instructions (`AGENTS.md` and others) are loaded as in the TUI ([Instructions](https://opencode.ai/docs/instructions)).
- **Other drivers:** `opencode api session.create` / `session.prompt` from a shell; `@opencode/client` over HTTP, with `client.event.subscribe()` for a live event stream and `experimental.session.wait({ sessionID })` to block until idle (src: `noninteractive.ts`); `@opencode/sdk` embeds the server in-process ([JavaScript client](https://opencode.ai/docs/build/client), [SDK](https://opencode.ai/docs/build/sdk)). Event subscriptions are live only, with no replay.
- **The human can open it.** Because the shared server owns the session, the human can open a `run` session in the TUI with `opencode --session <id>`, or in the desktop or web app, and read or type into it. v2.3.0 added "Session IDs found in messages can now be opened directly" in the TUI. That a TUI attached to a session that a `run` process is still driving works cleanly is **UNCONFIRMED**.
- **v1 (`opencode` 1.17.4 `run --help`):** `--session`, `--continue`, `--fork`, `--model`, `--agent`, `--format default|json`, `--command` (run a slash command, message as its arguments), `--dir`, `--attach <url>`, `--share`, `--dangerously-skip-permissions`. No worktree flag: a v1 Executor's worktree must be made with `git worktree add` and the run started with `--dir`.

**Verdict for Q4:** yes. `opencode run` is a tier 2 Executor at the least, with a built-in worktree, a per-run model, a session id to resume, and JSON events. On v2 with the shared server it reaches further (see the Tier verdict).

## 5. Skills and slash commands

From [Skills](https://opencode.ai/docs/skills) and [Commands](https://opencode.ai/docs/commands).

- **Directories:** global `~/.config/opencode/skills`, global compatibility `~/.claude/skills` and `~/.agents/skills`; project `.opencode/skills`, project compatibility `.claude/skills` and `.agents/skills` (each searched from the current directory up to the project root), plus `skills` entries in config (paths or HTTP catalogs). A connected Console workspace can share skills. So this repository's `.claude/skills/orchestrate` and the user's `~/.claude/skills/*` load. The ID is the directory name, not the frontmatter `name`.
- **Precedence (later wins):** 1. built-in; 2. `.claude/skills`, global first, then from the farthest ancestor toward the current directory; 3. `.agents/skills`, in the same order; 4. `~/.config/opencode/skills`; 5. project `.opencode/skills`; 6. explicit `skills` config. So a project `.claude/skills/orchestrate` beats `~/.claude/skills/orchestrate`, and any `.agents/skills` or `~/.config/opencode/skills` copy beats both.
- **`disable-model-invocation: true`** has the same effect as `metadata.opencode/autoinvoke: false`: it **only hides** the skill from the model's list. "The skill remains registered and can still be loaded explicitly by ID." The `skill` tool takes "The ID of an available skill or a skill explicitly referenced by the user" and enforces nothing beyond the `skill` permission (src: `packages/core/src/tool/plugin/skill.ts`). **v1 ignores the field:** "OpenCode 1 does not use metadata to control slash commands or automatic skill selection" ([v1 Skills](https://opencode.ai/v1/docs/skills)), so on v1 a model may load `qa-plan` on its own.
- **How a user invokes one:** "mention it in your prompt as `@skill-id`". The prompt schema carries `skills: [{ id }]` as a structured attachment beside `text` (src: `packages/schema/src/prompt-input.ts`), which the server resolves before admission. Skills are **not** slash commands in v2: commands are a separate registry (`.opencode/commands/*.md`, `~/.config/opencode/commands/`, or `commands` in config).
- **From a message or headless prompt:** three routes, none tried.
  - `opencode run --session <id> "Load the qa-plan skill and run it for issue 12"`: the text names the skill in a user prompt, which the tool's rule treats as "explicitly referenced by the user". Likely to work; **UNCONFIRMED**.
  - `opencode api session.prompt` with `skills: [{ "id": "qa-plan" }]`: the same structured attachment the TUI makes from `@qa-plan`, so the nearest thing to the user's own invocation. **UNCONFIRMED** that the CLI's `api` command passes it through.
  - `opencode run "@qa-plan 12"`: the CLI sends plain text and parses no `@` mentions (src: `packages/cli/src/run/run.ts`), so this is the first route, not an attachment.
  - The v2 `run` has no `--command` flag; a custom command can be run through the API (`session.command`, [Server plugins: Sessions](https://opencode.ai/docs/build/plugins/server#sessions)).
- **Built-in skills:** `opencode` and `report` ship in the source (src: `packages/core/src/plugin/skill/`); neither bears on orchestration.

## 6. Events the parent can wait on

- **Subagent idle:** a `<subagent>` message to the parent each time a child goes idle, and after each later round. The tool tells the parent "DO NOT sleep, poll, proactively check on its progress". This is a real push `await` (v2.3.0).
- **Background shell:** a `shell` call with `background: true` "return[s] immediately and notify the session when they finish" ([Tools: Shell](https://opencode.ai/docs/tools#shell)). A Chief of Staff running in OpenCode can start each `opencode run` Executor this way and be woken when it exits, and can do the same for `gh pr checks <n> --watch`, which exits when a pull request's checks finish. That last one is a `gh` feature, not OpenCode's.
- **Server event stream:** `client.event.subscribe()` (or `ctx.event.subscribe()` in a plugin) streams events such as `session.execution.started`, `session.inbox.delivered`, `permission.asked`, `worktree.updated` (src: `noninteractive.ts`; [Server plugins: Events](https://opencode.ai/docs/build/plugins/server#events)). It is live only, with no replay.
- **Plugins (hooks):** a server plugin can subscribe to events and push text into a session with `ctx.session.synthetic({ sessionID, text })` or `ctx.session.prompt`, and wait with `ctx.session.wait` ([Server plugins: Sessions](https://opencode.ai/docs/build/plugins/server#sessions)). A plugin could therefore wake the Chief of Staff when an Executor goes idle, or when a CI or review webhook arrives. That is persistent config the human approves, and none ships. V1 plugins do not run in V2.
- **CI and PR review comments: nothing built in.** No subscription to CI or PR activity exists in v2, and the v1 GitHub agent (which answered `/oc` in review comments) was removed in v2.2.0. v2.3.0 added experimental MCP events behind the `mcp_events` flag; whether a GitHub MCP server could deliver review comments through it is **UNCONFIRMED**. The Chief of Staff watches checks and comments itself with `gh`.

## Recommendation: the four verbs on OpenCode

Four ways to run an Executor on OpenCode (v2.3.0 unless noted):

|                               | (a) `subagent` tool                                                     | (b) `opencode run --worktree` on the shared server                                 | (c) Server API / SDK session                             | (d) v1 GitHub agent                         |
| ----------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| Own branch and working copy   | No: shares the parent's checkout. A self-move is possible, unconfirmed. | Yes: a new worktree, detached at the checkout's HEAD; the brief makes a branch.    | Yes: `worktree.create`, then a session in that location. | Yes: a branch in an Actions runner.         |
| Model per Delegation          | Yes: agent `model`, or the tool's `model` parameter.                    | Yes: `--model provider/model#variant`.                                             | Yes: `session.switchModel`.                              | Yes: the workflow's `model`.                |
| Human can open and talk to it | Can navigate to it; typing into a running child unconfirmed.            | Yes: `opencode --session <id>`, desktop or web; unconfirmed while `run` drives it. | Yes, the same way.                                       | Only through PR comments.                   |
| `message` after it ends       | `subagent` with the `sessionID`.                                        | `opencode run --session <id> "<text>"`.                                            | `session.prompt`.                                        | A new `/oc` comment.                        |
| `message` while it runs       | Yes: "joins its current run".                                           | Yes in source (`delivery: "steer"`); untried.                                      | Yes: `delivery: "steer"` (default).                      | No.                                         |
| `await` without polling       | Yes: a `<subagent>` message on every idle.                              | The process exit; from OpenCode, a background shell notifies on exit.              | `session.wait`, or the event stream.                     | No: watch the PR.                           |
| Reaches the run folder        | Yes: `external_directory` is allowed by default.                        | Yes by default; `--auto` if config asks.                                           | Yes by default.                                          | No: report as a PR comment.                 |
| User-invoked skills           | By naming the skill in the prompt; unconfirmed.                         | By naming it in a `--session` message; unconfirmed.                                | `skills: [{ id }]` attachment; unconfirmed.              | No.                                         |
| Local QA Stack and browser    | Same machine; browser only with the desktop app attached, unconfirmed.  | Same machine; browser unconfirmed (Playwright MCP fallback).                       | Same as (b).                                             | No.                                         |
| PR review comments and CI     | No.                                                                     | No.                                                                                | Only through a plugin you write.                         | Review comments, by `/oc`; removed in v2.2. |
| Needs                         | OpenCode v2.3+ as the Chief of Staff.                                   | OpenCode v2 installed and logged in.                                               | A script or plugin.                                      | v1, a workflow, provider secrets.           |

**Per Delegation:**

- **Building.** (b). `spawn`: from the repository root, a background process (a `shell` call with `background: true` when the Chief of Staff is OpenCode) running `opencode run --worktree <id> --model <model> --format json --title <id> "<brief>"`, with stdout to `delegations/<id>/output.jsonl` and stderr (which carries `worktree <path>`) to `delegations/<id>/run.log` in the run folder. The handle is the `sessionID` in the first JSON line, with the worktree path and process id. The brief opens with `git switch -c <branch> <base>`, because the worktree starts detached at the Chief of Staff's HEAD, which may not be the Delegation's base. Then check that `git -C <worktree> branch --show-current` is the branch. `message`: `opencode run --session <id> --format json "<text>"`, in the background again. `await`: end the turn; the background shell's end wakes the Chief of Staff. Off OpenCode, wait on the process. `report`: the absolute path; it needs no approval under the default policy. Push and PR: the Executor's. Review comments and CI after the PR: the Chief of Staff, with `gh`; `gh pr checks <n> --watch` in a background shell gives a push for checks, while comments still need a read at an interval. Clean up with `worktree_remove` only on the human's yes.
- **Analysis.** (a). `spawn`: the `subagent` tool with `explore` (read-only) or a custom `.opencode/agents/` subagent, with the plan's model (the brief notes the human asked for it). The handle is the `sessionID`. `message`: `subagent` with that `sessionID`, running or ended. `await`: end the turn; the `<subagent>` message arrives. `report`: the absolute path, or the final message. It shares the Chief of Staff's checkout, so this is right only for a Delegation that writes nothing but its report. One that runs code or edits goes to (b).
- **QA.** (b), never (a): a subagent shares the checkout, and QA needs its own working copy, the QA Stack and a browser. `spawn` on the brief, as for building. Once its first phase has stopped, `message` it with text that names the skill ("Load the `qa-plan` skill and run it for #<n>"), or send a `session.prompt` with `skills: [{ "id": "qa-plan" }]` through `opencode api`. Later, the same for `manual-qa <plan file>`. If the skill does not load, or no browser tool is present, fall back to a session the human opens (`opencode --session <id>`, or the desktop app, which has the browser) and types `@qa-plan <n>`; that is the fallback HARNESSES.md already names.

**Tier.** **Tier 1 on OpenCode v2.3+, pending three checks; tier 2 on v1.**

- Executor (b) is a separate session in its own worktree, on the server the human's TUI, desktop and web clients already use, so the human can open it, read it and type into it while it works. The Chief of Staff, if it runs in OpenCode, is told when it ends, through the background shell's notice. That is HARNESSES.md's tier 1 definition.
- The checks: (1) a human can attach to a session that a `run` process is driving; (2) a `--session` message to a busy session steers it rather than failing; (3) the background-shell notice wakes an idle Chief of Staff, as the `<subagent>` message does.
- If (1) fails, (b) is tier 2, as `claude -p` is.
- Subagents (a) beat Cursor's on `message` (mid-run follow-ups are documented) and match its `await`, but they have no isolation, so they serve analysis only.
- On v1 (the local 1.17.4), `opencode run --dir <worktree> --session` is plain tier 2, with no worktree flag, and with `disable-model-invocation` ignored.

## Verdict: cloud agents, or local?

**Local is the only choice, and it is enough.** OpenCode has no cloud agent, and the one GitHub-hosted runner it had (the v1 GitHub agent) is gone from v2.

**For local:**

- Isolated sessions in worktrees (`run --worktree`), a model per run, a session id to resume or steer, and push events (subagent idle, background shell end).
- The shared server lets the human watch and steer each Executor from the TUI, the desktop app, the web UI, or a phone through `opencode pair --remote`.
- The default permissions let an Executor commit, push and write its report into the run folder without prompts.
- The QA Stack and the skills in `~/.claude/skills` and `.claude/skills` are on the same machine.

**Against local:**

- **Worktrees are detached**, start at the Chief of Staff's HEAD, and have no documented setup file, so the brief must make the branch and any setup itself.
- **No cleanup and no cap**: worktrees accumulate under the data directory until removed.
- **No CI or PR-comment delivery** of any kind. The Chief of Staff watches `gh` itself.
- **Several key behaviours are source only** (`--worktree`, detached HEAD, steering delivery, the startup script), so they may change without a docs entry. v2 is two months old and releases often.
- **The laptop must stay awake**, since the shared server runs there. `opencode serve` on an always-on host is the self-hosted way around it, but it then cannot reach the local QA Stack.

**Against "cloud" (the v1 GitHub agent, or a remote `opencode serve`):**

- The GitHub agent is v1-only, is removed in v2.2.0, runs only in Actions, cannot reach the run folder or QA Stack, and reports only as PR comments.
- A remote server needs its own clone, credentials and exposure (`pair --remote` or SSH).

**So:** on v2, use (b) for building and QA and (a) for read-only analysis. Do not offer a cloud Executor for OpenCode in the Dispatch Plan.

## UNCONFIRMED

1. How a human starts a worktree session from the TUI or desktop app (a TUI worktree dialog exists in source).
2. Where a user sets the project's worktree startup script (`commands.start`), and whether it is meant as a public feature.
3. Port and env isolation between worktrees' dev servers, beyond `OPENCODE_WORKTREE_BASE` and `OPENCODE_WORKTREE_PATH`.
4. Whether a child (subagent) session can `worktree_create` and `session_move` itself into the new worktree, and whether its tools then run there.
5. Whether a human can type into a running v2 child session from the TUI or desktop app.
6. Whether a v1 `task` subagent runs in the background.
7. Whether the `browser` Code Mode namespace exists with no desktop app attached, in a TUI or `opencode run` session.
8. Whether a Playwright MCP server works as the browser in an `opencode run` session.
9. Whether a human can attach (`opencode --session <id>`, desktop, web) to a session that an `opencode run` process is still driving, and type into it.
10. Whether `opencode run --session <id>` sent to a busy session steers it, as the source's `delivery: "steer"` implies.
11. Whether a background `shell` call's completion notice wakes an idle Chief of Staff session the way a `<subagent>` message does.
12. Whether naming a `disable-model-invocation` skill in a headless or follow-up prompt makes the model load it, and whether `opencode api session.prompt` passes a `skills: [{ id }]` attachment through.
13. Whether v2 has any session sharing (v1 has `--share`).
14. Whether the experimental `mcp_events` flag could deliver PR review comments from a GitHub MCP server.
15. The `--worktree` flag, the detached-HEAD start and the startup script are **source only** (not in the docs) and may change without notice.
