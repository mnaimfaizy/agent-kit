# OpenAI Codex: worktrees, parallel agents, and the `orchestrate` verbs

Research for the `orchestrate` skill ([HARNESSES.md](../../.claude/skills/orchestrate/HARNESSES.md)): how OpenAI Codex (the Codex CLI, the IDE extension, and Codex Cloud) runs agents in parallel and in isolated checkouts, and how the four verbs (`spawn`, `message`, `await`, `report`) map onto it.

- **Read on:** 2026-11-14. The docs pages carry no publish date, so a fact from a docs page is dated by the read. The newest stable CLI release on that day was **`rust-v0.169.0`, published 2026-11-13** ([releases](https://github.com/openai/codex/releases)); a fact from release notes is dated by its release.
- **Where the docs live now:** every `developers.openai.com/codex/<page>` URL answers `308` to `learn.chatgpt.com/docs/<page>` (checked with `curl -I` on 2026-11-14, e.g. `/codex/subagents` → `/docs/agent-configuration/subagents`). The docs now cover "ChatGPT Work and Codex" together, and the former "Codex app" is now **Codex in the ChatGPT desktop app**. Citations below use the `learn.chatgpt.com` form; each page also has a Markdown form (append `.md`), and the whole set is in one export, [`llms-full.txt`](https://developers.openai.com/codex/llms-full.txt), which is what was read.
- **Sources:** primary only. The docs pages above, the CLI reference, the [openai/codex](https://github.com/openai/codex) repository (release notes, merged PR descriptions, and, where the docs are silent, source at the `rust-v0.169.0` tag, marked **from source**). No forum or staff post was needed.
- **Local install:** none. `which codex` finds nothing and `~/.codex` does not exist on this machine, so no `--help` output was read; CLI facts come from the CLI reference and the source.
- **UNCONFIRMED** marks anything no primary source states. Every one is listed again at the end.

## 1. Worktrees

**Three ways to start one:**

- **ChatGPT desktop app (Codex):** pick **Worktree** under the composer, choose the base branch, submit; or move a running chat with **Hand off** between Local and Worktree ([Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)).
- **CLI, interactive:** `codex --worktree` starts a new session in "a new managed Git worktree"; `/worktree` moves the chat into one, and is "unavailable while a task is running"; `codex fork <SESSION_ID> --worktree` forks into one (explicit id only, no `--last`) ([CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).
- **CLI, headless:** `codex exec --worktree "<prompt>"` and `codex exec fork <SESSION_ID> --worktree "<prompt>"`. `--worktree` "requires local execution" and "can't be combined with `resume`, `review`, `--ephemeral`, or `--ignore-user-config`" ([CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), `codex exec`). The worktree feature flag was retired in 0.164.0 (2026-10-23, #54175), so it is on without configuration. **From source** (`codex-rs/exec/tests/suite/worktree.rs`): a project marked untrusted refuses `--worktree`.

**Where they live.** The desktop app creates them in `$CODEX_HOME/worktrees` by default, changeable in **Settings > Worktrees > Worktree root** ([Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)). The docs do not say where a CLI `--worktree` checkout goes, or whether it shares the desktop app's root: **UNCONFIRMED**. (The source's test sets the root through a `desktop.git-worktree-root` setting, which suggests a shared root, but no doc says so.) `codex exec --json` reports the thread id in `thread.started`; no doc says it reports the worktree's path: **UNCONFIRMED**.

**Branch naming.** None. A managed worktree "isn't checked out as a branch. It's in a detached HEAD state", started from the `HEAD` of the branch chosen, with that branch's uncommitted changes applied ([Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)). In the desktop app, **Create branch here** turns it into a branch. Whether a CLI worktree also starts detached is not stated: **UNCONFIRMED** (likely, as the same "managed Git worktree").

**Setup.**

- **Setup scripts** run when Codex creates a worktree at the start of a new chat, configured as a **local environment** stored in the project's `.codex` folder; "Local environments are available only in Codex in the ChatGPT desktop app" ([Local environments](https://learn.chatgpt.com/docs/environments/local-environment)). Whether `codex exec --worktree` runs them: **UNCONFIRMED**.
- **`.worktreeinclude`** at the repo root lists gitignored files (`.env` and the like) to copy into a new managed worktree. That "applies to local ChatGPT desktop app managed worktrees, not remote worktrees or Git worktrees you create yourself" ([Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)). An ignored `AGENTS.override.md` is copied automatically.

**Cleanup and limits** (desktop app, [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)): Codex keeps the **15 most recent Codex-managed worktrees** by default (changeable, or switch auto-deletion off). It saves a snapshot before deleting one and offers to restore it when the chat is reopened. Permanent worktrees from earlier versions are protected but can no longer be created. Whether the cap and cleanup apply to CLI-made worktrees: **UNCONFIRMED**.

**Applying changes back.** Desktop app: keep working on the worktree (and **Create branch here**), or **Hand off** to Local, which "moves your chat _and_ code"; Git's one-branch-per-worktree rule applies ([Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)). The app also stages, commits, pushes and opens PRs from its Git pane ([Local environments](https://learn.chatgpt.com/docs/environments/local-environment)). The CLI documents no apply-back step for a local worktree; the agent commits there like in any checkout. (`codex apply` is for **cloud** diffs, see section 3.)

**A worktree made by hand works too.** `codex exec -C <path>` ("Set the workspace root before executing the task") starts in any directory, so the Chief of Staff can run `git worktree add -b <branch> <path> <head>` itself and avoid the detached HEAD and the unknown path ([CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).

**Ports, env, shared services.** No primary source covers port collisions between worktrees' dev servers: **UNCONFIRMED**.

## 2. Subagents (the multi-agent tools)

From [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) unless noted.

- **On by default** in the desktop app, CLI and IDE extension (`agents.enabled = true`; feature `multi_agent` "Stable"). The model gets the tools `spawn_agent`, `send_input`, `resume_agent`, `wait_agent` and `close_agent` ([Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference), `features.multi_agent`). Codex spawns only "after a direct request or applicable project or skill instruction": a skill such as `orchestrate` asking for delegation counts.
- **Built-in agents:** `default`, `worker` (implementation and fixes), `explorer` (read-heavy).
- **Custom agents:** one TOML file each in `~/.codex/agents/` (personal) or `.codex/agents/` (project). Required: `name`, `description`, `developer_instructions`. Optional: `model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `features.*` switches (shell tool, apps, plugins, memories, request-permissions tool) and `skills.config`. A custom agent named like a built-in wins. A custom agent **cannot** set `sandbox_mode`, `approval_policy`, `model_provider` or `mcp_servers`; it inherits the parent's. Not Markdown, and Codex does not read `.claude/agents/` (only the paths above are documented).
- **Model per agent:** yes. Resolution: explicit spawn value, then `[agents]` defaults (`default_subagent_model`, `default_subagent_reasoning_effort`), then the parent; a value in the agent file wins over all of them. `spawn_agent` takes `model` and `reasoning_effort` **(from source**, `multi_agents_spec.rs`), though its own description tells the model not to set `model` "unless the user explicitly asks".
- **Parallel and background:** several at once; the cap is `agents.max_concurrent_threads_per_session` (legacy `agents.max_threads`), default **6** **(from source**, `DEFAULT_AGENT_MAX_THREADS` at `rust-v0.169.0`). "Completed agents remain open and count toward the concurrency limit until closed" (`close_agent` description, from source).
- **Own worktree: no.** Nothing in the docs gives a subagent its own checkout, and the source copies the parent turn's working directory onto the child: `config.cwd = turn_cwd` in `codex-rs/core/src/agent/child_config.rs` (from source, `rust-v0.169.0`). The docs warn that "agents editing code at once can create conflicts". So parallel subagents **share the parent's checkout**.
- **Sandbox:** "Subagents inherit the parent turn's current sandbox and approval settings, including changes made with `/permissions` or `--yolo`. A custom agent file can't replace those settings." Instructions can ask an agent not to edit, but "don't create a separate read-only sandbox".
- **Message after it finishes:** yes. `send_input` reaches an existing agent; `resume_agent` reopens "a previously closed agent by id so it can receive send_input and wait_agent calls" (tool descriptions, from source). The handle is the `agent_id` (thread id) that `spawn_agent` returns.
- **Message while it runs:** yes. `send_input` takes `interrupt: true` "to redirect work immediately" (from source); the docs say "Ask Codex directly to steer a running subagent, stop it, or close completed agent threads".
- **The human can open one:** in the CLI, `/subagents` switches the active thread "so you can inspect or continue that agent's work" ([CLI slash commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)); approvals from inactive threads show their source and `o` opens it. The IDE shows active subagents above the composer, with stop and open. Since 0.164.0 (2026-10-23, #53895) selecting an unloaded subagent thread resumes it.
- **Nesting:** default depth **1**, so a subagent cannot spawn its own **(from source**, `DEFAULT_AGENT_MAX_DEPTH = 1`, config `agents.max_depth`; not in the docs).
- **Tools:** the parent's tools, MCP servers and skills ("Skills inherit from the parent"), unless the agent file switches some off. Shell is on unless `features.shell_tool = false`. `git commit` and `git push` follow the inherited sandbox (see section 4): under `workspace-write` the `.git` directory is read-only and the network is off.
- **Browser:** "Browser isn't available in Codex CLI or the Codex IDE extension" ([Browser](https://learn.chatgpt.com/docs/browser)); the built-in browser is in the desktop app only. A browser MCP server configured on the parent reaches its subagents (the docs' `browser_debugger` example uses a `chrome_devtools` MCP server).
- **Writing outside the working copy:** governed by the sandbox. `workspace-write` writes the workspace and `/tmp`; `--add-dir <path>` or `sandbox_workspace_write.writable_roots` add more ([Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security), [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).
- **Hooks around subagents:** `SubagentStart`, and `SubagentStop` (gets `agent_id`, `agent_transcript_path`, `last_assistant_message`; returning `decision: "block"` with a `reason` continues the subagent) ([Hooks](https://learn.chatgpt.com/docs/hooks)).

## 3. Codex Cloud

From [Codex Cloud](https://learn.chatgpt.com/docs/cloud) and [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments) unless noted.

- **Starting one:** web or desktop app (**Work in > Cloud**), the mobile app, `@ChatGPT` in Slack or Microsoft Teams (Enterprise with Cloud delegation enabled), and the CLI. Each task "runs in its own workspace" (a VM) and "can keep working while your computer is asleep".
- **From the CLI, programmatically:** `codex cloud exec --env <ENV_ID> [--attempts <N>] "<prompt>"` submits a task (`--attempts` is best-of-N); `codex cloud list --json` returns `tasks[]` with `id`, `url`, `status`, `summary`, `attempt_total`; `codex apply <TASK_ID>` applies the task's latest diff to the local tree and exits non-zero if `git apply` fails ([CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)). So a local agent can start one with its shell, signed in with ChatGPT ("Codex cloud requires signing in with ChatGPT", [Authentication](https://learn.chatgpt.com/docs/auth)). A follow-up to an existing cloud task from the CLI is not documented: **UNCONFIRMED**. No public REST API for cloud tasks is documented: **UNCONFIRMED** that one exists.
- **Branches and PRs:** "Review changes and test results before committing or opening a pull request"; the legacy guide says that when the agent finishes "You can open a PR or ask follow-up questions" ([Codex Cloud (Legacy)](https://learn.chatgpt.com/docs/environments/cloud-environment)). How a cloud branch is named, and whether a cloud task can push or open the PR without a human: **UNCONFIRMED**.
- **Follow-ups:** reopen the task on web or mobile; "Each new task starts in its own workspace." Saved VM state is recoverable for up to seven days.
- **Completion:** poll `codex cloud list --json`. No webhook, stream or push to a local session is documented for cloud tasks: **UNCONFIRMED** that any exists. Web notifications (push, email, SMS) reach the human ([Notifications](https://learn.chatgpt.com/docs/notifications)).
- **What they cannot reach:** the local machine, so not the run folder or the local QA Stack. "Personal skills from your local computer aren't synced"; repository skills are available. Computer use is not supported in cloud environments; a cloud task with browser access can open a web app it starts itself ([Browser](https://learn.chatgpt.com/docs/browser)).
- **Plan:** VM sizes are listed for Plus, Edu Plus, Pro, Business, Enterprise, Edu and Edu Pro. Whether Free or Go plans get Codex Cloud: **UNCONFIRMED**.
- **OpenAI's own orchestrator:** **dots**, an always-on agent that "can divide work among background agents", "start new cloud threads, and create Work or Codex tasks on a connected computer", and "send follow-up instructions to tasks it created" ([Meet dots](https://learn.chatgpt.com/docs/dots)). It is a ChatGPT product, not something a local Chief of Staff drives.

## 4. CLI headless mode as a tier 2 Executor

From [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and the [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

- **Start:** `codex exec "<brief>" -m <model> --json -o <file> [--worktree | -C <path>] [--add-dir <path>] [-s <sandbox>]`. Progress goes to stderr and only the final message to stdout. `--json` makes stdout a JSONL stream (`thread.started` with `thread_id`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`). `-o/--output-last-message <path>` writes the final message to a file. `--output-schema` forces a JSON shape. A Git repository is required unless `--skip-git-repo-check`.
- **Resume:** `codex exec resume <SESSION_ID> "<text>"` (or `--last`, scoped to the current directory unless `--all`). Not with `--worktree`; run it from inside the worktree, as the source's test does (`worktree.rs`, from source). A message cannot reach an `exec` run while it is still working: **UNCONFIRMED** whether `codex queue` reaches one (see below).
- **Permissions to commit and push.** `codex exec` "runs in a read-only sandbox" by default. `--sandbox workspace-write` allows edits, but in it **`.git` is read-only, including the Git directory a worktree's `.git` pointer file resolves to**, and the network is off ([Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security), "Protected paths in writable roots"). A headless run cannot ask for approval: "an action that needs new approval fails" ([Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)). So committing and pushing needs one of:
  - `--sandbox danger-full-access` or `--yolo` (no sandbox; "only use inside an isolated runner");
  - `prefix_rule` entries with `decision = "allow"` for `git commit`, `git push`, `gh pr create` in `~/.codex/rules/*.rules` or a trusted `<repo>/.codex/rules/`, which run those commands "outside the sandbox without prompting" ([Rules](https://learn.chatgpt.com/docs/agent-configuration/rules)). That is a persistent config change the human approves;
  - `--approve-for-me`, which routes approval requests to automatic review with `workspace-write`. Whether that review approves a `git push`: **UNCONFIRMED**.
- **Writing the report:** `--add-dir <run folder>` grants write access to the Chief of Staff's run folder alongside the workspace, so `delegations/<id>/report.md` can be written by its absolute path. The run folder sits inside the Chief of Staff's checkout but outside its `.git`, so the `.git` protection does not touch it.
- **Messaging a session by id:** `codex queue --thread <SESSION_ID> --message "<text>" [--resume]` queues text for an existing session; `--resume` loads it if not loaded, which "requires a running local daemon or a server selected with `--remote`" (added 0.166.0, 2026-10-29, #57232). The interactive CLI runs on a shared background server by default (`--no-daemon` opts out). Whether an `exec` run is on that server: **UNCONFIRMED**, so `codex queue` is not assumed to reach an `exec` Executor.
- **Programmatic alternatives:** the TypeScript SDK (`@openai/codex-sdk`: `startThread`, `run`, `resumeThread(id)`) and the Python SDK (`openai-codex`, over app-server JSON-RPC) ([Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)); the app server's `thread/start` takes `cwd`, `model`, `sandbox`, `approvalPolicy` and streams `turn/completed`, and `turn/steer` appends input to a running turn ([App Server](https://learn.chatgpt.com/docs/app-server), marked "primarily for development and debugging and may change without notice" for `codex app-server`).

**Verdict for Q4:** yes. `codex exec` fits tier 2 as `claude -p` does: start in the background, handle = `thread_id`, `message` = `exec resume`, `report` by `--add-dir`. The Codex-specific check is the `.git` protection: the human chooses, in the Dispatch Plan, between full access and allow rules for the git and `gh` commands.

## 5. Skills and slash commands

From [Build skills](https://learn.chatgpt.com/docs/build-skills) unless noted.

- **Directories:** `.agents/skills` in every directory from the current one up to the repo root, `~/.agents/skills` (user), `/etc/codex/skills` (admin), and bundled system skills. Symlinked skill folders are followed. **Codex does not read `.claude/skills/` or `~/.claude/skills/`**: they are in no list. It offers to **copy** them instead: the app server's `externalAgentConfig/detect` reports "Copy skill folders from /Users/me/.claude/skills to /Users/me/.agents/skills" ([App Server](https://learn.chatgpt.com/docs/app-server)), and 0.169.0 (2026-11-13, #60492) added a "local-only Claude Code skill migration". So this repo's `.claude/skills/orchestrate`, `qa-plan` and `manual-qa` are invisible to Codex until copied or symlinked into `.agents/skills/`.
- **Precedence:** none. "If two skills share the same `name`, Codex doesn't merge them; both can appear in skill selectors."
- **Invocation:** explicit (type `$` to mention a skill, or `/skills` to pick one) or implicit (matched on `description`). Skills are not slash commands; the old custom prompts (`/prompts:<name>` from `~/.codex/prompts/`) are deprecated ([Custom Prompts](https://learn.chatgpt.com/docs/custom-prompts)).
- **User-invoked only:** Codex does not read Claude Code's `disable-model-invocation: true`. Its equivalent is `agents/openai.yaml` in the skill folder with `policy.allow_implicit_invocation: false`, after which "explicit `$skill` invocation still works". So on Codex, `qa-plan` and `manual-qa` as they stand could be picked up implicitly.
- **From a message or a headless prompt:** explicit invocation is "Include the skill directly in your prompt", and the desktop app documents `$skill-name` in a scheduled-task prompt as an explicit trigger ([Scheduled tasks](https://learn.chatgpt.com/docs/automations)). `spawn_agent` and `send_input` accept structured input items of type `skill` with a `path` (from source, `multi_agents_spec.rs`). That `codex exec '$qa-plan 12'`, a `send_input` skill item, or `codex queue` text counts as the user's own explicit invocation of an `allow_implicit_invocation: false` skill is not stated: **UNCONFIRMED** (the docs define no other kind).
- **Rules files:** Codex reads `AGENTS.override.md`, then `AGENTS.md`, then any names listed in `project_doc_fallback_filenames`, in each directory from the project root down ([AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)). `CLAUDE.md` is read only if added to that list; the app server's import can copy `CLAUDE.md` to `AGENTS.md`. This repo has an `AGENTS.md`.

## 6. Events the parent can wait on

- **Subagent completion:** `wait_agent` waits "for agents to reach a final status", and "Once the agent reaches a final status, a notification message will be received containing the same completed status" (from source). The docs: "the main thread collects the subagent results". So a Chief of Staff on Codex need not poll its subagents.
- **Headless runs:** wait on the `codex exec` process, or read its JSONL for `turn.completed` / `turn.failed`.
- **Hooks** ([Hooks](https://learn.chatgpt.com/docs/hooks)): `Stop` with `decision: "block"` "creates a new continuation prompt that acts as a new user prompt", and `SubagentStop` can continue a subagent. Hooks live in `~/.codex/hooks.json`, `~/.codex/config.toml` or a trusted `<repo>/.codex/`, so adding one is a persistent-config change the human approves. A `Stop` hook could feed CI results back in as a prompt; that use is not documented.
- **`notify`:** an external program run on `agent-turn-complete` (the only supported event) ([Advanced Configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)). It signals out, not in.
- **CI and PR review comments:** no subscription exists for a local session or a subagent. Event-triggered scheduled tasks can run on GitHub "pull request activity" (reviews, comments, commit updates, merges), but they are "available in ChatGPT on the web and mobile. They aren't available in the ChatGPT desktop app, Codex CLI, or the IDE extension", and they start their own run rather than waking a local session ([Scheduled tasks](https://learn.chatgpt.com/docs/automations)). `@codex review` and automatic reviews post a GitHub review on the PR ([GitHub](https://learn.chatgpt.com/docs/third-party/github)); they deliver nothing to the Chief of Staff. The [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action) runs Codex in CI on workflow events. So the Chief of Staff watches each PR's checks and comments itself (`gh pr checks`, `gh api`), as it does on Cursor.

## Recommendation: the four verbs on Codex

Three ways to run an Executor with a Chief of Staff in the Codex CLI:

|                               | (a) In-session subagent (`spawn_agent`)                                       | (b) Headless run (`codex exec`)                                        | (c) Codex Cloud task (`codex cloud exec`)            |
| ----------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| Own branch and working copy   | **No**: shares the parent's checkout (from source).                           | Yes: `--worktree` (detached HEAD), or `-C` on a worktree made by hand. | Yes: its own VM workspace.                           |
| Model per Delegation          | Yes: `model` at spawn, or the agent file.                                     | Yes: `-m`.                                                             | **UNCONFIRMED** (no model flag documented).          |
| Human can open and talk to it | Yes: `/subagents` in the CLI, the panel in the IDE.                           | No.                                                                    | Yes: web, desktop, mobile.                           |
| `message` after it ends       | `send_input`; `resume_agent` once closed.                                     | `codex exec resume <id> "<text>"` in the worktree.                     | **UNCONFIRMED** from the CLI; the human, on the web. |
| `message` while it runs       | `send_input`, with `interrupt: true` to redirect.                             | No (`codex queue` unconfirmed for `exec`).                             | **UNCONFIRMED**                                      |
| `await` without polling       | Yes: completion notification, or `wait_agent`.                                | Wait on the process.                                                   | No: poll `codex cloud list --json`.                  |
| Reaches the run folder        | Yes: same workspace.                                                          | With `--add-dir <run folder>`.                                         | No: report as final message.                         |
| Commit and push               | Only under the parent's full access or allow rules.                           | Only with `danger-full-access`/`--yolo` or allow rules.                | **UNCONFIRMED** without a human.                     |
| User-invoked skills           | Skill input item; as the user's own, **UNCONFIRMED**. Needs `.agents/skills`. | `$skill` in the prompt; as the user's own, **UNCONFIRMED**.            | Repository skills only; personal skills not synced.  |
| Local QA Stack and browser    | Same machine; browser only through an MCP server.                             | Same machine; browser only through an MCP server.                      | No local stack; a browser for apps it starts.        |
| PR review comments and CI     | Parent only, by `gh`.                                                         | No.                                                                    | No subscription documented.                          |
| Needs                         | Nothing extra.                                                                | Nothing extra; a sandbox choice for git.                               | ChatGPT sign-in, a cloud environment, a paid plan.   |

**Per Delegation:**

- **Building.** `spawn`: the Chief of Staff makes the worktree itself (`git worktree add -b <branch> <path> <head>`), then starts `codex exec -C <path> -m <model> --json --add-dir <run folder> [sandbox choice] "<brief>"` in the background, with stdout to `delegations/<id>/output.jsonl` and `-o delegations/<id>/last-message.md`. The handle is the `thread_id` from `thread.started`, with the process id. Making the worktree by hand gives a named branch and a known path, which `--worktree` does not. `message`: `codex exec resume <thread_id> "<text>"` from inside the worktree, once the run has ended. `await`: the process exit. `report`: `delegations/<id>/report.md` by its absolute path; if the write failed, the last message. Push and PR: the run pushes its own branch under the human's sandbox choice. Not a subagent: a subagent shares the Chief of Staff's checkout, which the skill forbids for anything that writes.
- **Analysis.** A subagent (`spawn_agent`, the `explorer` agent or a read-only custom agent) is acceptable when it writes nothing but its report, since it shares the checkout and the sandbox does not make it read-only. `message`: `send_input` (also mid-run); `await`: the completion notification; `report`: the report file. Anything that runs code or changes files is a headless run, as for building.
- **QA.** Never a subagent. A headless run in its own worktree, as for building, with `$qa-plan <n>` and later `$manual-qa <plan file>` sent by `codex exec resume`. This needs, first, the two skills copied or symlinked into `.agents/skills/` with `agents/openai.yaml` setting `allow_implicit_invocation: false`, and a browser MCP server, since the CLI has no browser: persistent changes the human approves in the Dispatch Plan. Whether `$qa-plan` in a resumed prompt counts as the user's own invocation is **UNCONFIRMED**. Fallback, the one HARNESSES.md already names: a session the human starts, here a desktop-app chat in a **Worktree**, which has the built-in browser, where the human types `$qa-plan <n>` and later `$manual-qa <plan file>`.
- **CI and review after the PR:** the Chief of Staff watches checks and comments itself on every Delegation.

**Tier.** Codex is **tier 2** for the work that matters here. A headless run is the only Executor with its own branch and working copy, and it is start-and-poll: the human cannot open it while it works. The in-session subagent has tier 1's verbs (a completion event, messages while running, a thread the human can open and steer) but no working copy of its own, so it serves analysis only. One route might reach tier 1 but is unconfirmed: a thread started on the shared background server (app server `thread/start` with `cwd` on a worktree), opened by the human in `codex agents` and messaged with `codex queue`. Whether such a thread shows in the command center, and whether queued text reaches a running turn, are **UNCONFIRMED**, and the app server "may change without notice". Replace the "Codex CLI: check before use" line in HARNESSES.md with a tier 2 block: `codex exec` for building and QA, subagents for analysis.

## Verdict: Codex Cloud, or local?

**Local, with headless runs in worktrees, should be the default. Codex Cloud is not worth offering** for this skill as of 2026-11-14.

**For local:**

- No extra plan or connection beyond the CLI sign-in.
- Headless runs reach the run folder (`--add-dir`) and the local QA Stack.
- `spawn`, `message` (`exec resume`) and `await` (process exit) are documented; subagents add a true completion event and mid-run messages for analysis.
- Worktrees are built in (`--worktree`), or made by hand and passed with `-C`.

**Against local:**

- **Subagents are not isolated.** They share the parent's checkout and sandbox, so they cannot do building or QA.
- **Committing needs a sandbox decision.** `workspace-write` makes `.git` read-only and turns the network off; full access or allow rules are the human's call.
- **No browser in the CLI**, and the QA skills are invisible until copied into `.agents/skills/`.
- **No mid-run messages to a headless run**, and no CI or PR subscription.

**For cloud:**

- Runs survive the laptop sleeping, each in its own VM.
- The human can open and steer each task from web, desktop or phone.
- `--attempts` gives best-of-N for free in the start command.

**Against cloud:**

- **No event reaches the local Chief of Staff**: only polling `codex cloud list --json`.
- **No documented CLI follow-up**, so `message` falls to the human.
- **No run folder and no local QA Stack**, and personal skills are not synced.
- **How the branch is made and whether the task pushes or opens the PR on its own is undocumented.** `codex apply` brings a diff back, which the skill would then have to commit itself.
- **No CI or PR subscription** to make up for these, unlike Cursor's cloud agents.
- A paid plan and a prepared cloud environment.

**So:** a Dispatch Plan on Codex uses (b) for building and QA, (a) for analysis that writes nothing, and the human-started desktop-app worktree chat as the QA fallback. It does not offer (c) until a follow-up and a completion event for cloud tasks are documented.

## UNCONFIRMED

1. Where a CLI `--worktree` checkout is created, and whether it shares the desktop app's worktree root.
2. Whether `codex exec --json` reports the worktree's path.
3. Whether a CLI worktree starts on a detached HEAD, as desktop-app worktrees do.
4. Whether `codex exec --worktree` runs local-environment setup scripts, and whether `.worktreeinclude` applies to it.
5. Whether the 15-worktree cap and cleanup apply to CLI-made worktrees.
6. Port and env isolation between worktrees' dev servers.
7. Whether `codex exec '$qa-plan 12'`, a `send_input` skill item, or `codex queue` text counts as the user's own explicit invocation of a skill with `allow_implicit_invocation: false`.
8. Whether an `exec` run is on the shared background server, so `codex queue` could reach it while it runs.
9. Whether a thread started through the app server shows in `codex agents` for the human to open, and whether `codex queue` text reaches a running turn or waits for the next.
10. Whether `--approve-for-me` (automatic approval review) approves `git commit`/`git push` in a headless run.
11. A follow-up to an existing cloud task from the CLI, and any public API for cloud tasks.
12. A completion event (webhook, stream, push) for a cloud task that a local session can receive.
13. How a cloud task's branch is named, and whether it can push or open a PR without a human.
14. A model flag for `codex cloud exec`.
15. Whether Free or Go plans get Codex Cloud.
16. The multi-agent tool set in use by default (the docs name `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent`; the source also defines a v2 set with `send_message`, `followup_task`, `list_agents`, `interrupt_agent`), and the default nesting depth of 1, which comes from source only.
