# Cursor: worktrees, parallel agents, and the `orchestrate` verbs

Research for the `orchestrate` skill ([HARNESSES.md](../../.claude/skills/orchestrate/HARNESSES.md)): how Cursor runs agents in parallel and in isolated checkouts, and how the four verbs (`spawn`, `message`, `await`, `report`) map onto it.

- **Read on:** 2026-11-14. Cursor's docs pages carry no publish date, so a fact from a docs page is dated by the read, and by the Cursor version the page names when it names one.
- **Sources:** primary only. The Markdown form of each docs page (`https://cursor.com/docs/<page>.md`), the changelog (`https://cursor.com/changelog`, pages 1 to 8, back to May 2026), the CLI changelog, the Cloud Agents release notes, and forum replies by Cursor staff. The forum does not label staff; a reply is counted as staff when it speaks for Cursor ("logged your report with the team"), and the name is given.
- **Local install:** Cursor IDE 3.28.7 (`cursor --version`, arm64). The Cursor CLI (`agent`) is not installed on this machine, so no `--help` output was read; CLI facts come from the CLI docs and CLI changelog.
- **The earlier run:** facts found only in the real Cursor run quoted in the task (the `best-of-n-runner` subagent type, the `subscribe_github_ci` tool) are marked **observed in run**, not documented.
- **UNCONFIRMED** marks anything no primary source states. Every one is listed again at the end.

## 1. Worktrees

