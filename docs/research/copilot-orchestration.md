# GitHub Copilot: worktrees, parallel agents, and the `orchestrate` verbs

Research for the `orchestrate` skill ([HARNESSES.md](../../.claude/skills/orchestrate/HARNESSES.md)): how GitHub Copilot runs agents in parallel and in isolated checkouts, and how the four verbs (`spawn`, `message`, `await`, `report`) map onto it. "Copilot" here is three surfaces that share one runtime (the Copilot SDK): the **Copilot CLI** (`copilot`), **agent mode in VS Code** (the Copilot harness, in the Chat view and the Agents window), and the **Copilot cloud agent** (Copilot in the cloud on GitHub.com).

- **Read on:** 2026-11-14. docs.github.com pages carry no publish date, so a fact from one is dated by the read. code.visualstudio.com pages show "11/11/2026" and name no version; the matching release is VS Code 1.146 (released 2026-11-11, [release notes](https://code.visualstudio.com/updates/v1_146)). CLI facts are dated by the CLI version and date in the official changelog ([github/copilot-cli `changelog.md`](https://github.com/github/copilot-cli/blob/main/changelog.md)), latest 1.0.112 of 2026-11-13.
- **Sources:** primary only. docs.github.com (Markdown bodies via `https://docs.github.com/api/article/body?pathname=<path>`), code.visualstudio.com (the `.md` form of each docs page, and the release notes 1.135 to 1.146), the CLI changelog and releases in `github/copilot-cli`, the REST reference for agent tasks, and local `--help` output. No forum post was needed.
- **Local install:** GitHub Copilot CLI **1.0.77** (2026-07-30, `copilot --version`), well behind the latest 1.0.112. Its `copilot --help`, `copilot help commands|permissions|config|environment|limits` and `copilot skill --help` were read; flags added later (`--worktree` outside experimental mode, `--fleet`, `--assisted-approval`, `--trust-folder`) are absent from it and come from the docs and the changelog. GitHub CLI 2.102.0 (`gh agent-task --help`). VS Code is not installed (`which code` finds nothing), so no VS Code fact was observed locally.
- **Nothing was run** beyond `--help`: no prompt was sent to any Copilot surface, because that spends the human's AI credits. Every behavioural question a prompt would settle is **UNCONFIRMED**, with the check to run.
- **UNCONFIRMED** marks anything no primary source states. Every one is listed again at the end.

## 1. Worktrees

**Copilot CLI** ([command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#command-line-options), [config reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)):

- **Built in.** `-w, --worktree[=NAME]` "create[s] or reuse[s] an isolated Git worktree under `<repo>.worktrees/` by default and start[s] the session inside it". `NAME` is the branch; omitted, a branch name is generated. It conflicts with `--resume`, `--continue` and `--connect`. Interactive equivalents: `/worktree [branch|task]` (new worktree, uncommitted changes stay behind), `/move` (carries them along), `/new worktree [PROMPT]` (a new conversation in a new worktree), `/fork worktree` (forks the conversation into a worktree off `HEAD`).
- **History** (changelog): `/worktree` 1.0.61 (2026-06-09); `--worktree` experimental 1.0.64 (2026-06-23); generally available "without enabling experimental mode" 1.0.85 (2026-09-16). On the local 1.0.77 it still needs `--experimental`.
- **Where.** Default `<repo>.worktrees/`, "with slashes in the branch name flattened to dashes". Setting `worktreePathTemplate` (1.0.87, 2026-09-21) moves it, with `{repoPath}`, `{repo}`, `{branch}`, `{branchSlug}`. Whether `<repo>.worktrees/` is beside the checkout or inside it is not stated: **UNCONFIRMED**.
- **Branch naming.** A valid branch name is kept "exactly as typed, e.g. feature/JIRA-123" (1.0.66). With no argument, `/worktree` names the branch from the changes and conversation; a task sentence names it for that task (1.0.66). Base: `worktreeBaseRef` `"head"` (default since 1.0.79, 2026-08-10) or `"defaultBranch"`.
- **Setup scripts.** None of Copilot's own. Git `post-checkout` hooks run against the new worktree under `--worktree` (fix in 1.0.109). Folder trust carries to the new worktree (1.0.60, 1.0.72), and "Linked worktrees resolve to the main repository root, so they share permissions with the main worktree" (config reference).
- **Cleanup and limits.** No documented cap and no automatic cleanup for CLI worktrees: **UNCONFIRMED**. `/session cleanup|prune` clean session data, not worktrees as far as the docs say.
- **Applying back.** Nothing CLI-specific: commit, push and open a PR (`/pr create`).

**VS Code** ([Agents window](https://code.visualstudio.com/docs/agents/run/agents-window), [Manage sessions](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions), [Run parallel tasks](https://code.visualstudio.com/docs/agents/guides/delegate-two-tasks)):

- **Built in, per session.** An isolation dropdown offers **Branch** (edit the current folder) or **New Worktree** ("A separate Git worktree" from committed files on a chosen base branch; needs at least one commit; uncommitted, untracked and ignored files are not copied). `sessions.useWorktree` sets the first default. Dev Container sessions cannot use a worktree.
- **Where.** A "managed `<repository>.worktrees` directory" (Manage sessions, cleanup section). Branch naming is not stated: **UNCONFIRMED**.
- **Setup.** `git.worktreeIncludeFiles` copies ignored files in; `git.worktreeSymlinkFolders` (experimental) symlinks large ones.
- **Cleanup.** Archiving ("Mark as Done") commits uncommitted changes to the session branch, then removes the folder; restoring re-creates it. Deleting a Copilot-harness session removes its worktrees. **Chat: Open Worktree Cleanup** (VS Code 1.141, 2026-10-07) reclaims inactive ones, and can remove "Git-registered session worktrees under the managed `<repository>.worktrees` directory" even with no listed session, so a worktree made by hand under that folder is at risk. Optional auto-cleanup of sessions whose PR merged (`chat.agentSessions.autoMarkAsDoneMergedSessionsAfterDays`, default off). An experimental suggestion fires at 5 GiB or 20 worktrees.
- **Applying back.** **Merge Changes** merges a worktree session into its configured base branch (only when the branch has no PR); **Create PR** commits, pushes and opens a PR, with optional **Auto-Merge** or experimental **Agent merge**.
- **Not a security boundary.** "A worktree is a Git code-isolation boundary, not a security boundary" ([harness concepts](https://code.visualstudio.com/docs/agents/concepts/agent-harnesses)); "Separate worktrees can still share ports, databases, and other external resources" (Run parallel tasks).

**Cloud agent:** clones into its own environment; "can only work on one branch at a time and can open one pull request per task" ([about](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)). Branch naming (historically `copilot/…`) is not stated on any page read: **UNCONFIRMED**.

## 2. Subagents and parallel agents in a session

**Copilot CLI** ([command reference: custom agents, agent communication, subagent limits](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#custom-agents-reference)):

- **Tools.** `task` ("Run subagents"), `read_agent` ("Check background agent status"), `write_agent` ("Send a message to a running agent"), `list_agents`. Background agents for all users since 0.0.404 (2026-02-05); `/tasks` lists and kills them.
- **Built-in agents:** `code-review`, `explore`, `general-purpose`, `research`, `rubber-duck`, `security-review`, `task`, each with a default model.
- **Custom agents:** `*.agent.md` (or `.md`) in `~/.copilot/agents/` (priority 1), `.github/agents/` (2), `.claude/agents/` (3), `--add-dir` roots (4), plugins (5), org/enterprise (6). Frontmatter: `description` (required), `name`, `tools` (default all), `model`, `models`, `modelPolicy`, `reasoningEffort`, `mcp-servers`, `infer`, `include-custom-instructions` (default `false`: a custom subagent does **not** read `AGENTS.md` or `CLAUDE.md` unless set), `sidekick`. **No isolation or worktree field.**
- **Model per agent.** Highest first: an explicit per-call value, the `subagents` override in `~/.copilot/settings.json` (or `/subagents`), the agent's `model`/`models`, then the parent's. A model that cannot be honoured falls back to the session's, unless `modelPolicy: "required"`.
- **Own worktree: no.** No page or changelog entry gives a subagent its own checkout; subagents run in the session's working directory. Treat them as sharing the Chief of Staff's checkout (**UNCONFIRMED** only in that it is not stated outright).
- **Message while running: yes.** `write_agent` to a running agent; "Messaging a running background agent now steers its active turn at the next processing opportunity" (1.0.92, 2026-10-05). Multi-turn subagents "always enabled" (1.0.72, 2026-07-20).
- **Message after finishing: yes, within the session.** A background agent that ends a turn goes `agent_idle`, "waiting for `write_agent`" ([hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference#notification-hook)). Idle subagents are hidden from `/tasks` after 2 minutes (1.0.8). Whether a subagent survives the parent session's end and can be resumed later: **UNCONFIRMED**.
- **Parallel and limits.** Concurrency across the session tree is plan-based: Free 2, Pro/Pro+ 4, Max 8, Business 16, Enterprise 32; depth default 6 per the reference, though 1.0.71 (2026-07-16) says the default was lowered "from 6 to 4" (the two disagree: **UNCONFIRMED** which holds). Overrides only on usage-based billing. `/fleet` (or `--fleet`) asks the main agent to split a task across parallel subagents.
- **Nesting:** yes, to the depth limit; nested subagents keep parent tool restrictions (1.0.67) and MCP tools (1.0.106).
- **Tools available:** all by default (`tools: ["*"]`), shell and git included, under the session's permissions. Only the root agent writes memories. `git push` from a subagent is not stated; it is a shell command under the same rules: **UNCONFIRMED**.
- **Browser:** the bundled `browser-use` plugin is "Disabled by default", needs `/mcp enable browser-use`, a browser extension and Node.js 22+; or any MCP server such as Playwright. Whether a subagent can drive it: **UNCONFIRMED** (it inherits allowed MCP tools, 1.0.106).
- **Writing outside the working copy:** "By default, file access is restricted to paths within the current working directory and its subdirectories, plus the system temporary directory" (`copilot help permissions`, 1.0.77); `--add-dir`, `/add-dir` or `--allow-all-paths` widen it.
- **Hooks:** `subagentStart` (adds context, cannot block) and `subagentStop` (can `block` to force another turn, or `modifiedResponse`).

**VS Code (Copilot harness)** ([Subagents](https://code.visualstudio.com/docs/agents/run/subagents), [Use tools](https://code.visualstudio.com/docs/agents/run/tools#coordinate-work-across-sessions)):

- **Subagents:** the Copilot harness "uses the native `task` tool for delegation", the same runtime as the CLI. In the Agents window "Read-only subagent chats show a lock icon and don't accept input". No worktree per subagent is documented. (The Local harness's `runSubagent` is stateless and can't be messaged, and Local is deprecated, removed February 2027.)
- **Session-management tools: the part that matters.** "In sessions using the Copilot or Claude harness, agents can use built-in session-management tools": list sessions with "status, workspace, and file changes"; "Create sessions or nested sessions"; "Read another conversation's recent context"; "Send messages to start or steer follow-up work". The doc's own example: "Create an independent session in the vscode workspace with a new worktree to implement and test the authentication change." The created session is a full session the human can open and type into (an **Open Session** pill links to it).
- **`send_message`:** queues for a busy chat (VS Code 1.137, 2026-09-09); steers, queues, replaces or cancels (1.141, 2026-10-07). "Sending a message to another session always requires confirmation"; "Agents can't send messages to the chat they are currently running in". Limits on created sessions, messages per hour and recursion depth (`chat.agentHost.agentOrchestrationLimits`, on by default; raised in 1.140, 2026-09-30).
- **Not documented:** a model parameter when a tool creates a session, and whether the creating session is told when the created one ends: both **UNCONFIRMED**.
- **Browser:** built-in browser tools ("don't require an external MCP server", `workbench.browser.enableChatTools`, on by default) ([Browser tools](https://code.visualstudio.com/docs/agents/run/browser-tools)). Browser tabs "belong to the session where you open them".

## 3. Cloud agent (Copilot in the cloud)

From [About](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent), [Using it on GitHub](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github), [API how-to](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api), [REST: agent tasks](https://docs.github.com/en/rest/agent-tasks/agent-tasks).

- **Two environments:** GitHub Actions-based (custom `copilot-setup-steps`, self-hosted runners, 59-minute cap per session, GitHub website only) and a **cloud sandbox** (resumable across clients, firewall allowlists, no Actions setup steps). Also "Remote (a connection to a custom environment)". VS Code's own **Cloud** target (experimental, `chat.agentHost.cloudSandbox.enabled`) replaces the Actions workflow for new cloud sessions in the Agents window.
- **Starting one:** the Agents tab or Copilot prompt on GitHub.com, GitHub Mobile, assigning an issue to Copilot, `@copilot` on a PR, automations, Slack and Teams integrations, the CLI's `/delegate` or `&` prefix ([Delegating tasks](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/delegate-tasks-to-cca)), VS Code's **Cloud** target, `gh agent-task create "<prompt>" [--base <branch>] [--custom-agent <name>] [--follow]` (preview, gh 2.102.0 help; no model flag), and the REST API.
- **From a local session, programmatically:** yes, by shell. `gh agent-task create` or `POST /agents/repos/{owner}/{repo}/tasks` with `prompt`, optional `model` ("If omitted, auto model selection is used"), `base_ref`, `head_ref` (commit to an existing PR branch), `create_pull_request` (default false). The POST is "only available to users with a Copilot Business or Copilot Enterprise subscription" and takes user-to-server tokens only. Whether `gh agent-task create` has the same plan limit: **UNCONFIRMED**.
- **Branches and PRs:** prompt-started tasks work on a branch and open a PR on request; issue-assigned and `/delegate` tasks open a draft PR at once and "request a review from you" when done. `/delegate` targets the current branch by default (1.0.69).
- **Follow-ups:** `@copilot` in a PR comment ("By default, Copilot pushes commits directly to the pull request branch"), **Fix with Copilot** on review comments, steering in the session view. "Copilot only responds to comments from people who have write access". After an issue is assigned, Copilot "won't react to" later issue comments. The REST API has no follow-up endpoint (list, get and start only).
- **Completion:** task `state` is `queued`, `in_progress`, `completed`, `failed`, `idle`, `waiting_for_user`, `timed_out` or `cancelled`, read by polling the API or `gh agent-task view`; on finish it adds you as a reviewer, "triggering a notification". No webhook for agent tasks is documented: **UNCONFIRMED**.
- **CI on its pushes:** "By default, GitHub Actions workflows will not run automatically when Copilot pushes changes to a pull request"; the human clicks **Approve and run workflows**, unless a setting allows it.
- **Cannot reach:** local files, the local QA Stack, the run folder; the Actions environment's network is limited by the firewall to GitHub and Copilot hosts by default ([hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference#cloud-agent-execution-environment)). It has the GitHub and **Playwright** MCP servers by default ([MCP](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers)), so a browser, but only against what it can run itself. Project skills in `.github/skills`, `.claude/skills` or `.agents/skills` load ([skills](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/add-skills)); user skills only through dotfiles personalization in cloud sandboxes.
- **Plan and cost:** "Starting October 28, 2026, the new Copilot in the cloud experience … is available to users with a paid Copilot plan". Compute draws on the GitHub account's monthly allowance, "separate from AI credits".
- **Agent Merge:** "Copilot watches a pull request and works on the blockers you select", via **Watch and fix** in the merge box.

## 4. CLI headless mode as a tier 2 Executor

From the [command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#command-line-options), the [programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference) and local `copilot --help` (1.0.77).

- **Start:** `copilot -p "<brief>" --model <id> --output-format json --worktree=<branch> --no-ask-user --allow-all-tools --add-dir <run folder>` as a background process. `--allow-all-tools` is "required for non-interactive mode" (1.0.77 help); `--assisted-approval` is the reviewed middle ground, and anything still needing approval "is denied". `--trust-folder` trusts the repo's hooks and MCP for one run. `-s` prints only the answer.
- **Handle:** the exit summary "includes a `copilot --resume=SESSION-ID` hint"; `--session-id <uuid>` sets the id up front for a new session, so the Chief of Staff can choose the handle itself. JSON mode emits JSONL with a final result record carrying an exit status (1.0.109, 2026-11-10) and session start events (1.0.108). The field names of that result record are not documented: **UNCONFIRMED**.
- **Resume:** `copilot -p "<text>" --resume=<id>` (or `--session-id <id>`). `--resume` restores the session's working directory (relative paths resolve against it, 1.0.83). It conflicts with `--worktree`, so `message` is a resume, never a new `--worktree`. A message cannot reach a run that is still working.
- **Background work:** "Non-interactive mode waits for all background agents to finish before exiting" (1.0.33), bounded by `COPILOT_TASK_WAIT_TIMEOUT_SECONDS`.
- **Writing outside the worktree:** refused by default; `--add-dir <run folder>` permits exactly the run folder, the narrow choice the Dispatch Plan should name (rather than `--allow-all-paths`).
- **Commit and push:** shell tools under `--allow-all-tools`, or narrowly `--allow-tool='shell(git:*)' --allow-tool='shell(gh pr create)' --allow-tool=write`. `includeCoAuthoredBy` (default `true`) adds a Co-authored-by trailer.
- **Remote watching:** `/remote on` exists only in interactive sessions; `--remote` is "Not supported for interactive startup or with `-p`". A headless run cannot be opened and steered by the human while it works.

**Verdict for Q4:** yes. `copilot -p … --worktree --output-format json` and `--resume=<id>` fit tier 2 exactly as `claude -p` does, with `--add-dir` for the report path. Upgrade first: the local 1.0.77 still gates `--worktree` behind experimental mode.

## 5. Skills and slash commands

- **CLI locations, in priority order (first found wins):** `.github/skills/`, `.agents/skills/`, `.claude/skills/`, parent `.github/skills/`, `~/.copilot/skills/`, `~/.agents/skills/`, plugins, `COPILOT_SKILLS_DIRS`, `--add-dir` roots, bundled, org/enterprise ([skills reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#skills-reference)). So **project beats user**, and this repo's `.claude/skills/` loads, in a `--worktree` checkout too.
- **`~/.claude/skills` is not read:** "Custom agents, skills, and commands from ~/.claude/ are no longer loaded by the Copilot CLI" (1.0.36, 2026-04-24). The skill's own metadata says `agent-kit-scope: user`; a user-level install for Copilot must go to `~/.copilot/skills/` or `~/.agents/skills/`.
- **VS Code:** the docs list `.github/skills/` and `~/.copilot/skills/` for the Copilot harness, "not every directory it recognizes" ([Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills#skill-locations)); that it reads `.claude/skills/` as the CLI does is likely (same runtime) but **UNCONFIRMED** for VS Code.
- **Frontmatter:** `user-invocable` (default true) and `disable-model-invocation` (default false) are honoured ("Fully honor the skill disable-model-invocation flag", 1.0.74). `qa-plan`, `manual-qa` and `orchestrate` set `disable-model-invocation: true`, so the model's `skill` tool cannot load them; only `/<name>` can.
- **`/<name>` in a prompt:** "include the skill name in your prompt, preceded by a forward slash" ([add skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)); slash commands may appear mid-input, several per message (1.0.44); a `-p` prompt may start with a slash command (`/review`, [programmatic how-to](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)); 1.0.108 stopped a path like `/docs/setup.md` loading a skill "as if you had invoked that skill", which implies a leading `/name` in prompt text is an invocation. Whether `-p "/qa-plan 12"` or `--resume=<id> -p "/manual-qa <plan>"` runs a `disable-model-invocation` skill as the user's own invocation: **UNCONFIRMED**. Check: one `-p "/qa-plan <n>"` run, and look for the skill's first step in the transcript.
- **Via `write_agent` or VS Code `send_message`:** whether text another agent sends counts as a user invocation: **UNCONFIRMED**; nothing documents it.
- **`.claude/commands/*.md`** load as an alternative skill format (0.0.399), lower priority than skills.

## 6. Events the parent can wait on

- **CLI, in-session:** "Automatic notifications when background shell commands and agents complete" (0.0.422, 2026-03-05). A background subagent's end, and a background **shell's** end, wake the model without polling. So a Chief of Staff in the CLI can start each headless Executor as a background shell and end its turn: the shell's completion is the `await` event.
- **CLI `notification` hook:** fire-and-forget, types `shell_completed`, `shell_detached_completed`, `agent_completed`, `agent_idle`, `permission_prompt`, `elicitation_dialog`; may return `additionalContext`, "injected into the session as a prepended user message", which "can trigger further agent processing if the session is idle". CLI only. Hooks live in `.github/hooks/*.json`, `~/.copilot/hooks/`, settings files, and `.claude/settings.json`; adding one is a persistent-config change the human approves.
- **`agentStop` / `subagentStop`:** can `block` with a `reason` to force another turn (capped at 8 in a row).
- **CI and review, locally:** no subscription that wakes a local session on a check result or a review comment is documented. `/pr auto` "paces itself around CI to drive the PR to green" (1.0.66) for the current branch, and an opt-in status-line item shows CI state (1.0.65). For the Chief of Staff, `gh pr checks <n> --watch` in a background shell turns CI into a shell-completion event; review comments still need a read at an interval: **UNCONFIRMED** that anything better exists.
- **VS Code:** Agent merge (`chat.agentMerge.enabled`, experimental) has a session watch its own PR and address reviews, failed required checks and conflicts; sessions-list inline actions send "fix checks" or "address comments" to a session (1.146). A session-tool-created session telling its creator it has ended: **UNCONFIRMED**.
- **Cloud:** poll task `state`; the PR review request and `@copilot` comments are the human-facing events. Agent Merge on GitHub.com watches Actions failures and conflicts.

## Recommendation: the four verbs on Copilot

Four ways to run an Executor:

|                               | (a) CLI headless (`copilot -p`)                         | (b) VS Code session made by a session tool          | (c) CLI subagent (`task`)                     | (d) Cloud agent                                    |
| ----------------------------- | ------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| Own branch and working copy   | Yes, `--worktree=<branch>`.                             | Yes, when asked for "a new worktree".               | No: the session's checkout.                   | Yes, its own clone and branch.                     |
| Model per Delegation          | Yes, `--model`.                                         | **UNCONFIRMED** at creation; the human can pick it. | Yes, per call or per agent.                   | Yes, API `model`; not via `gh agent-task`.         |
| Human can open and talk to it | No.                                                     | Yes: a full session in the Agents window.           | Can read it in `/tasks`.                      | Yes: session view, PR comments.                    |
| `message` after it ends       | `--resume=<id> -p "…"`.                                 | `send_message`, human confirms each one.            | `write_agent` (idle agent).                   | `@copilot` PR comment; no API.                     |
| `message` while it runs       | No.                                                     | `send_message` steer, human confirms.               | `write_agent` steers.                         | Steer in the session view.                         |
| `await` without polling       | Background-shell completion notification.               | **UNCONFIRMED**; list sessions' status.             | Completion notification.                      | No: poll `state`.                                  |
| Reaches the run folder        | With `--add-dir <run folder>`.                          | **UNCONFIRMED** (approval or `/add-dir`).           | Yes, same checkout.                           | No: report as final message.                       |
| User-invoked skills           | **UNCONFIRMED** (`-p "/qa-plan n"`).                    | The human types it; by message **UNCONFIRMED**.     | No (`disable-model-invocation`).              | **UNCONFIRMED**.                                   |
| Local QA Stack and browser    | Same machine; browser via `browser-use` or MCP.         | Same machine; built-in browser tools.               | Same machine; shared checkout.                | No; Playwright only against what it runs.          |
| PR review comments and CI     | No.                                                     | Agent merge (experimental).                         | No.                                           | `@copilot`, Fix with Copilot, Agent Merge.         |
| Needs                         | CLI ≥ 1.0.85 for `--worktree` without `--experimental`. | VS Code 1.137+ (steering 1.141+), Copilot harness.  | Nothing extra; plan sets concurrency (Pro 4). | Paid plan; API start needs Business or Enterprise. |

**Per Delegation, Chief of Staff in the CLI (the surface this skill can drive from a shell):**

- **Building.** `spawn`: `copilot -p "<brief>" --session-id <uuid> --worktree=<branch> --model <model> --output-format json --no-ask-user --allow-all-tools --add-dir <run folder>`, run as a background shell from the Chief of Staff's checkout, output to `delegations/<id>/output.jsonl`. The handle is the uuid. Right after `spawn`, check with `git worktree list` that the branch's worktree exists and is not the Chief of Staff's checkout. `message`: `copilot -p "<text>" --resume=<uuid>` once the run has ended. `await`: end the turn; the background shell's completion notification is the event. `report`: the report file by absolute path, else the last message. The permission flags are the human's choice in the Dispatch Plan.
- **Analysis.** A `task` subagent (`explore`, `research`, or a custom read-only agent with `tools` limited), sharing the checkout only because it writes nothing; it returns its result, and `write_agent` reaches it running or idle. Anything that runs code or edits gets (a).
- **QA.** Never a subagent. First choice (a) on the brief, then `--resume=<uuid> -p "/qa-plan <n>"` and later `-p "/manual-qa <plan file>"`, with a browser through `browser-use` or a Playwright MCP server (`--additional-mcp-config`). If `-p` does not run the skill as the user's invocation, or no browser works headless, fall back to "a session the human starts": `copilot --worktree=<branch>` interactively (or a VS Code worktree session), where the human types the two commands.
- **CI and review.** The Chief of Staff watches each PR itself: `gh pr checks <n> --watch` in a background shell for CI, and a read of review comments at an interval; it relays them with `message`.

**Chief of Staff in VS Code (Copilot harness):** `spawn` is a session-management tool call creating "an independent session … with a new worktree"; `message` is `send_message`, each one confirmed by the human; `await` and the model choice are **UNCONFIRMED**, so until checked the Chief of Staff lists sessions' status at an interval matched to the work. The created session is a Live Session in all but the end-of-turn signal.

**Tier.** The CLI is **tier 2**, with tier 1's `await`: headless runs in their own worktree, resumed by id, and a completion notification for each background shell, but the human cannot open a headless run while it works. VS Code's Copilot harness sits **between tier 1 and tier 2**: it starts sessions the human can open and talk to, in their own worktrees, but each message needs the human's confirmation and no end-of-turn signal to the creating session is documented. Write a Copilot block in HARNESSES.md with the CLI as the default Chief of Staff surface and VS Code as a tier 1 candidate once its `await` is checked.

## Verdict: cloud agents, or local?

**Local, and the default should be the CLI's headless runs in their own worktrees.** The cloud agent is an opt-in for a building Delegation, not the base.

**For local:**

- `spawn`, `message` and `await` are all documented for (a), and the end of a background shell wakes the Chief of Staff without polling.
- `--add-dir` lets an Executor write its report into the run folder, narrowly.
- The local QA Stack and a browser are on the same machine.
- Project skills in `.claude/skills/` load in every worktree.
- Nothing beyond the Copilot plan the human already has.

**Against local:**

- **No CI or review-comment subscription** for a local session; the Chief of Staff watches with `gh`.
- **The human cannot watch a headless run.** Only VS Code's created sessions (b) are openable, and their `await` is unconfirmed.
- **Subagents share the checkout**, so only read-only work goes to them.
- **No documented worktree cap or cleanup** in the CLI; VS Code's cleanup can remove registered worktrees under `<repository>.worktrees`, so a long run pushes each branch as soon as it has a commit.

**For cloud:**

- **PR-native follow-ups:** `@copilot`, Fix with Copilot on review comments, and Agent Merge for failed workflows and conflicts.
- **The human can open and steer it** from the web or GitHub Mobile.
- **It survives the laptop closing.**

**Against cloud:**

- **No push event to the local Chief of Staff:** poll task `state`; no webhook documented.
- **No follow-up API:** `message` is a PR comment, which is a write in the human's name.
- **Workflows do not run on its pushes** until the human approves them, unless a setting allows it, so CI evidence waits on a click.
- **No run folder, no local QA Stack**, and user-level skills only via dotfiles in cloud sandboxes.
- **API start needs Copilot Business or Enterprise**; the 59-minute cap applies to Actions-based sessions.

**So:** default to (a) for building and QA and (c) for read-only analysis; offer (d) per building Delegation only when the human wants PR babysitting or to steer from a phone; offer (b) when the Chief of Staff runs in VS Code and the human wants to watch each Executor.

## UNCONFIRMED

1. Whether `copilot -p "/qa-plan <n>"` (or the same text sent by `--resume`, `write_agent` or VS Code `send_message`) runs a `disable-model-invocation` skill as the user's own invocation.
2. Whether a VS Code session created by a session-management tool notifies its creator when it ends a turn (the `await` signal), and whether the tool takes a model.
3. Whether a headless `-p` run can drive a browser (`browser-use` plugin or a Playwright MCP server) for `manual-qa`.
4. Field names of the final JSONL result record from `-p --output-format json` (session id, result text, exit status).
5. Whether a VS Code worktree session can write the run folder in the Chief of Staff's checkout without an approval or `/add-dir`.
6. Whether a CLI subagent always runs in the session's working directory (no page says so outright) and whether it can `git push`.
7. Where `<repo>.worktrees/` sits relative to the checkout, and VS Code's worktree branch naming.
8. Any cap or automatic cleanup for CLI-made worktrees.
9. Default subagent nesting depth: 6 (command reference) or 4 (changelog 1.0.71).
10. Whether a CLI subagent survives the parent session's end and can be resumed later.
11. Whether the VS Code Copilot harness reads `.claude/skills/` as the CLI does.
12. Cloud agent branch naming, and whether a webhook exists for agent-task state changes.
13. Whether `gh agent-task create` shares the REST start endpoint's Business or Enterprise requirement.
14. Whether a cloud agent task runs user-invoked skills from a prompt.
15. Any local subscription that delivers PR review comments or CI results to a CLI or VS Code session, beyond `/pr auto` for the current branch.
