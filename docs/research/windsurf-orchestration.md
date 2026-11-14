# Windsurf (now Devin Desktop): worktrees, parallel agents, and the `orchestrate` verbs

Research for the `orchestrate` skill ([HARNESSES.md](../../.claude/skills/orchestrate/HARNESSES.md)): how Windsurf runs agents in parallel and in isolated checkouts, and how the four verbs (`spawn`, `message`, `await`, `report`) map onto it.

- **Read on:** 2026-11-14. Docs pages carry no publish date, so a fact from a docs page is dated by the read; a fact from a changelog is dated by its release.
- **The product has been renamed.** "Windsurf is now Devin Desktop" (Desktop changelog, v3.0.12, 2026-06-02, [changelog](https://docs.devin.ai/desktop/changelog.md)). `docs.windsurf.com/*` and `windsurf.com/changelog` now redirect (307/308) to `docs.devin.ai/desktop/*` (checked 2026-11-14). The FAQ: "Windsurf becomes Devin Desktop, with the Agent Command Center as the primary view", under one Devin brand with Devin Cloud, Devin CLI and Devin Review ([FAQ](https://docs.devin.ai/desktop/devin-desktop-faq.md)).
- **Cascade is gone.** "Cascade has been removed. Devin Local is now the only agent available in Devin Desktop" (v3.9.19, 2026-09-08). Devin Local is "our next-generation agent harness shared with Devin CLI" ([Devin Local](https://docs.devin.ai/desktop/devin-local/overview.md)), so the agent this study covers is the Devin CLI harness, inside the editor or in a terminal. Cascade facts (parallel Cascades, workflows, its worktree cap) are given only where they still shape behaviour; they come from [Cascade (legacy)](https://docs.devin.ai/desktop/cascade.md).
- **Versions at the read:** Devin Desktop 3.12.59 (2026-11-12) and Devin CLI v3000.12.57 (2026-11-12), the newest entries in the [Desktop changelog](https://docs.devin.ai/desktop/changelog.md) and the [CLI changelog](https://docs.devin.ai/cli/changelog/stable.md).
- **Sources:** primary only. The Markdown form of each docs page (`https://docs.devin.ai/<page>.md`), both changelogs, the Devin API v3 reference, and the Devin Cloud product guides. No staff forum post was needed or used.
- **Local install:** neither Devin Desktop nor Windsurf is in `/Applications`, and `which devin windsurf` finds nothing, so no `--help` output was read. CLI facts come from the [command reference](https://docs.devin.ai/cli/reference/commands.md), which says it matches `man devin`.
- **UNCONFIRMED** marks anything no primary source states. Every one is listed again at the end.

## 1. Worktrees

**Starting one** ([Devin Local Worktrees](https://docs.devin.ai/desktop/devin-local/worktrees.md)):

- **Desktop only, by the human.** The agent location picker has **Local**, **Worktree** and **Cloud** (v3.9.19). Under **Worktree**: **New worktree** (Desktop creates one for the session) or **Existing worktree**. "You can only pick a worktree at the beginning of a session. Conversations cannot be moved to a different worktree once started." Worktree sessions open at once while the worktree is built in the background (v3.5.17, 2026-07-17).
- **No agent tool and no CLI flag.** No subagent field, no `run_subagent` parameter and no `devin` flag creates a worktree ([Subagents](https://docs.devin.ai/cli/subagents.md), [Commands & Flags](https://docs.devin.ai/cli/reference/commands.md)). An agent that wants one runs `git worktree add` itself.
- **History.** Worktrees arrived for Cascade in Windsurf Wave 13 ("spawn multiple Cascade sessions in the same repository without conflicts", v1.13.3, 2025-12-24); Devin Local got the **Merge** button and existing-worktree pick in v3.6.21 (2026-07-29).

**Where they live.** `~/.windsurf/worktrees/<repo_name>`, each "given a unique random name"; list them with `git worktree list`. The page warns that relative paths outside the repo (`../shared-lib`, path-resolved monorepo deps) can break there.

**Branch naming.** No page states how a Desktop worktree's branch is named, or whether it starts detached: **UNCONFIRMED**.

**Setup: `post_setup_worktree` hook.** In `.windsurf/hooks.json`, run "after each worktree is created and configured", inside the new worktree, with `$ROOT_WORKSPACE_PATH` pointing at the original checkout (example copies `.env` files and installs deps) ([Cascade (legacy)](https://docs.devin.ai/desktop/cascade.md#setup-hook); added v1.13.12, 2026-01-23). It runs for Devin Local worktrees too since v3.8.20 (2026-08-21). It does not run for a worktree made by plain `git worktree add`: **UNCONFIRMED** (no page says either way; it is a Desktop hook).

**Cleanup and limits.** For Devin Local: "Devin Desktop does not remove other worktrees when you create a new worktree. A workspace does not have a worktree limit. When you delete a session, Devin Desktop keeps the worktree." Remove with `git worktree remove <path>`, which keeps the branch. The change log agrees: "Worktrees are no longer deleted automatically once a repository has more than 19 of them" (v3.11.212, 2026-10-23). The Cascade page still describes the old rule (20 per workspace, oldest removed, worktree deleted with its conversation); that applies to legacy Cascade only.

**Applying changes back.** In the IDE view, **Merge** in the changes toolbar "brings the worktree's changes back into your workspace". Whether Merge is a git merge of the branch or a copy of the diff: **UNCONFIRMED**. **Checkout branch** on a PR card finds local clones including worktrees (v3.9.19).

**Source Control panel.** Agent worktrees are hidden unless `git.showDevinWorktrees` is `true` (`git.showWindsurfWorktrees` is deprecated but honoured).

**Ports, env, shared services.** No page covers port collisions between worktrees' dev servers: **UNCONFIRMED**. `post_setup_worktree` is the only documented per-worktree hook.

## 2. Subagents (`run_subagent`)

From [Subagents](https://docs.devin.ai/cli/subagents.md) (CLI page; Devin Local links to it and names the same feature) unless noted.

- **On by default** in the CLI (`subagents_enabled`, applies live); in Desktop it is the **Subagents (Preview)** toggle. An admin can disable them (**Default subagent model: None**). The tools are `run_subagent` and `read_subagent`.
- **Built-in profiles:** `subagent_explore` (read-only codebase tools plus web search; cannot edit or fetch arbitrary URLs) and `subagent_general` (full tools in the foreground, pre-approved tools only in the background). Also built-in: Quick Review and Fast Context are named "subagents" ([Devin Local](https://docs.devin.ai/desktop/devin-local/overview.md)).
- **Custom subagents** (marked **experimental**): `agents/<name>.md` or `agents/<name>/AGENT.md`, under `.devin/agents/` or `.agents/agents/` (project) and `~/.config/devin/agents/` (user; `%APPDATA%\devin\agents\` on Windows). Frontmatter: `name`, `description`, `model`, `allowed-tools` (alias `tools`; a true restriction here, unlike on skills), `max-nesting`. A name that clashes with a built-in is skipped. `.claude/agents/` is not listed as a source: **UNCONFIRMED** whether it is read. There is **no isolation or worktree field**.
- **Model:** "There is no way to name a model for a subagent in a prompt — the `run_subagent` tool takes a profile, not a model." `subagent_general` runs on the parent's model; `subagent_explore` and unpinned custom profiles run on a server-routed "default subagent model", overridable by `agent.subagent_model` in `~/.config/devin/config.json` (v3000.11.92, 2026-10-14). So a per-Delegation model needs a custom profile with `model:` pinned.
- **Parallel and background:** "Background: Runs in parallel while the parent agent continues working. The parent is automatically notified when the subagent completes. Unapproved tools are automatically denied." Background subagents "inherit any tool permissions you have already granted during the current session" and cannot prompt. In the CLI a background subagent keeps the parent's turn active until it finishes (v3000.10.21, 2026-09-10).
- **Own worktree:** **no.** A subagent "shares tools and codebase context with the parent, but operates in its own conversation chain". No page offers isolation for a subagent, by parameter or by request. Two writing subagents share one checkout.
- **Message after finishing:** "Cancelled, failed, or completed subagents can be resumed with a new prompt. You can ask the agent to resume a subagent… Resumed subagents always run in the **foreground**", so the parent blocks while a resumed subagent works.
- **Message while running:** not documented for subagents: **UNCONFIRMED**. (Steering a running _session_ is documented: a message typed while Devin works "is handed to the running turn", v3000.11.92; Desktop v3.11.212.) Interrupting the parent parks running subagents and resumes them on the next message.
- **Nesting:** off by default (the subagent tools are disabled inside a subagent); a custom profile can opt in with `max-nesting: N`.
- **Tools:** `subagent_general` has "full tool access", so shell and git; `ask_user_question` is always withheld. In the background, only pre-approved tools run, so `git push` from a background subagent needs a prior session grant or an allow rule; in Smart mode "mutating `git`" always prompts ([Permissions](https://docs.devin.ai/cli/reference/permissions.md)), which a background subagent turns into a denial.
- **Browser:** the CLI has browser and computer-use tools (fixes to "computer use, recording, and browser tools" permissions, v2026.4.9-0, 2026-04-09), but no page documents them or says whether a subagent gets them: **UNCONFIRMED**.
- **Paths outside the working copy:** "by default, the Devin Local agent can only read/edit files within the workspace" ([Devin Local](https://docs.devin.ai/desktop/devin-local/overview.md#unsupported-enterprise-controls)); Accept Edits "still prompt[s]" for "writes outside the workspace". `/add-dir [path]` adds a workspace directory (user command). Whether `/add-dir` plus an instruction can confine a subagent to a separate worktree: **UNCONFIRMED**.
- **Skills as subagents:** a skill with `subagent: true` or `agent: <profile>` runs as a foreground subagent (experimental). The docs describe this as a way to orchestrate, one level deep ([Creating Skills](https://docs.devin.ai/cli/extensibility/skills/creating-skills.md#running-skills-as-subagents)).
- **Hooks around subagents:** none. The event list is `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `PostCompaction`, `SessionStart`, `SessionEnd` ([Hooks](https://docs.devin.ai/cli/extensibility/hooks/overview.md)); a matcher on `run_subagent`/`read_subagent` is the nearest thing. A Claude-format file that declares `SubagentStop` no longer loses its other hooks (v3000.11.92), which implies `SubagentStop` itself does not fire: **UNCONFIRMED**.

**Sessions, not subagents.** Desktop can also run several top-level sessions at once: the Agent Window views "up to 8 sessions side by side", and a human can "Start a child session from any session's 'More' menu" (v3.11.212). No agent tool starts a sibling or child _local_ session: **UNCONFIRMED** that one exists.

## 3. Cloud agents (Devin Cloud)

From [Devin in Devin Desktop](https://docs.devin.ai/desktop/devin.md), [Cloud CLI](https://docs.devin.ai/cli/cloud.md), [Handoff](https://docs.devin.ai/cli/handoff.md) and the API reference, unless noted. Devin arrived inside Windsurf in Windsurf 2.0 (v2.0.44, 2026-04-15).

- **What it is:** "Each Devin session runs on its own VM with a desktop, browser, and computer use, so it can keep working after you close your laptop."
- **Starting one:** Desktop location picker **Cloud**, or one click to send a local plan to Devin; the web app; Slack, Microsoft Teams, Linear, Jira; a `/devin <task>` comment on an open GitHub PR ([GitHub](https://docs.devin.ai/integrations/gh.md#start-devin-from-a-pr-comment)); automations; the CLI (`devin --cloud`, `/cloud`, `/handoff`); the API and the Devin MCP server.
- **From a local agent, programmatically:**
  - `devin --cloud -p "<prompt>"` "starts a session, sends one prompt, prints Devin's response to stdout, and exits. The session persists; resume it with `devin --cloud -r`." It uses the CLI's stored login, so **no API key**. `--prompt-file` takes the brief from a file. `/repo`, `/platform`, `/model` pick repos, OS and model before the first message (interactive).
  - `/handoff [task]` sends the conversation, repo and branch, "Uncommitted changes" included, to a new cloud session. It is a user command.
  - API v3 `POST /v3/organizations/{org_id}/sessions` (fields include `prompt`, `repos`, `playbook_id`, `devin_mode`, `max_acu_limit`, `structured_output_schema`, `tags`, `title`; **no model field**, only `devin_mode`: `normal`, `fast`, `lite`, `ultra`, `fusion`), and the Devin MCP server (`https://mcp.devin.ai/`) with `devin_session_create`, `devin_session_interact`, `devin_session_gather`. Both need a `cog_` service-user key or personal access token ([Create Session](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions.md), [Devin MCP](https://docs.devin.ai/work-with-devin/devin-mcp.md)).
- **Branches and PRs:** Devin pushes branches and opens PRs through the GitHub App; the session's `pull_requests` list carries them. How a cloud branch is named: **UNCONFIRMED**. `/pickup` (or `/handoff` in a cloud session) checks out the PR branch and starts a local session on it.
- **Follow-ups:** `devin --cloud -r <id-or-url>` reopens any cloud session; API `POST …/sessions/{id}/messages` ("The session will be automatically resumed if suspended"); `devin_session_interact` (status, send messages, sleep, terminate). Whether `devin --cloud -r <id> -p "<text>"` sends one follow-up and exits: **UNCONFIRMED** (the docs show `-r` interactive only). A server-side send queue (`Cmd/Ctrl+Enter`) survives reloads.
- **Completion:** session `status` is `new`, `claimed`, `running`, `exit`, `error`, `suspended`, `resuming`; `status_detail` adds `working`, `waiting_for_user`, `waiting_for_approval`, `finished` ([Get Session](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md)). `devin_session_gather` waits "for multiple sessions to reach a settled state (finished, errored, sleeping, or waiting) before returning. Useful… instead of polling in a loop." No outbound per-session webhook is documented. Desktop sends one native notification when a session finishes or needs input, off by default (`devin.agentNotifications`, [Agent Command Center](https://docs.devin.ai/desktop/agent-command-center.md)).
- **Cloud's own orchestrator:** a cloud session can run **managed Devins**: child sessions "each running in its own isolated VM"; the coordinator can message them and "is woken automatically, even if it is asleep, so it doesn't poll" ([Advanced Capabilities](https://docs.devin.ai/work-with-devin/advanced-capabilities.md#managed-devins)). **Dynamic Workflows** run the fan-out as a Python script ([Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows.md)). Both live entirely in the cloud.
- **What they cannot reach:** the local machine, unless **Local Hands** is used: the session asks, the owner approves a single-use code in Desktop or with `devin connect <CODE>`, and every local tool call asks by default. It needs a session the user owns ("service-user API sessions… cannot request a machine"), the org's **Local Hands** toggle (off by default in enterprise orgs), and no security profile. No screen control locally ([Local Hands](https://docs.devin.ai/work-with-devin/local-hands.md)). The CLI "does not yet support Knowledge, Playbooks, or Secrets" from the Devin account ([Quickstart](https://docs.devin.ai/cli/index.md)), and the reverse (which local skills a cloud session sees) is not stated: **UNCONFIRMED**.
- **Plan and cost:** "Devin is included with every self-serve Devin Desktop plan (Pro, Max, Teams)" and draws on the shared quota; enterprise admins must enable it ([Devin](https://docs.devin.ai/desktop/devin.md)); the FAQ says Devin Cloud "remains a separate SKU" for legacy enterprise. Free is not listed. Access "is rolling out gradually".

## 4. CLI headless mode as a tier 2 Executor

From [Essential Commands](https://docs.devin.ai/cli/essential-commands.md), [Commands & Flags](https://docs.devin.ai/cli/reference/commands.md) and [Permissions](https://docs.devin.ai/cli/reference/permissions.md).

- **Binary:** `devin` (`curl -fsSL https://cli.devin.ai/install.sh | bash`, `brew install --cask devin-cli`, or **Install Devin CLI** in Desktop for enterprise plans).
- **Start:** `devin -p "<prompt>"` ("Single-turn, no REPL: print response to stdout and exit"), or `devin -p --prompt-file <file>`, with `--model <MODEL>` and `--permission-mode <MODE>`. It runs in the current directory, so the Chief of Staff starts it inside a worktree it made with `git worktree add`; there is **no worktree flag**.
- **Output:** plain text on stdout. There is **no `--output-format`/JSON flag**; `--export [PATH]` writes the conversation "after each turn (ATIF format)". Whether stdout or the export carries the session id: **UNCONFIRMED**. `devin list --format json` lists the sessions in the current directory, which gives the id afterwards.
- **Resume:** `devin -c` (most recent session in the current directory) or `devin -r <id>`. `--model` applies on resume (v3000.10.21). That `-p` combines with `-c`/`-r` for a one-shot follow-up is **UNCONFIRMED** (no example shows it). Desktop and CLI share sessions: "sessions can be accessed from both Windsurf and the CLI" (v2.1.29, 2026-04-29); whether `devin -r` can send to a session open in Desktop is **UNCONFIRMED** (Desktop locks a session while its agent runs).
- **Workspace trust:** "Non-interactive `--print` mode cannot show the workspace trust prompt, so it fails in an untrusted directory. Pass `--respect-workspace-trust false`." A fresh worktree may count as untrusted.
- **Permission modes:** `normal` (default; writes and shell prompt), `accept-edits` (workspace edits auto; shell and writes outside the workspace prompt), `smart` (a model judges, but "mutating `git`", installs and `rm` always prompt), `dangerous`/`bypass` (everything auto, admin rules still win), `autonomous` (only with `--sandbox`; edits via `edit`/`write` still prompt). What `-p` does when a call needs approval (deny, fail, or hang) is **UNCONFIRMED**. So an unattended Executor that commits, pushes and writes its report outside the worktree needs `--permission-mode dangerous`, or allow rules (`Exec(git commit)`, `Exec(git push)`, `Write(<run folder>/**)`) in a config file. `--config <PATH>` names a config file per run; whether it replaces or merges with the user config is **UNCONFIRMED**. Either is the human's choice in the Dispatch Plan.
- **Commit attribution:** `"attribution": true` by default adds "Generated with Devin" / Co-Authored-By to commits and PRs ([Config file](https://docs.devin.ai/cli/reference/configuration/config-file.md)); a brief that fixes its own attribution lines must say to drop Devin's or set it off.
- **Rules:** the CLI reads `AGENTS.md`, `AGENT.md`, `.windsurfrules`, `CLAUDE.md`, `~/.claude/CLAUDE.md`, `.cursor/rules` and `.windsurf/rules` ([Configuration Import](https://docs.devin.ai/cli/reference/configuration/read-config-from.md)).
- **Hooks:** it loads `.claude/settings.json` and `~/.claude/settings.json` hooks in Claude Code format, and `.devin/hooks.v1.json` ([Hooks](https://docs.devin.ai/cli/extensibility/hooks/overview.md#where-hooks-live)), so this repo's Claude hooks run under Devin too.
- **Browser headless:** browser tools exist (section 2) but are undocumented; Desktop Previews let "Devin Local, remote agents, and ACP agents" open a browser preview of a local dev server ([Previews](https://docs.devin.ai/desktop/previews.md)), which is an editor feature. A browser in `-p`: **UNCONFIRMED**. An MCP browser server is the documented route for tools, and MCP calls prompt by default.
- **ACP:** `devin acp` runs the agent as an Agent Client Protocol server over stdio, for editors; not a scripting surface.

**Verdict for Q4:** yes, `devin -p` in a Chief-of-Staff-made worktree is a tier 2 Executor, like `claude -p`, with four checks before use: how to get the session id, whether `-p` resumes, what `-p` does at an approval prompt, and the trust flag.

## 5. Skills and slash commands

From [Skills Overview](https://docs.devin.ai/cli/extensibility/skills/overview.md), [Creating Skills](https://docs.devin.ai/cli/extensibility/skills/creating-skills.md), [Configuration Import](https://docs.devin.ai/cli/reference/configuration/read-config-from.md) and [Devin Local Customizations](https://docs.devin.ai/desktop/devin-local/customizations.md).

- **Directories:** project `.agents/skills/`, `.devin/skills/`, `.windsurf/skills/`, `.kiro/skills/`; user `~/.agents/skills/`, `~/.config/devin/skills/`, `~/.codeium/<channel>/skills/`, `~/.kiro/skills/`. Imported in place: `.claude/skills/**/SKILL.md`, `.github/skills/`, `~/.copilot/skills/`, `.codex/skills/`, `~/.codex/skills/`, `.cursor/skills/`, `~/.cursor/skills/` (v3000.10.21). So this repo's `.claude/skills/` loads. **`~/.claude/skills/` is not listed** for Claude Code (only the project path is): **UNCONFIRMED** whether user-level skills there load; `~/.agents/skills/` is the documented user path both tools could share.
- **Precedence:** "When the same skill name is loaded from more than one location, each copy now surfaces with a location prefix (`/agents:foo`, `/claude:foo`)" (v3000.2.17, 2026-07-19). Neither copy wins; which one a bare `/foo` runs: **UNCONFIRMED**.
- **Invocation control:** Devin uses `triggers: [user, model]` (default both). "Set `triggers: [user]` to prevent the agent from invoking a skill on its own." The docs never mention `disable-model-invocation`, which `qa-plan` and `manual-qa` use: **UNCONFIRMED** whether Devin honours it. If it does not, the agent itself can load those skills (it has an in-session `skill` tool, v2026.5.26-0), which removes the guard but also removes the need for a human to type them. `devin skills list --trigger user` and `devin skills show qa-plan` show how Devin read the frontmatter: the first QA run checks that.
- **From a message or a headless prompt:** "Users can invoke skills with `/skill-name` in the chat", with `$ARGUMENTS` and `$1`–`$9` filled from the arguments (v3000.5.20, 2026-08-21). Whether `devin -p "/qa-plan 12"`, a resumed `-p`, or a message sent by another agent counts as that user invocation: **UNCONFIRMED**. Slash commands do reach the agent over ACP, so Desktop sends them as user input.
- **Workflows:** Cascade's `.windsurf/workflows/` (manual-only slash commands) are "specific to Cascade — Devin Local does not support them"; `devin migrate workflows` turns them into skills.
- **Built-in commands that matter here:** `/goal <objective>` keeps working across turns until done or blocked, pausing after 50 turns (v3000.11.92); `/loop`; `/btw` (side chat while the agent works); `/handoff`; `/add-dir`.

## 6. Events the parent can wait on

- **Subagent completion:** background subagents notify the parent automatically when they complete; foreground ones block. Documented for the shared harness, so for Desktop too.
- **Headless runs:** none. When a shell command runs long, "Devin moves it to the background and shows… the background shell ID. Devin can then continue working and check the command's output later" ([Essential Commands](https://docs.devin.ai/cli/essential-commands.md#running-shell-commands)): polling, with no completion event documented: **UNCONFIRMED** that one exists. Running `devin -p` from inside a background subagent, so the subagent's end becomes the event, is an untested idea: **UNCONFIRMED**.
- **Notifications to the human:** CLI `notify` (`never`/`smart`/`always`: bell and OSC 9 when the agent finishes or needs input); Desktop `devin.agentNotifications`. They reach the human, not the parent agent.
- **Hooks:** `Stop` (can block with a `reason` and so continue the turn; receives `last_assistant_message`, v3000.5.20), `SessionEnd` (not in cloud sessions), `SessionStart`. A hook config is a persistent-config change the human approves. No hook wakes a different session.
- **CI and PR comments:** for **cloud sessions only**. "Devin automatically responds to comments on PRs its sessions are working on, as long as the session has not been archived", and `/devin` comments on a PR already being worked on go to that session ([GitHub](https://docs.devin.ai/integrations/gh.md)). The GitHub App reads checks and Actions "to understand if Devin's changes pass CI"; whether a session is woken by its own failing check is **UNCONFIRMED**. **Automations** start _new_ cloud sessions on GitHub events, including "Check run (CI)" and "PR review", with a "Fix CI Failures" template for non-Devin PRs ([Automations](https://docs.devin.ai/product-guides/automations.md)). No CI or PR subscription is documented for local sessions or subagents.
- **Cloud coordinators** are woken when a managed child finishes or needs input; a local agent gets the same with `devin_session_gather` over MCP (needs a key).

## Recommendation: the four verbs on Devin Desktop

Four ways to run an Executor:

|                               | (a) Subagent (`run_subagent`)                                               | (b) Headless CLI (`devin -p`) in a worktree                 | (c) Desktop session in a worktree, human-started | (d) Devin Cloud session                                                |
| ----------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| Own branch and working copy   | No: shares the parent's checkout.                                           | Yes, if the Chief of Staff runs `git worktree add` first.   | Yes: **Worktree** in the location picker.        | Yes: its own VM and clone.                                             |
| Model per Delegation          | Only through a custom profile with `model:`.                                | Yes, `--model`.                                             | Yes, the model picker.                           | `/model` interactively; API has `devin_mode` only.                     |
| Human can open and talk to it | Subagent panel; no talking.                                                 | No.                                                         | Yes: a Live Session.                             | Yes: Desktop, web, phone.                                              |
| `message` after it ends       | "Resume subagent …", runs in the foreground.                                | `devin -r <id>` / `-c`; with `-p` **UNCONFIRMED**.          | The human pastes it.                             | `devin --cloud -r`, API messages, MCP.                                 |
| `message` while it runs       | **UNCONFIRMED**                                                             | No.                                                         | Steering (Enter) by the human.                   | Steering; API messages.                                                |
| `await` without polling       | Yes: background completion notifies the parent.                             | No: wait on the process or poll its shell.                  | No: the human says so.                           | MCP `devin_session_gather` (key); else poll.                           |
| Reaches the run folder        | Reads yes; writes outside the workspace prompt (denied in background).      | Only with `dangerous` mode or an allow rule.                | Writes prompt; the human approves.               | No, unless Local Hands; report as final message.                       |
| User-invoked skills           | Not a user turn; **UNCONFIRMED** if `disable-model-invocation` is honoured. | **UNCONFIRMED** (`-p "/qa-plan 12"`).                       | Yes: the human types `/qa-plan`.                 | **UNCONFIRMED**                                                        |
| Local QA Stack and browser    | Same machine; browser **UNCONFIRMED**.                                      | Same machine; browser **UNCONFIRMED**.                      | Same machine; Previews and the human's browser.  | Own VM browser; local stack only via Local Hands.                      |
| PR review comments and CI     | No.                                                                         | No.                                                         | No.                                              | Yes: answers PR comments on its own PRs.                               |
| Needs                         | Subagents on (Preview toggle in Desktop).                                   | CLI installed and logged in; trust flag; permission choice. | The human at the editor.                         | Paid plan (Pro, Max, Teams) or enterprise enablement; key for API/MCP. |

**Per Delegation:**

- **Building.** `spawn`: the Chief of Staff runs `git worktree add <path> -b <branch> <head>`, then starts `devin -p --prompt-file <brief> --model <model> --permission-mode <approved mode> --respect-workspace-trust false` there as a background process, with stdout redirected to `delegations/<id>/output.txt` by absolute path. The handle is the worktree path plus the session id from `devin list --format json` in that worktree, and the process id. `message`: `devin -r <id>` (or `-c`) with `-p "<text>"` in the same worktree once the run has ended, a check-before-use item. `await`: wait on the process; nothing pushes an event. `report`: the absolute path if the approved mode lets it write there, otherwise its last message, which the Chief of Staff writes into `report.md`. Push and PR: the run pushes its own branch; the Chief of Staff watches CI and review comments with `gh`. If the human wants to watch or steer, (c) instead: the Chief of Staff writes the brief and the human starts a **Worktree** session on it.
- **Analysis.** (a): a background `subagent_explore` (read-only, router model) or a custom read-only profile with `model:` pinned for the plan's model. Sharing the checkout is safe only because it writes nothing; it ends with the report as its last message, which the Chief of Staff writes into `report.md`. `await`: the completion notification. `message`: resume it (it runs in the foreground). Anything that runs code or edits goes to (b).
- **QA.** Never a subagent. First choice (c): a Desktop session the human starts in a worktree on the brief, where the human types `/qa-plan <n>` and later `/manual-qa <plan file>`; it has the local QA Stack, Previews, and the human's approvals. (b) becomes the first choice only once a run confirms that `-p "/qa-plan <n>"` runs the skill and that `-p` has a browser. (d) is out unless the QA Stack is hosted.

**Tier.** Devin Desktop is **tier 2**. Its headless CLI starts and resumes runs in the background; its subagents give a tier 1 `await` (a completion notification) but no isolation, so they serve analysis only. The Live Sessions it has (Desktop sessions in worktrees) can be started only by the human, which is tier 3 for those. Devin Cloud reaches tier 1 (a session the human can open and talk to, an `await` through `devin_session_gather`), but outside the local machine. A Windsurf block in HARNESSES.md would read: building by headless run, analysis by subagent, QA by a session the human starts.

## Verdict: cloud agents, or local?

**Local is the default: headless runs for building, subagents for analysis, a human-started session for QA.** Devin Cloud is an opt-in per building Delegation.

**For local:**

- No extra plan, key or connection beyond a logged-in CLI.
- It reaches the local QA Stack and the Chief of Staff's run folder (with the approved permission mode).
- This repo's `.claude/skills/`, `CLAUDE.md`, `AGENTS.md` and `.claude/settings.json` hooks load as they do for Claude Code.
- Desktop no longer deletes worktrees (v3.11.212), so a long run does not lose one to a cap.

**Against local:**

- **No isolation for subagents**, and no worktree flag for the CLI: the Chief of Staff makes every worktree itself.
- **No completion event for a headless run**: `await` is waiting on a process, and a `-p` follow-up is unconfirmed.
- **Unattended writes and pushes need `dangerous` mode or allow rules**, since Smart mode always asks for mutating git.
- **No CI or PR-comment subscription** for any local session.
- **User-invoked skills are unconfirmed headless**, and `disable-model-invocation` may be ignored.

**For cloud:**

- **PR comments reach the session** that opened the PR, with no subscription to set up.
- **The human can open and steer** every session from Desktop, the web or a phone: a true Live Session.
- **A local agent can start one with no key**: `devin --cloud -p`.
- **`devin_session_gather`** is a real `await` without polling.
- **Survives the laptop closing**; managed Devins and Dynamic Workflows are built for fan-out.

**Against cloud:**

- **No run folder and no local QA Stack**; Local Hands bridges that only with the owner's approval per connection, and not for service-user API sessions.
- **`await` without polling needs an API key** for the MCP server or API, which the human must provide; the skill never types it.
- **No model field in the API**, only `devin_mode`.
- **Cost:** a paid plan's shared quota (or a separate SKU for legacy enterprise), and access is still rolling out.
- **Unknown skill loading**: which local skills a cloud session sees is not documented.

**So:** offer (d) for a building Delegation when the human wants PR babysitting or to steer from a phone, and say in the Dispatch Plan that its report comes back as its last message. Default to (b) for building, (a) for read-only analysis, and (c) for QA.

## UNCONFIRMED

1. How a Desktop worktree's branch is named, and whether it starts detached.
2. Whether `post_setup_worktree` runs for a worktree made by `git worktree add` rather than by Desktop.
3. Whether **Merge** is a git merge or a diff copy.
4. Port and env isolation between worktrees' dev servers.
5. Whether `.claude/agents/` is read for custom subagents.
6. Messaging a subagent while it runs.
7. Whether `/add-dir` plus an instruction can confine a subagent to a separate worktree.
8. Whether subagents (or `-p` runs) can use the browser tools, and whether `-p` has a browser at all.
9. Whether Claude Code's `SubagentStop` hook fires under Devin.
10. Whether any agent tool starts a sibling or child local session.
11. How a Devin Cloud branch is named.
12. Whether `devin --cloud -r <id> -p "<text>"` sends one follow-up and exits.
13. Which local skills a cloud session loads.
14. Whether `devin -p` stdout or `--export` carries the session id.
15. Whether `-p` combines with `-c`/`-r` for a one-shot follow-up.
16. Whether `devin -r` can send to a session open in Desktop.
17. What `-p` does when a tool call needs approval.
18. Whether `--config <PATH>` replaces or merges with the user config.
19. Whether `~/.claude/skills/` (user level) loads.
20. Which copy a bare `/foo` runs when two locations define `foo`.
21. Whether Devin honours `disable-model-invocation: true`.
22. Whether `devin -p "/qa-plan 12"`, a resumed `-p`, or an agent-sent message counts as the user's own skill invocation.
23. Whether a headless run's end produces any event the parent can wait on (and whether running it inside a background subagent works as one).
24. Whether a cloud session is woken by a failing check on its own PR.