**Three ways to start one** ([Worktrees](https://cursor.com/docs/configuration/worktrees.md)):

- **Agents Window:** start an agent in a worktree, or move a running agent into one. "UI-native" worktrees exist only in the Agents Window (Cursor 3, generally available 2026-04-02, per [Agents Window](https://cursor.com/docs/agent/agents-window.md)).
- **IDE:** the built-in Worktree skills, `/worktree <task>` (the rest of the chat runs in a separate checkout), `/best-of-n <models> <task>` (one worktree per model; compares, merges nothing), `/apply-worktree` (bring changes into the main checkout) and `/delete-worktree`. These were announced with Cursor 3 by staff (Colin, 2026-04-02, [forum](https://forum.cursor.com/t/cursor-3-worktrees-best-of-n/156507)). Colin said on 2026-04-08 that `/best-of-n` does not work in Plan mode.
- **CLI:** `agent -w|--worktree [name]`, with `--worktree-base <branch>` (default: current HEAD) and `--skip-worktree-setup` ([CLI parameters](https://cursor.com/docs/cli/reference/parameters.md), [Using the CLI](https://cursor.com/docs/cli/using.md#cli-worktrees)).

**Where they live.** `~/.cursor/worktrees/<reponame>/<name>`, shared by the CLI and the editor; the CLI generates a name when none is given ([Using the CLI](https://cursor.com/docs/cli/using.md#cli-worktrees)). Staff (deanrie, 2026-02-12, [forum](https://forum.cursor.com/t/how-do-you-get-worktree-edits-to-apply/150760/3)) confirms `~/.cursor/worktrees/`. On this machine (3.28.7) editor-made worktrees are folders with 4-character random names under `~/.cursor/worktrees/<repo>/`.

**Branch naming.** No doc states how an editor or CLI worktree's branch is named, or whether it starts detached: **UNCONFIRMED**. On this machine, worktrees inspected had a named branch (one the agent chose or was told). The Cloud Agents API names cloud branches `cursor/...` unless told to use the starting branch ([API](https://cursor.com/docs/cloud-agent/api/endpoints.md), `workOnCurrentBranch`).

**Setup: `.cursor/worktrees.json`** ([Worktrees](https://cursor.com/docs/configuration/worktrees.md)):

- Read when a worktree is created in the Agents Window, the IDE or the CLI; looked up first in the worktree, then at the project root.
- Keys: `setup-worktree-unix`, `setup-worktree-windows` (each wins over the generic one on its OS), `setup-worktree`. Each takes an array of shell commands run in the worktree, or a script path relative to the JSON file.
- `$ROOT_WORKTREE_PATH` points at the main checkout (for copying `.env` files and the like). Symlinking dependencies is discouraged. Logs: Output panel, **Worktrees Setup**.
- CLI v2026.07.13: setup commands run only once the workspace is trusted (trust prompt, saved trust, or `--trust` headless) ([CLI changelog](https://cursor.com/docs/cli/changelog.md)).

**Cleanup and limits** ([Worktrees](https://cursor.com/docs/configuration/worktrees.md), Cursor 3.5+): cleanup runs on an interval and keeps the newest worktrees up to a machine-wide cap shared by all workspaces. Settings `cursor.worktreeCleanupIntervalHours` (no default given) and `cursor.worktreeMaxCount` (default 25). Cleanup rediscovers the root each pass, so **worktrees made outside the manager, by `/worktree` or by plain `git worktree add` under that root, can be deleted**. Going over the cap triggers an immediate cleanup. Staff (Mohit, 2026-03-09, [forum](https://forum.cursor.com/t/working-with-worktrees-in-cursor/153472)): local worktrees are "session-scoped sandboxes" and "aren't meant to persist across sessions".

**Applying changes back.** Keep working there, commit or open a PR from the worktree, or bring the result into the main workspace (`/apply-worktree` in the IDE) ([Worktrees](https://cursor.com/docs/configuration/worktrees.md)). Staff (deanrie, 2026-02-12): applied changes are "merged back into your current branch".

**Ports, env, shared services.** No primary source covers port collisions between worktrees' dev servers, or a per-worktree port: **UNCONFIRMED**. `worktrees.json` is the only documented hook to set env per worktree.

**One checkout per folder.** Staff (Mohit, 2026-07-10, [forum](https://forum.cursor.com/t/sessions-silently-switch-git-branch-when-another-session-opens-a-different-branch/165286)): in the desktop IDE "every agent and chat session you open on the same folder shares one Git checkout", so a branch switch by any session or subagent changes it for all; a worktree gives its own checkout and branch.

## 2. Subagents (the Task tool)

From [Subagents](https://cursor.com/docs/subagents.md) unless noted. Subagents arrived in Cursor 2.4 ([changelog 2.4](https://cursor.com/changelog/2-4)).

- **Built-in types:** the docs name two, `explore` and `browser`. The hooks reference lists `subagent_type` values `generalPurpose`, `explore`, `shell`, "etc." ([Hooks](https://cursor.com/docs/hooks.md#subagentstart)). `best-of-n-runner` appears in no doc: **observed in run** only.
- **Custom subagents:** Markdown with YAML frontmatter in `.cursor/agents/`, `.claude/agents/`, `.codex/agents/` (project) or `~/.cursor/agents/`, `~/.claude/agents/`, `~/.codex/agents/` (user). Project beats user on a name clash; `.cursor/` beats `.claude/` and `.codex/`. Fields: `name`, `description`, `model` (default `inherit`; a model id, with options such as `[effort=high]`), `readonly`, `is_background`. There is **no isolation or worktree field**.
- **Model:** per subagent by `model`, or the parent names one at launch. A blocked or unavailable model now falls back to the parent's model and says so (CLI v2026.10.22, [CLI changelog](https://cursor.com/docs/cli/changelog.md); Cloud Agents release notes, week of 2026-10-19).
- **Parallel and background:** several Task calls in one message run at once. A background subagent returns at once and writes its output to `~/.cursor/subagents/`, which the parent can read. CLI v2026.07.06: "Background subagents include their final message in the completion notification" ([CLI changelog](https://cursor.com/docs/cli/changelog.md)). Cursor 3.3 (2026-05-07) added async subagents and `/multitask` in the editor ([changelog p.8](https://cursor.com/changelog/page/8)).
- **Own worktree:** parallel subagents **share the parent's checkout by default** and can overwrite each other. "Ask for isolation" (in the prompt, e.g. "each in its own environment") and each gets its own branch: a local Git worktree, or a cloud VM with a clone. "Changes stay on each subagent's branch until the parent agent merges the results." No documented Task-tool parameter forces it; it is a request in words. Staff (Mohit, 2026-07-27, [forum](https://forum.cursor.com/t/agent-parallel-subagents-overwrite-dirty-worktree-destructive-git-recovery-wastes-tokens/166666)) put a reported overwrite down to "parallel subagents sharing one working tree", and said a `beforeShellExecution` hook can hard-deny destructive git verbs.
- **Resume after finishing:** each run returns an agent ID; "Resume agent abc123 and …" continues it with context. Background subagents can be resumed after they complete. CLI v2026.07.06: completed subagents keep checkpoints across resumes. Sending text to a local subagent **while it runs** is not documented: **UNCONFIRMED**. For cloud subagents the API refuses follow-ups and steers ("Send them to the parent agent", [API](https://cursor.com/docs/cloud-agent/api/endpoints.md#send-a-follow-up-or-steer)).
- **Nesting:** since 2.5, the main agent and its direct subagents can launch subagents; a grandchild cannot. The SDK lets subagents nest to any depth (changelog 2026-06-04, [p.6](https://cursor.com/changelog/page/6)).
- **Tools:** subagents inherit all parent tools, including MCP. Shell and git are not named, but `readonly` exists to restrict "state-changing shell commands", so a non-readonly subagent has them. `git push` from a subagent is not stated: **UNCONFIRMED** (likely, under the parent's run mode).
- **Skills and slash commands in a subagent:** not stated. A skill with `disable-model-invocation: true` "is only included when explicitly invoked via `/skill-name`" ([Skills](https://cursor.com/docs/skills.md)), so a subagent cannot pick up `/qa-plan` or `/manual-qa` on its own. Whether a Task prompt that begins `/qa-plan 12` counts as that explicit invocation: **UNCONFIRMED**.
- **Browser:** the built-in `browser` subagent drives the browser through MCP tools. Whether a custom or worktree-isolated subagent can use the browser tool itself: **UNCONFIRMED** (it inherits MCP tools, so a Playwright MCP server would reach it). Browser state persists per workspace, cookies included ([Browser](https://cursor.com/docs/agent/tools/browser.md)); **Browser Protection** can force approval of browser tools ([Run modes](https://cursor.com/docs/agent/security/run-modes.md)).
- **Paths outside the worktree:** reads outside the workspace are allowed by default (Read access **System**); 3.23 (2026-10-01) added a **Workspace** mode that asks first. **External-File Protection** makes the agent ask before it creates or changes files outside the workspace ([Run modes](https://cursor.com/docs/agent/security/run-modes.md)). Whether a worktree-isolated subagent's "workspace" is the worktree or the parent's folder, and so whether writing `delegations/<id>/report.md` in the parent checkout needs approval: **UNCONFIRMED**.
- **Hooks around subagents:** `subagentStart` (allow or deny, sees `git_branch`, `is_parallel_worker`) and `subagentStop` (status, summary, `modified_files`, transcript path; can return `followup_message` to continue the subagent, loop limit default 5) ([Hooks](https://cursor.com/docs/hooks.md#subagentstop)).

## 3. Cloud Agents (formerly Background Agents)

From [Cloud Agents](https://cursor.com/docs/cloud-agent.md) unless noted.

- **Starting one:** Cursor iOS, cursor.com/agents, the desktop app (pick **Cloud**), Slack `@cursor`, `@cursor` on a GitHub PR or issue (or a Bitbucket PR), Linear, the API. Also: CLI `&` prefix hands the live conversation to a cloud agent ([CLI overview](https://cursor.com/docs/cli/overview.md)); `/in-cloud` hands the next task to a cloud subagent and `/autopilot` puts a PR on a cloud agent ([Subagents](https://cursor.com/docs/subagents.md#cloud-subagents); shipped 3.7, 2026-06-17 as `/in-cloud` and `/babysit`, [changelog p.5](https://cursor.com/changelog/page/5)). Needs a connected source-control provider and a plan with Cloud Agents (Premium and up, Teams, Enterprise, legacy paid; not Free or Plus), and a spend limit.
- **From a local session, programmatically:** a local agent can ask for a cloud subagent ("or its own cloud environment"), and `/in-cloud` is a skill the user types. A shell call to the API (`POST https://api.cursor.com/v1/agents`) or the SDK (`@cursor/sdk`, `Agent.create({cloud…})`) also works, but needs `CURSOR_API_KEY` ([API](https://cursor.com/docs/cloud-agent/api/endpoints.md), [TypeScript SDK](https://cursor.com/docs/sdk/typescript.md)). Whether the local agent can start a **top-level** cloud agent (one the API can follow up) without a key: **UNCONFIRMED**.
- **API (v1, public beta):** create takes `prompt`, `model {id, params}`, `repos[{url, startingRef | prUrl}]`, `workOnCurrentBranch`, `autoCreatePR`, `envVars`, `mcpServers`, `customSubagents` (up to 20), `mode`. The response is a durable agent (`bc-…`) plus a run. Agent `status` is `ACTIVE`, `IDLE` (follow-ups accepted) or `ARCHIVED`; run status ends `FINISHED`, `ERROR`, `CANCELLED` or `EXPIRED`, with `result` (final reply) and `git.branches[]` (branch and PR URL).
- **Follow-ups:** `POST /v1/agents/{id}/runs`. One run at a time: a follow-up during a run gets `409 agent_busy`, unless sent with `delivery: "steer"`, which reaches the running turn at its next safe step.
- **Completion:** SSE `GET /v1/agents/{id}/runs/{runId}/stream` (`status`, `result`, `done` events), or poll Get A Run. v1 "Webhooks are coming soon"; the legacy v0 API sends a signed `statusChange` webhook on `FINISHED` or `ERROR` ([Webhooks](https://cursor.com/docs/cloud-agent/api/webhooks.md)). A webhook needs a public URL the local session does not have. Phone push on finish or need-input exists (3.9, [changelog p.5](https://cursor.com/changelog/page/5)).
- **Branches and PRs:** cloud agents work on a separate branch and push; they can open the PR (`autoCreatePR`), and they subscribe to PRs they create to fix CI and bot comments (2026-08-19, [changelog p.3](https://cursor.com/changelog/page/3)).
- **What they cannot reach:** your local files, local stack and local browser; they clone from the provider. User hooks in `~/.cursor/hooks.json` do not run. Local MCP servers do not come along (team MCP config at cursor.com/agents applies). User skills in `~/.cursor/skills/` load only once **Sync Skills for Cloud Agents** is on; `~/.agents/skills/`, `~/.claude/skills/` and project skills outside the repo stay local ([Skills](https://cursor.com/docs/skills.md#use-personal-skills-with-cloud-agents)). They have their own desktop and browser (computer use) and attach artifacts to PRs ([Capabilities](https://cursor.com/docs/cloud-agent/capabilities.md)).
- **The local stack, if needed:** Self-Hosted Machines move tool execution to a machine you run (`agent worker start`, `--computer-use`, API `env.type: "machine" | "pool"`) ([Self-Hosted](https://cursor.com/docs/cloud-agent/self-hosted.md), [CLI parameters](https://cursor.com/docs/cli/reference/parameters.md)). Since 2026-09-02.
- **Cost and models:** plan usage at the model's rate (legacy request plans: API rate plus Max Mode upcharge); "a curated selection of models"; `GET /v1/models` lists valid ids.
- **Cursor's own orchestrator:** **Projects** (beta, 2026-09-10): a cloud coordinator that "doesn't write code itself", delegates to many agents in parallel, holds shared context, subscribes to Slack, PRs and CI, and "starts a local agent" when something must be tested on your machine ([Projects](https://cursor.com/docs/agent/projects.md)). Driveable through the API's Projects endpoints.

## 4. CLI headless mode as a tier 2 Executor

From [Headless](https://cursor.com/docs/cli/headless.md), [Parameters](https://cursor.com/docs/cli/reference/parameters.md), [Output format](https://cursor.com/docs/cli/reference/output-format.md), [Using the CLI](https://cursor.com/docs/cli/using.md).

- **Binary:** the docs call it `agent` (install `curl https://cursor.com/install -fsS | bash`). The older name `cursor-agent` appears in none of the current pages: whether it still works as an alias is **UNCONFIRMED**.
- **Start:** `agent -p "<brief>" --model <id> --output-format json|stream-json [--worktree <name> --worktree-base <ref>] [--workspace <repo>] [--trust] [--force]`. The JSON `result` object carries `session_id`, `result`, `is_error`, `duration_ms`.
- **Resume:** `agent -p "<text>" --resume <session_id>` (or `--continue`). A message cannot reach a run still working, as with Claude Code.
- **Permissions:** without `--force`, print mode edits workspace files and runs allow-listed commands, and **rejects writes outside the workspace** and anything needing approval. So a headless Executor in its own worktree **cannot write the report into the Chief of Staff's run folder** unless it runs with `--force` (or `approvalMode: unrestricted`), or `permissions.allow` covers it. The human's choice, in the Dispatch Plan. Admins can disable headless mode for a team.
- **Rules:** the CLI reads `.cursor/rules`, `AGENTS.md` and `CLAUDE.md` at the root.
- **Subagents in headless runs:** single-turn runs wait for their subagents before exiting (CLI v2026.08.11).
- **Persistent sessions** (CLI v2026.08.26): `agent persist`, `/detach`, `agent persist attach`, `agent persist list|stop`, `agent persist --resume`. A human could attach to watch and type, close to a Live Session. Whether `agent persist` takes a starting prompt non-interactively: **UNCONFIRMED**.
- **Skills headless:** skills are invoked by typing `/skill-name`; the CLI resolves "typed `/skill-name`" (CLI v2026.07.06, `user-invocable: false` hides a skill from it). Whether `-p "/qa-plan 12"` runs the skill as the user's own invocation: **UNCONFIRMED**.
- **Browser headless:** no CLI page mentions a browser tool. A browser via an MCP server (`--approve-mcps`) is the documented route: **UNCONFIRMED** that it works under `-p`.
- **SDK alternative:** `@cursor/sdk` runs the same agent locally (`local: {cwd}`) or in the cloud, with `Agent.resume(id)` ([TypeScript SDK](https://cursor.com/docs/sdk/typescript.md)). Needs `CURSOR_API_KEY`.

**Verdict for Q4:** yes, it fits tier 2 exactly as `claude -p` does today, with two Cursor-specific checks: the out-of-workspace write rule, and the skill-in-`-p` question.

## 5. Skills and slash commands

From [Skills](https://cursor.com/docs/skills.md).

- **Directories:** `.agents/skills/`, `.cursor/skills/` (project, and nested anywhere in the repo, scoped to that subtree), `~/.agents/skills/`, `~/.cursor/skills/` (user), plus for compatibility `.claude/skills/`, `.codex/skills/`, `~/.claude/skills/`, `~/.codex/skills/`. So this repo's `.claude/skills/orchestrate` loads in Cursor.
- **Precedence** between a user-level and a project-level skill of the same name, or between `.cursor/skills` and `.claude/skills`: not stated (unlike subagents): **UNCONFIRMED**.
- **Invocation:** the agent picks skills by `description`, or the user types `/` and picks one, which attaches it to one message (Option+Enter makes it a sticky Custom Mode). `disable-model-invocation: true` limits a skill to an explicit `/skill-name`. `qa-plan` and `manual-qa` both set it.
- **From a message or a subagent:** whether text a Chief of Staff sends (a subagent prompt, a "resume agent … /qa-plan 12" message) counts as the explicit invocation: **UNCONFIRMED**. The only documented way is the user typing it.
- **Built-in skills that matter here:** `/loop` (rerun a prompt on an interval, or until an event; 3.5, 2026-05-20, [changelog p.7](https://cursor.com/changelog/page/7)), `/autopilot` (watch a PR and address feedback, conflicts and checks), `/automate`, `/review`.

## 6. Events the parent can wait on

- **Subagent completion:** foreground Task blocks and returns; background subagents send a completion notification with their final message (CLI v2026.07.06). For the IDE the notification is **UNCONFIRMED**; the parent can also read `~/.cursor/subagents/`.
- **Hooks:** `subagentStop` and `stop` can each feed a `followup_message` back, a way to wake the parent or the subagent without polling ([Hooks](https://cursor.com/docs/hooks.md)). They are config files (`.cursor/hooks.json`), so adding one is a persistent-config change the human approves.
- **CI and PR subscriptions:** documented for **cloud agents only** ("Subscriptions are available for cloud agents only, for now", 2026-08-19, [changelog p.3](https://cursor.com/changelog/page/3)). GitHub sources: PR activity (comments, reviews, lifecycle) for one PR, and CI results on a branch; CI delivers once, when every check on the commit is done; at most 180 days; not for service-account agents ([Capabilities](https://cursor.com/docs/cloud-agent/capabilities.md#subscriptions)). The earlier run's `subscribe_github_ci` in a local session, refused from a subagent, is **observed in run**; local availability is undocumented. That a **CI** subscription does not deliver review comments matches the docs: review comments come through a separate **PR** subscription, which the run did not try.
- **Automations:** cloud agents triggered by GitHub events, including "PR review comment" (3.8, 2026-06-18, [changelog p.5](https://cursor.com/changelog/page/5)), Slack, schedules, webhooks ([Automations](https://cursor.com/docs/cloud-agent/automations.md)). They start new agents; they do not wake the local Chief of Staff.

## Recommendation: the four verbs on Cursor

Three ways to run an Executor on Cursor:

|                               | (a) Local subagent, isolated worktree                                                             | (b) Cloud Agent                                                        | (c) CLI headless (`agent -p`)             |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| Own branch and working copy   | Yes, when the prompt asks for isolation (or `best-of-n-runner`, observed in run). Not by default. | Yes, `cursor/...` branch on a VM clone.                                | Yes, `--worktree <name>`.                 |
| Model per Delegation          | Yes, at launch or in frontmatter.                                                                 | Yes, `model.id`.                                                       | Yes, `--model`.                           |
| Human can open and talk to it | Can read its transcript; cannot talk to it while it runs.                                         | Yes: cursor.com/agents, mobile, follow-ups.                            | No (unless `agent persist`, unconfirmed). |
| `message` after it ends       | "Resume agent `<id>` …"                                                                           | `POST /v1/agents/{id}/runs` (not for cloud *sub*agents).               | `--resume <session_id>`.                  |
| `message` while it runs       | **UNCONFIRMED**                                                                                   | `delivery: "steer"`.                                                   | No.                                       |
| `await` without polling       | Foreground blocks; background notifies on completion (CLI documented).                            | SSE stream, or poll; no webhook in v1.                                 | Wait on the process.                      |
| Reaches the run folder        | Reads yes; writes may need approval (External-File Protection).                                   | No: report as final message.                                           | Only with `--force` or an allow rule.     |
| User-invoked skills           | No (`disable-model-invocation`).                                                                  | **UNCONFIRMED**                                                        | **UNCONFIRMED**                           |
| Local QA Stack and browser    | Same machine; browser via `browser` subagent or MCP, unconfirmed.                                 | No, unless a Self-Hosted Machine.                                      | Same machine; browser unconfirmed.        |
| PR review comments and CI     | Parent only, and only as observed in run.                                                         | Yes: PR and CI subscriptions.                                          | No.                                       |
| Needs                         | Nothing extra.                                                                                    | Cloud plan, connected repo, spend limit; API key for programmatic use. | CLI installed, logged in.                 |

**Per Delegation:**

- **Building.** `spawn`: a background Task subagent told to work "in its own isolated worktree on branch `<branch>`", with the plan's model; the handle is the returned agent ID. Check right after spawn that the subagent's working directory is a worktree under `~/.cursor/worktrees/` on the named branch, never the Chief of Staff's checkout, because isolation is a request in words, not a parameter. `message`: "Resume agent `<id>`: …", once it has ended. `await`: end the turn on background completion; never poll. `report`: the absolute path; if the write is refused, the last message, which the Chief of Staff writes into `report.md` (as HARNESSES.md already allows). Push and PR: the subagent pushes its own branch. Review comments after the PR: the subagent cannot subscribe (observed in run), so the Chief of Staff watches CI and the PR itself, or the human opts into (b).
- **Analysis.** A Task subagent, `readonly: true` or told not to edit, sharing the checkout is acceptable only when it writes nothing; the default should still be a worktree for anything that runs code. Same `message`, `await` and `report` as building.
- **QA.** Never a subagent: it cannot take `/qa-plan` or `/manual-qa`. First choice: (c), `agent -p "<brief>" --worktree <name> --output-format json`, then `--resume <id>` with `/qa-plan <n>` and later `/manual-qa <plan>`; if the CLI does not run them as user invocations, or has no browser, fall back to "a session the human starts": an Agents Window agent in a worktree where the human types the two commands. That is the fallback HARNESSES.md already names. (b) is out unless the QA Stack is hosted or a Self-Hosted Machine runs it.

**Tier.** Cursor sits between tier 1 and tier 2: it can start isolated parallel Executors and is told when a background one ends (tier 1's `await`), but the human cannot talk to a local subagent while it works (not a Live Session). Treat local subagents in worktrees as the Executor for building and analysis, the CLI as tier 2 for QA, and say so in a Cursor block of HARNESSES.md.

## Verdict: cloud agents, or local subagents?

**Local subagents in isolated worktrees are enough, and should be the default.** Cloud agents are an opt-in for building Delegations, not the base.

**For local:**

- No extra plan, key or connection.
- They see the local stack and the run folder.
- `spawn`, `message` (resume by ID) and `await` (completion notification) are all documented.
- Skills under `~/.claude/skills` and `.claude/skills` load as they do for the Chief of Staff.

**Against local:**

- **Isolation is not the default.** It must be asked for and then checked; a slip means two Executors in one checkout, the failure the skill forbids.
- **Worktrees are session-scoped**, and cleanup deletes the oldest ones over a cap of 25, including ones made by hand under `~/.cursor/worktrees`. A long run must keep under the cap and push early.
- **No CI or PR-comment subscription** from the subagent; the parent has it only as observed in run.
- **No mid-run messaging** documented.

**For cloud:**

- **The PR subscription** (review comments and CI, waking the agent) is the one thing local cannot match.
- **The human can open and steer** each agent from web or phone: a true Live Session.
- **They survive the laptop closing.**
- Cursor's own Projects coordinator is built on them.

**Against cloud:**

- **The local Chief of Staff has no push event** from them: only an SSE stream, or polling the API, with v1 webhooks "coming soon".
- **Programmatic start needs `CURSOR_API_KEY`**, which the human must provide; the skill must never type it.
- **No run folder:** reports come back as the final message.
- **No local QA Stack and no unsynced user skills**, so the skill's own user-level skills may be missing.
- **Cost:** cloud plans only, with a spend limit.
- **No follow-ups to cloud subagents:** a cloud subagent started from the local session cannot be messaged by API, only through its parent.

**So:** offer (b) per building Delegation in the Dispatch Plan when the human wants PR babysitting, or wants to watch or steer from a phone. Default to (a) for building and analysis, and (c), falling back to a human-started session, for QA.

## UNCONFIRMED

1. How editor and CLI worktree branches are named, and whether they start detached.
2. Port and env isolation between worktrees' dev servers (no documented mechanism beyond `worktrees.json`).
3. `best-of-n-runner` as a Task subagent type, and a Task-tool parameter that forces isolation (observed in run; docs say only "ask for isolation").
4. Messaging or steering a local subagent while it runs.
5. Whether a worktree-isolated subagent's workspace is its worktree, and so whether writing to the parent's run folder needs approval.
6. `git push` from a subagent (likely, not stated).
7. Whether a subagent can use the browser tool directly, rather than through the `browser` subagent or an MCP server.
8. Whether a subagent prompt, a resume message, `agent -p "/qa-plan 12"`, or an API prompt counts as the user's explicit `/skill-name` invocation for a `disable-model-invocation` skill.
9. Precedence between a user-level and a project-level skill of the same name, and between `.cursor/skills` and `.claude/skills`.
10. Whether the IDE (not just the CLI) delivers a background subagent's completion to the parent as a notification.
11. A local agent starting a top-level cloud agent without an API key.
12. `subscribe_github_ci` or any subscription tool in a local session (observed in run; docs say cloud only), and whether a local PR subscription delivers review comments.
13. Whether `cursor-agent` still works as an alias for `agent`.
14. Whether `agent persist` takes a starting prompt non-interactively, so it could serve as a Live Session from a shell.
15. A browser tool in CLI print mode.
