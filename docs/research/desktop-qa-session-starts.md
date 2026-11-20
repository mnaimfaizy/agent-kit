# Starting a QA Delegation on the desktop harness without a click

Research for [#402](https://github.com/mnaimfaizy/agent-kit/issues/402), a ticket of the map [#396](https://github.com/mnaimfaizy/agent-kit/issues/396) (autonomous QA in `orchestrate`). The question: on the Claude Code desktop harness, how can a QA Delegation start with no human click, when `start_session` is refused on turns the app starts? This note says which turns may call it, and lays out each way a QA Delegation could start without a click, with its evidence and its cost. It recommends nothing; the map's grilling decides.

- **Read on:** 2026-11-21.
- **Repo facts** are cited as `path:line` at commit `8866831` (origin/main on 2026-11-21).
- **Sources:** primary only.
  - The desktop app's own session tools, read from the tool descriptions the app gave a Code session on 2026-11-21: `start_session`, `send_message`, and the `scheduled-tasks` server's `create_scheduled_task` and `run_scheduled_task`. Marked **tool description**: first-party, but not a docs page, and they can change with any app update.
  - The `Agent` tool's description in the same session (**tool description**).
  - Claude Code docs pages: [desktop](https://code.claude.com/docs/en/desktop) and [headless](https://code.claude.com/docs/en/headless), read 2026-11-21.
  - `claude --help` and `claude agents --help`, Claude Code CLI 2.1.316 on `PATH`.
  - The Activity Logs of two runs on this harness, in the main checkout's gitignored run folder: `tmp/orchestrate/2026-11-17-spec-253/activity.md` and `tmp/orchestrate/2026-11-19-spec-344/activity.md`. Cited as **spec-253 log:line** and **spec-344 log:line**. They are not committed, so a reader without them has only the short facts quoted here.
- **UNCONFIRMED** marks anything no source states. Every one is listed again at the end.

## 1. Which turns may call `start_session`

### What the tool says

The `start_session` tool description (**tool description**, 2026-11-21) gives three values of `initiation`:

- `user_asked`: "the user asked in words for separate, parallel or background work, or told you to start this piece — it starts now".
- `offer`: a task the user named in their latest message; it shows a card and waits for the answer.
- `own_initiative`: work the model proposes itself; "it waits as a proposal card until the user starts it".

So the rule is about **consent in the user's own words**, not about turn type as such. The description names no turn type. The app enforces it: on a turn with no user words in it, a `user_asked` call is refused, and only a card is left.

The [desktop](https://code.claude.com/docs/en/desktop) docs page documents the card from the human's side ("Start a task that Claude suggests": **Start**, **Do it here**, **Start all**), lets Claude "list your other Code tab sessions, read what each has been doing, and send messages between them" ("Work across sessions"), and documents no rule on which turns may start a session. Nothing on the page names `start_session`.

### What the runs saw

| Turn that called `start_session`                            | Result                 | Evidence                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The human's own turn ("go", or an answer typed in chat)     | Started                | spec-253 log:14 (d255, d256, d257 at "Go, per-ticket"); log:31 (d255-qa, the turn after the human's "Yes, both" at log:28); log:51 (d255-qa2, after DR6 answered); log:88 (d259-qa, on "Merge as it is"). spec-344 log:12 (d348 at "go autonomous, 2", log:10) |
| A Delegation's turn-end straight after the human's own turn | Started                | spec-344 log:19 (d349); recorded in `.claude/skills/orchestrate/harnesses/claude-code-desktop.md:14`                                                                                                                                                           |
| A background command's completion notice                    | Refused; card proposed | spec-253 log:58 (d256-qa), log:68 (d258-qa)                                                                                                                                                                                                                    |
| A side-session event                                        | Refused; card proposed | spec-253 log:96 (d257-qa)                                                                                                                                                                                                                                      |
| A heartbeat firing                                          | Refused; card proposed | spec-344 log:26 (d350)                                                                                                                                                                                                                                         |
| A turn where the human answered an `AskUserQuestion`        | Refused; card proposed | spec-344 log:60 (d344-fix1): the answer "does not count as the user's own turn"                                                                                                                                                                                |
| Other app-started turns                                     | Card proposed          | spec-344 log:34, 42, 47 (d351, d352, d353)                                                                                                                                                                                                                     |

spec-253's close-out recorded the rule as a new harness fact (spec-253 log:100). The harness file already holds it (`claude-code-desktop.md:14`) and its Limits say an unattended run stalls at each wave until the human clicks (`claude-code-desktop.md:39`). Every card in both runs was started by the human (spec-253 log:59, 71, 97; spec-344 log:28, 36, 43, 49, 62).

**Why every QA Delegation hits it.** A QA Delegation starts only once its head is verified (`.claude/skills/orchestrate/SKILL.md:257`), and a head is verified on a turn that a report, a re-gate or a review wait woke: an app-started turn. Its brief is pinned to that head (`.claude/skills/orchestrate/BRIEF.md:20`, `:32`). So unless the human happens to speak in that turn, every QA start is a card. spec-253's QA starts that did not need a card all followed a human answer (log:31, 51, 88).

**`send_message` is not limited this way.** The tool description says a message "arrives in the target session as a user turn" and starts it ("delivered") or queues it. Messages to Delegations were sent on app-started turns: spec-344 log:76 messaged d344-fix1 on the turn a review run finished. A message to an idle Delegation starts a turn in it (`claude-code-desktop.md:15`). That the review-finished turn at spec-344 log:76 was app-started is read from the log's order, not stated in it: **UNCONFIRMED** in that one case, but no run has logged a refused `message`.

## 2. The options

### A. Start the QA sessions at "go", parked until their head is verified

The human's "go" approves the Dispatch Plan, which already names a row for each QA Delegation (`SKILL.md:144`). On that turn, `start_session` with `user_asked` starts sessions (spec-253 log:14, spec-344 log:12). So the Chief of Staff could start every QA session at "go", each on a brief that says "wait for your head", and later `message` it the head on whatever turn verifies it.

- **Evidence it would work:** sessions start at "go" (above); a `message` to an idle session starts a turn in it, on any turn (`claude-code-desktop.md:15`; spec-344 log:76). Each started session gets its own worktree (`start_session`'s `use_worktree`, **tool description**), and each Live Session has the app's built-in browser (`.claude/skills/manual-qa/SKILL.md:119`).
- **Evidence it is consent, not a workaround:** the tool's `user_asked` is "told you to start this piece". The map's standing rule is that whatever the human hands over is handed over in the Dispatch Plan, before "go" (#396, Notes). A QA row approved at "go" is exactly that.
- **Costs and open points:**
  - The QA brief changes shape. Today `<head>` is in the brief at spawn and phase 1 pins it (`BRIEF.md:20`, `:32`; `SKILL.md:257`). A parked session gets a brief without `<head>`, and the head arrives later as a `message`. The brief would have to say that this message carries the head, and that the session pins it then. "The brief file is the brief as spawned" (spec-253 log:14) would no longer hold for QA.
  - **How many to start.** One per QA row is known at "go". A **void** QA Delegation (a head that moved, as d255-qa at spec-253 log:44) needs a new one: spec-253 started d255-qa2 as a new session on a human turn (log:51). Either a void session is re-pinned by `message` to the new head (untried, **UNCONFIRMED** that the QA skills cope with a second pass in one session), or the Dispatch Plan starts spares, or a void QA falls back to a card.
  - **Idle sessions for hours.** In spec-253, QA for d257 started about a day after "go" (log:96). No source says how long an idle session lasts; a `notify_when_idle` subscription is dropped after 12 hours (`claude-code-desktop.md:35`), but none is needed on a parked session. How long a parked session stays usable is **UNCONFIRMED**.
  - **Permission mode.** Each parked session must start in the Chief of Staff's permission-mode class, or the later `message` is held and dropped (`claude-code-desktop.md:15`). `start_session` takes `permission_mode` (**tool description**), so this is the same rule as building sessions today.
  - **Worktree base.** A session started at "go" is cut from the base branch then. Phase 1 already fetches and detaches at `<head>` (`BRIEF.md:32`), so the base does not matter, but `source_branch` is not kept on cards (`claude-code-desktop.md:14`), which does not arise here since these are not cards.
  - **The QA Stack** has one holder at a time (`SKILL.md:54`). A parked session holds nothing until it gets its head, so parking several does not break that rule, as long as the Chief of Staff messages only one at a time.
  - **Sidebar clutter.** Each parked session shows in the human's sidebar from "go". Small, but the human sees it.
  - **Untried.** No run has started a session for work whose input arrives later.

### B. Run QA as a Claude Code CLI headless run (`executors: { qa: claude-code-cli }`)

The skill already allows it. The desktop harness file says it "may also run the Claude Code CLI's headless runs" (`claude-code-desktop.md:6`, `:28`). The config's `executors.qa` names another harness for QA (`.claude/skills/orchestrate/CONFIG.md:128`; `HARNESSES.md:115-120`), and `config.mjs` accepts `claude-code-cli` there because its **Headless QA** line is `yes` (`.claude/skills/orchestrate/config.mjs:779-783`; `.claude/skills/orchestrate/harnesses/claude-code-cli.md:7`). The run is `claude -p` as a background process in a worktree the Chief of Staff makes (`claude-code-cli.md:14`; `HARNESSES.md:104-111`). A background shell command has no consent rule: the capped CI and review waits are background commands the Chief of Staff starts and re-arms on whatever turn it is in (`claude-code-desktop.md:21`, `:23`; spec-344 log:56).

- **Its own working copy:** yes, the worktree the Chief of Staff makes (`HARNESSES.md:106`).
- **A browser of its own:** `manual-qa`'s first `web` driver is `web.mjs`, its own Playwright driver, run from the shell, when Playwright with Chromium is installed in the repository (`manual-qa/SKILL.md:113`). It opens one isolated browser context per session (`manual-qa/SKILL.md:143`). Without it, a headless run has no browser but one an MCP server gives (`manual-qa/SKILL.md:121`): `claude -p` takes `--mcp-config` (headless docs, "Start faster with bare mode"; `claude --help`), so a Playwright MCP server would do. `claude --help` also lists `--chrome` (Claude in Chrome), but that drives the human's own Chrome. The app's built-in browser belongs to the app's sessions, not to a `-p` run (`manual-qa/SKILL.md:119`). The `api` surface needs no browser (`manual-qa/SKILL.md:115`).
- **Skills in `-p`:** the headless docs say "User-invoked skills and custom commands work. Include `/skill-name` in the prompt string" ("Create a commit", note). That answers the CLI file's check-before-use item (`claude-code-cli.md:30`) from the docs. On the brief route the session reads each `SKILL.md` and invokes nothing (`BRIEF.md:25`), so this matters only on the typed route.
- **Permissions:** since v2.1.302 a `-p` run starts in Manual mode when nothing sets one, and denies whatever needs approval (headless docs, "Auto-approve tools"). It needs `--permission-mode auto` (or a narrower allow list), and `--permission-prompts none` for an unattended run, which also removes `AskUserQuestion` (headless docs, "Turn off permission prompts in unattended runs"). That suits the brief route, where questions go to `decisions.md`. Which mode is the human's, in the Dispatch Plan (`claude-code-cli.md:24`).
- **Waiting on a `-p` run:** its exit is a background command's end, which starts a turn in the Chief of Staff (`claude-code-cli.md:16`). A `-p` run also waits up to 10 minutes for its own background work before stopping it (headless docs, "Background tasks at exit"), so a long `manual-qa` step in the background could be cut off. Every Decision Request ends the run; the answer goes back with `claude -p --resume <session-id>` (`claude-code-cli.md:15`), a new process each time.
- **Costs:**
  - The human cannot open a headless run while it works (`claude-code-cli.md:23`). They read its Activity Log and output.
  - `claude-code-cli` is Support Level `documented` (`claude-code-cli.md:4`), so it lowers the run's level and the Dispatch Plan warns (`HARNESSES.md:81`, `:120`).
  - Its check-before-use items still stand: the permission mode to commit (QA commits nothing, `BRIEF.md:36`, so only the run-folder write matters), and whether a headless run can drive the browser (`claude-code-cli.md:29-31`).
  - The browser depends on the repository: no Playwright in it and no MCP server configured means the `web` surface has no driver, and its scenarios are left for a person (`manual-qa/SKILL.md:121`).
  - The CLI must be installed and signed in (`HARNESSES.md:118`); 2.1.316 is on this machine's `PATH`.
- **A variant: `claude --bg`.** `claude --help` (2.1.316) lists `--bg`, which "Start[s] the session in the background and return[s] immediately", printing an id that `claude attach`, `logs`, `stop` and `rm` take; `claude agents` lists such sessions. The human could attach to watch, which a `-p` run does not allow. `-p` rejects `--bg` (headless docs, "Basic usage"). How the Chief of Staff learns that a `--bg` session ended its turn, and how its report and permission prompts work, is **UNCONFIRMED**: no source read here says.

### C. A sub-agent with its own worktree

The `Agent` tool takes `isolation: "worktree"`, which "gives the agent its own git worktree", and a finished agent can be continued with `SendMessage` "with its context intact" (**tool description**, 2026-11-21). A sub-agent call is not a session start, so the card rule does not apply to it. The sub-agent shares the Chief of Staff's tools, so it could run `web.mjs` from the shell, or use the built-in browser pane.

- **Costs:**
  - The skill forbids it: "A QA Delegation is never a sub-agent, on any harness: QA needs a working copy and a browser of its own" (`HARNESSES.md:136`). `isolation: "worktree"` answers the working copy; the browser does not follow: the built-in browser pane would be the Chief of Staff's own, shared with it. Only `web.mjs` gives the sub-agent a browser of its own.
  - The other half of the reason, "outside an autonomous run, a sub-agent cannot take a user-invoked skill" (`HARNESSES.md:136`), does not bite on the brief route, but does on the typed route and on a `url` target, which stays typed in every run (`BRIEF.md:24`).
  - The human cannot open it to watch or answer there, unlike a Live Session (`HARNESSES.md:89`).
  - Whether a finished sub-agent takes a follow-up message is still a check-before-use item on this harness (`claude-code-desktop.md:47`); spec-253 did not exercise it (log:100). The `Agent` tool description says it can, which is a primary source, but no run has tried it here.
  - It needs an ADR change: HARNESSES.md's rule rests on ADR 0013's reading of a QA Delegation.

### D. A one-time Desktop scheduled task

`create_scheduled_task` with `fireAt` "runs once at the given moment", and `run_scheduled_task` starts a run "as a NEW Claude Code session in the task's working folder" (**tool description**). So the Chief of Staff could make a scheduled task whose prompt is the QA brief, and fire it.

- **Costs:**
  - The tool's own description scopes it to the human's request for something "repeatedly" or "at a specific later time", and `run_scheduled_task` is for when "the user asks to run, trigger, test, or re-run a scheduled task now — not to work around a schedule the user set". Using it to start sessions the app would otherwise hold for a click goes around the consent rule `start_session` enforces, rather than meeting it. This note treats it as a workaround, not a route.
  - It is a persistent change: the task is stored under `~/.claude/scheduled-tasks/` (**tool description**). Persistent changes are the human's, in the Dispatch Plan (`HARNESSES.md:111`).
  - It runs "in the task's working folder", with no worktree option: the session would have to make its own worktree. Its permission mode is the session's own when it was Auto or Bypass, else unclear (**tool description**: "the result says whether it was").
  - Untried in any run.

### E. Ruled out

- **A cloud session** (`start_session` with `target: "cloud"`): cannot reach the run folder or the local QA Stack, and does not tell a local Chief of Staff when it ends (`HARNESSES.md:124`). The tool also says "Only when the user asks for the cloud" (**tool description**).
- **The human's click, kept:** today's route (`claude-code-desktop.md:14`, `:39`). It meets every rule but the map's destination.

## 3. What the other harnesses do

No other harness has a click rule. On each, QA starts from the Chief of Staff's own tools, on any turn:

| Harness           | QA Executor                                                                    | Browser in it                                  | Source                                                       |
| ----------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------ |
| `claude-code-cli` | a headless `claude -p` run, else a session the human starts                    | MCP server or `web.mjs`                        | `harnesses/claude-code-cli.md:7`, `:9`                       |
| `cursor`          | a headless run of the Cursor CLI (`agent -p`), else a session the human starts | built in                                       | `harnesses/cursor.md:7`, `:9`; `manual-qa/SKILL.md:119`      |
| `codex-cli`       | a headless `codex exec` run in a worktree the Chief of Staff makes             | "with a browser MCP server"                    | `harnesses/codex-cli.md:7`, `:9`; `manual-qa/SKILL.md:121`   |
| `copilot-cli`     | a headless `copilot -p` run in its own worktree                                | "with a Playwright MCP server"                 | `harnesses/copilot-cli.md:7`, `:9`                           |
| `opencode`        | a headless `opencode run` in its own worktree                                  | MCP server                                     | `harnesses/opencode.md:7`, `:9`; `manual-qa/SKILL.md:121`    |
| `antigravity`     | a headless `agy -p` run in a worktree the Chief of Staff makes                 | the human's Chrome, after they click **Allow** | `harnesses/antigravity.md:7`, `:9`; `manual-qa/SKILL.md:120` |
| `gemini-cli`      | a session the human starts: "`-p` does not run a skill command"                | n/a                                            | `harnesses/gemini-cli.md:7`, `:9`                            |
| `devin`           | a Desktop session the human starts, "until a run shows `-p` takes a QA skill"  | n/a                                            | `harnesses/devin.md:7`, `:9`                                 |

Two patterns follow. Where a harness has a headless run that can carry QA, QA is that run, with no human step to start it; the price is a run the human cannot watch, and a browser that comes from an MCP server or `web.mjs`. Where it has none (`gemini-cli`, `devin`), QA is a session the human starts, as on desktop today. The desktop harness is the only tier 1 harness whose QA is a Live Session (`claude-code-desktop.md:9`), and the only one with a consent rule on starting it. Option B moves desktop QA to the first pattern; option A keeps it a Live Session and moves the consent to "go".

Note that `gemini-cli` and `devin` give the brief route's reason for their gap (`-p` cannot run a skill command), which the brief route itself removes (`BRIEF.md:25`). That is outside this ticket.

## 4. Summary of the options

| Option                              | Starts without a click | Own working copy        | Own browser           | Human can watch   | Untried or blocked by                                |
| ----------------------------------- | ---------------------- | ----------------------- | --------------------- | ----------------- | ---------------------------------------------------- |
| A. Started at "go", parked          | yes, on "go"'s consent | yes                     | yes, built in         | yes               | QA brief without `<head>`; void re-QA; idle lifetime |
| B. `executors.qa: claude-code-cli`  | yes                    | yes                     | `web.mjs` or MCP only | no (`--bg` maybe) | `documented` level; browser per repo                 |
| C. Sub-agent, `isolation: worktree` | yes                    | yes                     | `web.mjs` only        | no                | HARNESSES.md:136 and ADR 0013                        |
| D. Scheduled task                   | yes                    | no, unless it makes one | yes, built in         | yes               | goes around the consent rule; persistent change      |
| Today: card                         | no                     | yes                     | yes, built in         | yes               | the human's click                                    |

## UNCONFIRMED

- That the turn at spec-344 log:76, on which a `message` was sent, was app-started (read from the log's order).
- How long an idle Live Session stays usable before a `message` can no longer start a turn in it.
- Whether a QA session can be re-pinned to a new head by `message` and run the QA skills a second time cleanly.
- How a `claude --bg` session reports its turn-end to the Chief of Staff, and how it handles permission prompts.
- That a finished sub-agent takes a follow-up `SendMessage` on this harness (the tool description says so; no run has tried it).
- The permission mode a scheduled task's session runs in when the Chief of Staff's is neither Auto nor Bypass.
