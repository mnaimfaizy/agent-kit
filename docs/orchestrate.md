# Orchestrate

This guide covers `orchestrate`, a Portable skill that runs a set of issues, or a whole spec, through other agent sessions. Invoking it makes your current session the **Chief of Staff**. The Chief of Staff analyses the work and shows you one **Dispatch Plan**. After your "go", it hands each piece of work, a **Delegation**, to an **Executor**: a separate Live Session, a headless run, or a sub-agent. While the run goes on, it relays every **Decision Request** to you, keeps a board, and checks every report against git, the tracker and CI. At the end it gives you the **Ready to Merge** list and a merge order. The terms in **bold** are defined in the Orchestration section of [GLOSSARY.md](../GLOSSARY.md#orchestration). Why the skill is a core plus a config: [ADR 0004](adr/0004-orchestrate-is-a-core-plus-a-config.md).

The skill's own files are the reference; this page is the walkthrough:

- [`SKILL.md`](../.claude/skills/orchestrate/SKILL.md): the invocations, the rules and the ten workflow steps.
- [`SPEC.md`](../.claude/skills/orchestrate/SPEC.md): spec mode and the two landings.
- [`TEAM.md`](../.claude/skills/orchestrate/TEAM.md): the Team Run, `--spec <n> --team`, and its Dispatch Plan.
- [`TRACKERS.md`](../.claude/skills/orchestrate/TRACKERS.md), [`trackers/github.md`](../.claude/skills/orchestrate/trackers/github.md) and [`trackers/gitlab.md`](../.claude/skills/orchestrate/trackers/gitlab.md): the tracker operations a Team Run reads, and how each is done on GitHub and on GitLab.
- [`BRIEF.md`](../.claude/skills/orchestrate/BRIEF.md): the Brief Contract, the Decision Request form and the report form.
- [`RUN.md`](../.claude/skills/orchestrate/RUN.md): the run folder, the board, the states, `--resume` and `--status`.
- [`HARNESSES.md`](../.claude/skills/orchestrate/HARNESSES.md): how the skill starts, messages and waits for an Executor on each harness.
- [`CONFIG.md`](../.claude/skills/orchestrate/CONFIG.md): every config key and its default.
- [`DESIGN.md`](../.claude/skills/orchestrate/DESIGN.md): the reason behind each rule.
- Template to copy: [`examples/orchestrate.config.yml`](../examples/orchestrate.config.yml).

## What it does and does not do

It does:

- read each issue and place it by its triage role: only a `ready-for-agent` issue gets a building Delegation; `needs-triage` and `needs-info` get an analysis Delegation that produces evidence and options and builds nothing;
- keep two Delegations that touch the same files, or hold the same named shared resource, out of the same wave, and start a Delegation that waits on another only once that one is merged (or, in a spec run on an integration branch, landed there);
- write each Executor a brief that carries the eight items of the Brief Contract; a building brief ends with a code review of its own diff, fixes for what it found, then the final commit, and an analysis brief stops after its evidence and options;
- relay every question to you whole, or, in an [autonomous run](#autonomous-runs) you start with `go autonomous`, answer the kinds you hand over itself, as Rulings you review before anything is Ready to Merge. A Delegation may push its own branch, open its own pull request and reply on its own review; every other write in your name (an issue comment, a new issue, a label, closing an issue) comes to you as a draft for your yes, unless you approved that kind of routine write in the Dispatch Plan;
- tell you only what it has checked: a report is a claim, and each line is checked against the branch, the pull request, CI and the config's re-gate commands;
- nudge a stalled Delegation once, then raise it to you; keep a crashed Delegation's branch and worktree as its handoff;
- find conflicts between finished branches with `git merge-tree` before it gives you a merge order;
- where the config requires QA, hand each finished head to a **QA Delegation** of its own, which runs the [`qa-plan` and `manual-qa`](qa.md) skills on that head, and treat the result as part of Ready to Merge. A push after QA, a review fix included, voids the result, and the new head is QA'd again;
- hold every change on a branch to its scope fence, fixes a reviewer, CI or an automated fixer prompts included: a change outside it is a Decision Request first, and step 7 checks the diff against the fence.

It does not:

- **merge.** The close-out prints the merge order, and the merge command for each pull request when the config names one. It never runs it. You merge.
- **invoke the QA skills itself.** `qa-plan` and `manual-qa` are invoked only by a person. In a run you approve with `go`, a QA Delegation's session is sent each one as a message where the harness runs that as your invocation, and otherwise you type it there, as the exact command the Chief of Staff gives you; the Dispatch Plan says which up front. In an [autonomous run](#autonomous-runs), a QA Delegation on a local QA Stack follows each skill from its brief instead, so you type neither. Delivering a QA Plan is always a question for you, with the draft; posting the QA Report is a routine write you may approve for the run.
- **use the kit's pipeline as an Executor.** The label-driven [plan, implement and review](plan-implement-review.md) flow runs in CI, where the Chief of Staff cannot message it or read its log while it works. The Executors are a Live Session, a headless run and a sub-agent.
- **build.** The Chief of Staff plans, delegates, relays and verifies. It never builds a Delegation's work itself, not even on a harness that cannot start another agent.
- force-push, change repository settings, or destroy a branch, worktree or checkpoint without your yes, one action at a time. The only exception is the detached worktrees it makes for its own checks, which it removes when each check ends.
- work with a tracker other than GitHub: it reads issues and pull requests with `gh`.

## Install

`orchestrate` is User-scope: it works from your own skills directory in any repository. A repository that adopted the kit already has it. Otherwise, install it with the [`npx skills`](install-skills.md) CLI, pinned to a release tag:

```bash
npx skills add mnaimfaizy/agent-kit#<tag> --skill orchestrate -g
```

It needs:

- **Node 22 or later**, for its config reader, `config.mjs`;
- **`git`** and **`gh`**, signed in to GitHub with access to the repository;
- **a harness that can start other agents.** The skill finds the one it runs on at the start of each run, and says how far it has been proven there ([Harnesses](#harnesses)). On a harness that can start none, the skill writes each brief for you to start by hand, one building Delegation at a time ([HARNESSES.md](../.claude/skills/orchestrate/HARNESSES.md#tiers));
- **issues labelled with the five triage roles** (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), or your own labels mapped to them in the config;
- **a config** at the repository root, or your answers in chat on the first run ([The config](#the-config)).

Any Companion skill the config names (to implement, to triage, to review) must be installed on the harness the Executors run on. The skill is invoked by you, never by the model on its own.

## Invocations

Every form runs from the root of the repository the issues belong to.

| Invocation                                        | What it does                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/orchestrate #12 #34`                            | A run for these issues. The skill reads the config, analyses each issue, shows the Dispatch Plan, and waits for your "go".                                                                                                                                                                                                                                                |
| `/orchestrate #12 #34 go`                         | The same, but the run starts as soon as the plan is shown, unless analysis raised a Decision Request: then it waits for the answer and your "go".                                                                                                                                                                                                                         |
| `/orchestrate #12 #34 go autonomous`              | The same as with `go`, with the Dispatch Plan's **Decision authority** line filled in as `autonomous` ([Autonomous runs](#autonomous-runs)). Without `go`, the plan waits for your "go" as usual.                                                                                                                                                                         |
| `/orchestrate --spec 50 [go] [autonomous]`        | A run for the spec `#50` and the work it holds, in dependency order ([Spec mode](#spec-mode)). `--spec` takes one issue number and nothing else but `--team`, `go` and `autonomous`.                                                                                                                                                                                      |
| `/orchestrate --spec 50 --team [go] [autonomous]` | A **Team Run** of the spec `#50`: you build only the spec's tickets assigned to you alone, while each teammate runs their own ([Team Run](#team-run)). `go` and `autonomous` are yours alone.                                                                                                                                                                             |
| `/orchestrate --status [<run>]`                   | Prints the board of the run named, or of the latest run, with each open Decision Request in full. It first runs the default-branch check on each Ready to Merge row, then prints what it finds and writes nothing, so it is safe to run beside a live Chief of Staff session. In a Team Run, it also prints the whole spec ([Watching a Team Run](#watching-a-team-run)). |
| `/orchestrate --status --spec 50`                 | Prints the Shared Board of the Team Run on spec `#50` from the tracker alone, for someone with no run of their own: a reviewer, the spec's owner, a teammate with no tickets ([Watching a Team Run](#watching-a-team-run)). It writes nothing.                                                                                                                            |
| `/orchestrate --resume <run>`                     | Continues a run from its folder, after a usage limit, a closed laptop or a pause for merges. It checks every Delegation against git and the tracker first.                                                                                                                                                                                                                |

`--team` is taken only with `--spec <n>`, once, straight after the number. `--status --spec <n>` takes one issue number and nothing else. `autonomous` is taken once, last, after `go` when both are given, and only in a run for issues or a spec. Any other argument, or a mix of these forms, stops the run before anything is read, with the list of forms this version knows. `<run>` is the run folder's name, such as `2026-11-13-12-34` or `2026-11-13-spec-50` ([Run state](#run-state)).

## Harnesses

The skill has a file for each harness it knows ([`harnesses/`](../.claude/skills/orchestrate/harnesses/)), and at step 1 it finds which one this run is on: from the environment and its own tools, or from the config's `harness` key. When it cannot tell, it asks. Each harness has a **Support Level**:

| Harness                                                                           | Support Level | What that means for a run                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code desktop app                                                           | `verified`    | Runs end to end: Live Sessions for building and QA.                                                                                                                                                                     |
| Cursor                                                                            | `tried`       | One run, with gaps: sub-agents must be checked for their own worktree, and you may type the QA commands, on the typed route.                                                                                            |
| Claude Code CLI, Codex CLI, Copilot CLI, Gemini CLI, Antigravity, Devin, OpenCode | `documented`  | Written from their documentation; no run has tried them. Expect to type the QA commands on the typed route (with `go`, or a `url` target), and to approve copies of the QA skills where some harnesses look for skills. |

Below `verified`, the Dispatch Plan opens with the level and a **Harness limits** list: only the limits that bear on this run, such as "you will type `/qa-plan` in the QA session" or "review comments are watched with `gh`". The plan then waits for your "go", even when you typed `go` with the command. A harness with no file runs one Delegation at a time, with you starting each session.

With `executors` in the config, one kind of Delegation runs on another harness's headless run: for example, from Cursor, `executors: { build: claude-code-cli }` builds with `claude -p`. It is never the default. That CLI must be installed and signed in, and `models` names models on it.

## A run, step by step

1. **Read the config.** The skill runs `config.mjs check`. A problem in the config stops the run until it is fixed. Anything the run needs and the config leaves out is asked for in one message. It checks that `run_dir` is gitignored, and offers to add it to `.gitignore` if it is not. Without your yes, it writes nothing there and stops.
2. **Open the run.** It makes the run folder, the board and its own Activity Log.
3. **Analyse each issue.** It reads the issue, its comments, labels, links and blockers, places it by its triage role, and writes down the paths and shared resources each building Delegation will touch: its scope fence.
4. **Show the Dispatch Plan** and wait for your "go" ([below](#the-dispatch-plan)).
5. **Dispatch a wave.** It writes each Delegation's brief to the run folder and starts its Executor.
6. **Run the loop.** It waits for events: it relays Decision Requests and drafted writes, verifies reports, nudges a stalled Delegation once, and starts the next Delegation when a place in the wave frees up.
7. **Verify each report** against git (branch, head, pushed), the tracker (the pull request targets the default branch and closes the issue), CI (every check on that head passed), the re-gate commands (run in a detached worktree of the branch, never the Delegation's own), review (every comment fixed or answered, and, where the repository runs Agent-kit's review workflow, that review has run on the head: green CI with no comments yet is not a settled review) and the scope fence (every path the branch changes is inside it, or was asked about). A claim that does not hold goes back to the Delegation.
8. **Find conflicts** between finished branches, and between each and the default branch. A pair that conflicts gets a proposed order as a Decision Request: one merges first, and the other's Delegation merges the default branch into its branch afterwards. Never a rebase, which would need a force-push. The merge commit is a new head, so that branch is verified again.
9. **QA each finished head**, where the config requires it ([below](#qa)).
10. **Close out.** Before it lists a row, it runs the **default-branch check**: it reads the pull request's `mergeStateStatus`, test-merges the head against the default branch as it now is, reads `gh pr checks`, and re-gates the merge result when the tip has moved. A row that is `BEHIND`, or whose re-gate fails, comes to you as a Decision Request: merge it as it is with your admin bypass, or have its Delegation merge the default branch in, which makes a new head to verify and QA again. Then it prints the Ready to Merge list, the merge order, the merge commands when the config names one, and what is not on the list and why. With more than one row, the order asks you to merge one at a time, and say "merged <pr>" after each, so it checks the next row against the tip your merge made. The check runs again on `--status`, `--resume` and each "merged <pr>", never on a timer. After you say you have merged, it offers a **Run Summary** on the umbrella issue the run's issues share, if they share one, posted only on your yes, and offers to resume the run if Delegations are parked behind the merges.

A Delegation is Ready to Merge only when every check on its head has passed, its review is settled, its QA requirement is met on its current head, its Rulings are upheld or overturned with their rework verified (in an autonomous run), and its branch merges cleanly into the default branch as it now is, and is not behind it where the repository requires branches to be up to date, unless the human chose to merge it as it is.

### While you are away

The Chief of Staff never waits on one signal alone. Each wait pairs the harness's own event, such as a session ending a turn, with a **heartbeat**: a check that re-arms itself every 10 minutes by default. On each wake-up it checks every Delegation the run is still waiting on, a reported one whose review is queued included: its report, its pull request's checks and the review run, not only the one that woke it, and acts on anything new. A firing with nothing new logs one line and ends. Each report says whether it is final (`**Final:** yes`), and only a final one is verified. So a Delegation that ends a turn before its re-gate finishes, or a wait on CI that times out empty, no longer leaves the run idle.

- **Claude Code (desktop app and CLI):** the heartbeat is a recurring scheduled task in the Chief of Staff's session, armed at the first Delegation and deleted at close-out. The board shows its id, and `--resume` arms it again. Every firing is a short turn on the Chief of Staff's model.
- **Cursor, and the other harnesses with no scheduler:** the Chief of Staff keeps its turn open on a watch that checks every minute, and runs it again every 10 to 15 minutes. Because the turn stays open, a question waits in its session until you stop its turn: stop it to answer a Decision Request or to talk to it mid-run, and it runs the watch again after. On Cursor, the Dispatch Plan may also offer a `stop` hook as a backup, a change to your project settings made only on your yes.
- **A harness with no way to start another agent:** there is no heartbeat. You say when a session has written its report.

Nothing local runs while the computer sleeps. Before leaving a desktop run unattended, turn on **Keep computer awake** in the Claude desktop app's **Settings > Desktop app**; a closed lid still sleeps. The Dispatch Plan reminds you.

## QA

With `ready_to_merge.qa: report` (for every issue, or only those carrying one of `qa_labels`), each building Delegation gets a QA Delegation, `d<issue>-qa`, listed in the Dispatch Plan with its Executor and model (`models.qa`). It starts only when its building Delegation is verified: CI green, review settled, and a clean merge in the proposed order. It tests that one head:

1. It detaches its own working copy at that head, and stops if the pull request's head is anything else.
2. It composes a QA Plan with `qa-plan`, which is sent to its session as a message once the head is pinned, or typed there by you if the session cannot run it, as `/qa-plan <n> [--answers <working_dir>/qa-readiness.json]`, with the `--answers` part when the run has an answers file for its base. In an autonomous run on a `stack` target, the session follows `qa-plan` from its brief instead, and nothing is sent or typed. The draft comes to you as a Decision Request, with its scenarios and where it would be delivered, and is delivered only on your yes. If you are in the QA session and answer `qa-plan` there, that is your answer.
3. It runs the plan with `manual-qa`. A QA Delegation against a local QA Stack holds it, so two never run at once, whatever `limits.shared` says. A building Delegation whose tests use the same ports needs those ports named in `limits.shared`.
4. It copies the QA Plan and QA Report into the run folder, and posts the report only if you approved that kind of write in the plan.

The Chief of Staff checks the plan's Head and the report's rows against the pull request. If every scenario passed, the building Delegation is Ready to Merge. Scenarios _left for a person_ come to you in one Decision Request, to run or waive. A FAIL comes to you with its evidence and three options: send it back (recommended), run QA again, or accept it. A push to the branch at any point voids the QA (`void` on the board), and the new head gets a new QA Delegation, `d<issue>-qa2`, under the same "go".

**Readiness, once.** When the run has QA and the QA config is missing or `qa-plan`'s readiness check still needs something (the base ref, the suites), the Dispatch Plan asks you once, beside the "go": the answers, and whether they are for this run only or to save into the config. They go to the run folder as `qa-readiness.json`, and each QA session copies that file into its `working_dir` and gets `qa-plan` with `--answers`, so no QA session asks again. The answers are reused only for a pull request with the same base branch; another base gets asked. They are never a Ruling: only you know them.

When a `qa.config.yml` (or `.yaml`, `.json`) is at the repository root and the config never sets `ready_to_merge.qa`, `config.mjs check` asks for it. With `qa: none` set, it only notes that the run plans no QA.

## The Dispatch Plan

Before any Delegation starts, the skill shows one table, one row per Delegation:

| Column           | What it says                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Issue            | The issue, or for a spec written as phases, the phase.                                                                                                                                                                               |
| Kind             | Building, analysis or QA.                                                                                                                                                                                                            |
| Executor         | A Live Session, a headless run, a sub-agent, or a session you start by hand, chosen from what the harness offers.                                                                                                                    |
| Model            | From the config's `models`, or the harness's default. With `executors` set, the harness it runs on is shown beside it.                                                                                                               |
| Wave             | When it starts. No two Delegations in a wave overlap, a blocked issue is in a later wave than its blocker, and no wave holds more building Delegations than `limits.building`, or more than one on a harness that runs sequentially. |
| Scope fence      | The paths it may change.                                                                                                                                                                                                             |
| Shared resources | The named resources from `limits.shared` it will hold.                                                                                                                                                                               |

Under the table, it lists:

- the issues with no Delegation, and why (`ready-for-human`, listed for you; `wontfix`, skipped);
- the Decision Requests analysis raised, such as an issue with no triage label or two, or one an open pull request already closes;
- the **kinds of routine write** you may approve for the whole run, such as moving an issue's label from one triage role to another when its Delegation starts. A kind you approve goes ahead and is logged; any other write in your name is raised for a yes each time.

**The landing.** In a spec run, the plan also says how the work lands, with what each choice costs: one integration branch with one pull request at the end, or one pull request per ticket ([Spec mode](#spec-mode)). The config's `spec.landing` sets your repository's default; with `ask`, the default, the plan asks you, and your "go" names the landing. Either way the plan states it and the board records it. A run never changes its landing part way through.

**Decision authority.** The plan's last line says who answers Decision Requests: `relay` (you, every one) or `autonomous` ([Autonomous runs](#autonomous-runs)), with both halves of the split listed so you see what you would hand over.

**One "go" approves the whole plan**: every row, the routine writes you tick, and the Decision authority line. A change to any row is a new plan, shown again.

## A Decision Request

When a Delegation cannot settle a question from its brief and the documents it read, it stops that line of work and writes a Decision Request. The Chief of Staff relays it to you as written, adding only which Delegation it came from. It is self-contained: you can answer it without opening the Delegation.

```markdown
### Decision Request: Should the export keep the old CSV column order?

**Delegation:** d12, for #12
**Context:** The issue asks for a new `owner` column. Two scripts in the repository parse the export by column position, so adding a column in the middle breaks them. Adding it at the end keeps them working but leaves the columns out of the order the issue's mock-up shows.
**Options:**

1. Add `owner` at the end: the two scripts keep working; the order differs from the mock-up.
2. Add `owner` after `name`, and update both scripts: the order matches the mock-up; the change touches two more files, outside this Delegation's scope fence.

**Recommendation:** 1, because it keeps the change inside the scope fence, and the order can change later with the scripts.
**Evidence:** `scripts/report.py:41` and `scripts/sync.py:88` read columns by index; the mock-up is in the issue body.
**Blocks:** the export change and its tests.
```

When you answer, the Chief of Staff sends the answer to the Delegation and records it where the config's `decisions.to` says: by default, the Delegation adds it to its own pull request's body, so a reviewer can see why the work went that way. The Chief of Staff raises its own questions in the same form: an issue with no triage role, a conflict between finished branches, a stalled or crashed Delegation, a write in your name.

## Autonomous runs

A long run with you away stalls on every question. Most of them the evidence already answers: how to build within a settled issue, which branch merges first, whether a QA FAIL is the change or the stack. In an **autonomous run**, the Chief of Staff answers those itself, as **Rulings**, and you review each one before anything is Ready to Merge. Why: [ADR 0008](adr/0008-orchestrate-may-rule-under-review.md).

**Turning it on.** The Dispatch Plan has a **Decision authority** line: `relay`, where every question comes to you, or `autonomous`. Answer the plan with `go autonomous` to turn it on for this run, or add `autonomous` to the invocation to fill the line in. There is no config key: how far you trust a run is your call each time. On a harness below `verified`, the line reads `autonomous, on a typed go autonomous`, and the plan says that Rulings would be made on a harness whose limits are not fully known. Type `go autonomous` after seeing the plan to run it autonomous; a plain `go` approves the plan as shown with every question relayed to you. Neither shows the plan again.

**What it rules on, and what stays yours.** The split is fixed, all or nothing:

| The Chief of Staff rules on                                                       | You keep                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A building Delegation's question about how to do the work within its issue's goal | Widening a scope fence                                                          |
| A stalled or crashed Delegation: nudge it, or restart it from its branch          | Accepting a QA FAIL, or waiving a manual scenario                               |
| The merge order between conflicting branches                                      | An analysis Delegation's options                                                |
| A QA FAIL: send it back, or run QA again                                          | Any write in your name not approved as routine                                  |
| The delivery of a QA Plan                                                         | Everything under Authority                                                      |
| A QA Plan's subject issue, an `unknown` row, and a test it could add instead      | The QA readiness answers, and a hosted (`url`) QA target's host and role values |

**QA runs from the brief.** In an autonomous run, a QA Delegation on a local QA Stack (`target: stack`) composes, delivers and runs QA from its brief, with no command typed by you: its session reads each QA skill's `SKILL.md` and follows it, and each skill's "Run from an autonomous brief" section says what replaces each place it would wait on you. A test `qa-plan` finds could prove a promise goes back to the building Delegation to add; nothing is uploaded; the report is posted only if you approved that write. A `target: url` QA Delegation stays on the typed route: you confirm the host and give role test values in its session, and until you do it waits, while the rest of the run goes on. Why: [ADR 0032](adr/0032-autonomous-qa-handover-nothing-asked-mid-run.md), which supersedes ADR 0013.

**The evidence bar.** It rules only when its evidence picks one option, and cites it so you can check it after the run: `path:line` at a commit SHA, command output saved in the run folder, a tracker permalink, or an earlier Ruling by its id. When the evidence is split, or an option cannot be undone by a later commit, the question comes to you. A question it may not rule on stops only its own Delegation; the rest of the run goes on, the question waits for you on the board, and the Chief of Staff notifies you where the harness can.

**Where Rulings are kept.** Each Ruling has a run-wide id, `R1`, `R2`, and goes into the run's **Ruling Ledger**, `rulings.md` in the run folder, with its question, options, choice and reason, evidence and the Rulings it cites. It is also recorded where `decisions.to` says, labelled "Chief of Staff ruling, not yet reviewed": by default, a line in the Delegation's pull request body. Each Delegation's report maps its commits to the Rulings they followed, and the Chief of Staff checks that map like every other claim.

**The Ruling Review.** At close-out, each Delegation with a Ruling you have not reviewed is listed as `awaiting Ruling Review`, and the ledger is shown grouped by Delegation, each Ruling with the commits that followed from it. Answer per Ruling, or all at once:

```text
upheld: R1 R2; overturned: R3 → option 2
uphold all
```

You can also answer at any time during the run, in the Chief of Staff's session. `--status` prints the ledger, after the default-branch check, and `--resume` opens with the Rulings still awaiting review. Once every Ruling for a Delegation is upheld, or overturned with its rework verified, and its pull request shows each verdict, it is Ready to Merge, and the merge order is printed.

An overturned Ruling becomes an ordinary answer from you: it goes to the Delegation (or to a new one started from its branch), the rework is a push, and the new head is verified and QA'd again. Every Ruling that cited the overturned one is marked **needs re-review** and comes back to you; it is not overturned with it. The pull request's Ruling line is updated to upheld or overturned, and the Run Summary lists every Ruling with its verdict. In a spec run on an integration branch, the integration branch's pull request waits for the Ruling Review, and an overturn for a ticket that has already landed is fixed by a fix Delegation on that branch.

## Run state

A run keeps its state in a folder of its own inside the config's `run_dir` (default `tmp/orchestrate`). Keep `run_dir` gitignored: nothing in a run folder is committed, because a brief or a log can quote issue text and command output you have not chosen to publish.

```text
<run_dir>/<run>/
  board.md                  the board: one row per Delegation
  activity.md               the Chief of Staff's Activity Log
  answers.json              your answers in chat, when the config did not say
  qa-readiness.json         the QA readiness answers the Dispatch Plan asked for
  qa-readiness-<base>.json  the same, for a pull request with another base
  rulings.md                the Ruling Ledger, in an autonomous run
  evidence/                 command output a Ruling cites
  shared-board/<n>.md       in a Team Run, ticket <n>'s Shared Board row as this run last wrote it
  delegations/<id>/
    brief.md                the brief, as started
    activity.md             the Delegation's Activity Log
    report.md               its latest report
    decisions.md            its Decision Requests, each marked when answered
```

- **`<run>`** is the date and the issue numbers, `2026-11-13-12-34`, or the date and the spec, `2026-11-13-spec-50`, with `.2`, `.3` added for a second run with the same name.
- **A Delegation's `<id>`** is `d<issue>`, such as `d12`. A phase of a spec with no tickets is `d<spec>-p<k>`, a fix on an integration branch is `d<spec>-fix<k>`, and a QA Delegation is `d<issue>-qa`, then `-qa2`, `-qa3`.
- **The board** has one row per Delegation: its issue, kind, Executor, the handle that reaches it, model, wave, branch, pull request, state and open Decision Requests. Its states run from `planned` through `running`, `waiting`, `reported`, `verified` and `ready to merge` to `merged`, with `parked`, `sent back`, `stalled`, `crashed`, `analysed`, `landed`, `awaiting Ruling Review` and `dropped` for the other ends, and `passed`, `failed` and `void` for a QA Delegation ([RUN.md](../.claude/skills/orchestrate/RUN.md#states)).
- **Each Activity Log** is append-only: the time, what was done, and why. It is never rewritten.
- **A Delegation works in its own worktree or clone**, and writes its report and Decision Requests by absolute path into the Chief of Staff's run folder. An Executor in a clone that cannot reach the run folder ends its turn with its report or Decision Request as its last message, and the Chief of Staff writes it into the folder.

`--status` prints the board, and in an autonomous run the Ruling Ledger, after running the default-branch check on each Ready to Merge row; it prints what the check found and writes nothing. `--resume <run>` reads the config again, then checks every Delegation not `merged` or `dropped` against git, the tracker, CI and its Executor, updates the board to what it found, runs the default-branch check on each Ready to Merge row, starts each parked Delegation whose wait is over, and goes on with the loop.

## Spec mode

`/orchestrate --spec <n>` reads the spec issue and decides its shape:

| Shape   | When                                                               | What the run does                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tickets | It has at least one sub-issue.                                     | One Delegation per open ticket, in waves that follow the blocking edges: GitHub's native ones, and a "Blocked by" section in a ticket's body.                                                                                                            |
| Phases  | No sub-issues, and its body is broken into headed phases or steps. | One Delegation per phase, in the order written, if the spec itself is `ready-for-agent`; any other role is a Decision Request to triage it first. Before the plan, it offers to publish the phases as tickets, a write in your name that needs your yes. |
| Neither | No sub-issues and no phases.                                       | No Delegations: one Decision Request to break the spec down, then it stops.                                                                                                                                                                              |

A cycle in the blocking edges, an open blocker outside the spec, an edge to an issue it cannot read, or a blocker that gets no building Delegation is a Decision Request in the plan.

The two landings:

| Landing              | What you get                                                       | What it costs                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration-branch` | One pull request to the default branch, with the whole spec in it. | One large review at the end. No CI runs on a ticket until that pull request opens, so each ticket is checked by the `regate` commands alone: with `regate: []`, nothing checks it. The branch is local; pushing it is your choice. |
| `per-ticket`         | One pull request per ticket, each reviewed and merged on its own.  | You merge between waves: a later wave is parked until its blockers are merged, and you continue with `--resume`. More reviews, each small.                                                                                         |

On an integration branch, the Chief of Staff cuts the branch from the default branch at "go", cuts each ticket's branch from it, and moves it forward by fast-forward only, one verified and re-gated ticket at a time, in plan order. It never checks the branch out. Pushing it, for an Executor that works from a clone or to open the final pull request, is a Decision Request that says the branch becomes public. No pull request or Delegation closes the spec: closing it is offered with the Run Summary, as a write in your name.

## Team Run

When a team splits a spec's tickets between several people, each person can run their own share with `orchestrate`, side by side: a **Team Run**. Nobody's Chief of Staff drives anyone else's machine, and there is nothing to join. A single-person `--spec` run is unchanged, and stays the default: no config key makes a Team Run the default.

To start one:

1. **Break the spec into tickets**, as sub-issues of the spec. A Team Run plans only the Tickets shape, since a ticket's assignee is what says whose run builds it.
2. **Assign each ticket to one person** on the tracker. The assignee is the only sign of ownership, and the Chief of Staff never sets it. A ticket with no assignee, or with two, is run by nobody until it has exactly one.
3. **Each teammate runs** `/orchestrate --spec <n> --team` in their own checkout of the repository, with their own `gh` signed in as themselves (`glab` on GitLab, [below](#on-gitlab)).

The Chief of Staff finds the tracker from the git remote's host (`github.com` or `gitlab.com`), or from the `tracker` key; when the two disagree it asks you. This version has a mapping for GitHub and one for GitLab ([below](#on-gitlab)), both at Support Level `documented`, so the plan says so and waits for your "go".

Your Dispatch Plan then:

- has rows for **your tickets only**, the ones whose only assignee is you;
- lists **Teammates' tickets (not run here)**, each with its assignee and state, and which of yours it blocks; a ticket of yours blocked by a teammate's is parked until that ticket's pull request is merged;
- lists `unassigned` tickets and tickets that **need one assignee**: nobody runs those;
- says **Landing: per-ticket**: a Team Run always lands one pull request per ticket, and a `spec.landing` of `integration-branch` or `ask` is overridden, which the plan states;
- lists the routine write **"Shared Board: row comment and state labels on my assigned tickets"**, for your tickets only, opening with "This repository is **public**: row comments and state labels are readable by anyone." when it is;
- asks once, when any of the six state labels (`team.labels`) are missing from the repository, whether to create them: a write in your name, never routine;
- has its own **Decision authority** line: `go` or `go autonomous` is yours, and each teammate chooses their own.

With no ticket assigned to you alone, the plan says so, shows the lists, and points you to `/orchestrate --status`, or `/orchestrate --status --spec <n>` ([Watching a Team Run](#watching-a-team-run)). Your briefs, Activity Logs, evidence and Ruling Ledger stay in your own run folder: the **Shared Board** on the tracker is a projection of it, carrying only what is written for publication ([ADR 0014](adr/0014-a-team-runs-shared-board-is-one-single-writer-row-per-ticket.md), [ADR 0015](adr/0015-the-shared-board-is-a-published-projection-of-each-local-run-folder.md)).

### The Shared Board

After your "go", each of your tickets carries one **Shared Board row**: a comment your Chief of Staff keeps up to date as the ticket's Delegation moves, plus one state label (`team: planned`, `team: parked`, `team: running`, `team: waiting`, `team: ready to merge` or `team: merged`, from `team.labels`). Anyone who can read the repository sees every ticket's state and assignee in the spec's sub-issue list, and the row on each ticket's page. A row looks like this:

```markdown
**Waiting on @sam to answer 1 question; work on it is paused until then.**

`team: waiting` · waiting

> **Waiting on @sam:** Should the docs-impact finding block the review, or only be listed?

- **Assignee:** @sam
- **Branch:** `claude/issue-257-docs-impact` at `7c74a7f`
- **Pull request:** #270
- **Decision authority:** relay
- **Conflicts with:** #272 (@alex), first merged wins

**Recent activity**

- 11-18 10:01Z stopped on a Decision Request
- 11-18 09:40Z verified
- 11-18 09:15Z reported
- 11-18 09:02Z pull request #270 opened
- 11-18 08:10Z spawned from main@0d176a1

Updated 2026-11-18 10:01Z.

<sub>Maintained by orchestrate for @sam's Team Run. Edits here are overwritten.</sub>

<!-- orchestrate:shared-board-row ticket=257 run=2026-11-18-spec-253 author=@sam -->
```

- **What a row holds:** a one-line headline, the fine state, each open question waiting on you, the branch and its head, the pull request, what a parked ticket waits on, your Decision authority, how many Rulings await your review (in an autonomous run, only while there are any), a conflict with a teammate's open pull request, the last `team.recent_activity` milestones, and when it last changed. A hidden marker names the ticket, your run and you.
- **What it never holds:** the Handle, Executor kind, Model or Wave, or anything copied from a brief, log or evidence file. Each piece is written for publication, and no line starts with `/`.
- **When it is written:** only when it changes, only on your own tickets, and only under the routine write you approved at "go". The label changes only when the coarse state, one of those six, does; the row's fine state is its Delegation's own state on your board, mapped onto the six in [TEAM.md](../.claude/skills/orchestrate/TEAM.md#states-and-labels). If GitHub drops the label change silently, because you have no Triage or Write access, the row comment stays the record.
- **Blocked by a teammate's ticket:** your ticket is `parked`, and its row says on what, until that ticket's pull request is merged.
- **A conflict with a teammate's branch** is shown on the row, not settled: your Chief of Staff rules only on your own branches. The first one merged wins, and the other merges the default branch in and re-gates.
- **Rulings:** in a `go autonomous` run, a Ruling line in a pull request names whose Chief of Staff made it, as in `R2 (@sam's Chief of Staff ruling, not yet reviewed)`. Only you review your own Chief of Staff's Rulings.

People change things mid-run, and a row keeps one writer through it: before every row or label write, your Chief of Staff re-reads the ticket's assignee, and writes only while you are its single assignee. When a ticket of yours is reassigned while its work runs or is parked, it asks you, never rules for you, and stops nothing until you answer: **hand it off**, or **ask for it back** from whoever reassigned it. On a hand-off, its branch is pushed, your row's last milestone says `` handed off to @new at `<branch>@<head>` ``, and the ticket leaves your run; the new assignee's run starts from that branch and writes a new row comment of its own. Readers take the row written by the ticket's current assignee; until there is one, the newest row is shown as **stale**, written by someone who is no longer the assignee. When a row of yours carries another run of yours, a second session or one on another machine, it is never overwritten: you are asked whether to resume that run or take the row over. A person's edit to a row is overwritten on the next write, a deleted row is re-created, and a removed state label comes back with the next state change ([TEAM.md](../.claude/skills/orchestrate/TEAM.md#ownership)).

### Watching a Team Run

`/orchestrate --status` in your Team Run prints your own board as in any run, with each open Decision Request in full and, in an autonomous run, your Ruling Ledger. Then it prints the whole spec from the tracker, as a blocking tree in merge order:

```text
Team Run · spec #253 · github, as @sam · read 2026-11-18 10:05Z · blocking tree, in merge order

Each teammate's last write: @alex 09:50Z, 15m ago (run 2026-11-17-spec-253) · @sam 10:01Z, 4m ago (this run)

#255 merged           @alex          #271   changed 13h ago
 └─ #258 running      @sam           none   changed 7m ago    yours
#256 ready to merge   @alex          #272   changed 15m ago   merging it unparks #259
 └─ #259 parked       @sam           none   changed 35m ago   yours; picked up from @alex at claude/issue-259-stage-variables@3f1e2aa
#257 waiting          @sam           #270   changed 4m ago    yours; 1 question waits on @sam
#260 no row yet       unassigned     none
#261 no row yet       @alex @sam     none                     needs one assignee

Next moves: @alex merges #272 · @sam answers 1 question on #257 · someone assigns #260 · #261 needs one assignee
```

Each ticket sits under the blocker that merges last, so you see who waits on whom. Each line gives its state, assignee, pull request and how long ago its row last changed. Your teammates' rows follow the tree, each as its status card shows it, then the `unassigned` and needs-one-assignee tickets and any hand-off in progress. "Next moves" closes it: who merges, answers, reviews, picks up or assigns next.

`/orchestrate --status --spec <n>` prints the same from the tracker alone, for anyone with read access and no run of their own: a reviewer, the spec's owner, a teammate with no tickets. It needs no run folder and makes none. It has no rows marked yours, no default-branch check and no Ruling Ledger, since those live in each teammate's own run.

Each form writes nothing: no board, row, label or file. Neither says whether a teammate's run is alive: a row's age is only when it last changed, and an old row may be a run waiting on its human as easily as one that has stopped.

### Resuming a Team Run

`/orchestrate --resume <run>` of a Team Run checks every Delegation as any resume does, then brings the run back in line with the Shared Board, since people may have changed the tracker while it was paused. It re-reads the assignee of every ticket in your run and in the spec. A ticket of yours assigned to someone else while you were away is a question to you: hand it off, or ask for it back. A ticket newly assigned to you is never added silently: you see an amended Dispatch Plan for just those tickets, and they join the run only on your "go". A row of yours carrying another run of yours asks whether to resume that run or take the row over, and a row someone deleted is written again with its next change. It fetches and pushes on the remote the board recorded, so a remote you named at the start is not asked again ([RUN.md](../.claude/skills/orchestrate/RUN.md#resuming-a-team-run)).

If your machine is lost, with the run folder on it, start a new Team Run with `/orchestrate --spec <n> --team`. Its plan asks to take your old rows over, one ticket at a time; restarts each unfinished ticket as a new Delegation from its branch head on the remote (a branch never pushed is lost, and starts again from the default branch); and asks you again about every Ruling line on your pull requests that still says `Chief of Staff ruling, not yet reviewed`, since the Ruling Ledger was in the lost folder ([RUN.md](../.claude/skills/orchestrate/RUN.md#after-a-lost-machine)).

### On GitLab

A Team Run works on GitLab Free, on gitlab.com or a self-hosted instance, with no Premium feature. Its commands are in [`trackers/gitlab.md`](../.claude/skills/orchestrate/trackers/gitlab.md), at Support Level `documented`: written from GitLab's documentation, not yet tried in a run. What it needs:

- **`glab` signed in as you**, in place of `gh` for the Shared Board: `glab auth login`, or `glab auth login --hostname <host>` for a self-hosted GitLab. A self-hosted GitLab on its own domain also needs `tracker: gitlab` in the config, since only `gitlab.com` is detected.
- **A role that can set labels.** Writing a row note needs only Guest, but setting a ticket's state label needs Planner or higher (Reporter before GitLab 17.7), and creating the six state labels needs the same. With less, the label write does not hold, and the row note stays the record.
- **The spec's tickets as a task list.** GitLab Free has no sub-issues, so the spec lists its tickets in its description, one task-list item each, starting with the ticket: `- [ ] #<n>`.
- **A `Blocked by:` line.** Blocking links ("is blocked by") are Premium. On Free, put `Blocked by: #<n>, #<n>` at the top of a ticket's description, as its first line that is not blank; on Premium the native links are read too. A blocker counts as cleared only when its merge request is merged, read from the merge requests that close it, never from the issue closing.

Free also has one assignee per issue, so no ticket needs one assignee there, and plain labels only: the Chief of Staff removes a ticket's old state label as it adds the new one. Rows reference a merge request as `!<iid>`, and no row line starts with `/`, which GitLab would run as a quick action. On gitlab.com each user can create 60 notes a minute; a row is created once and then edited only when it changes.

## The config

The repository's facts live in one file at its root: `orchestrate.config.yml`, `orchestrate.config.yaml` or `orchestrate.config.json`, the first one present. The skill names no repository command, skill, label or path; each comes from here. Start from [`examples/orchestrate.config.yml`](../examples/orchestrate.config.yml), which shows every key with a comment; every default and meaning is in [`CONFIG.md`](../.claude/skills/orchestrate/CONFIG.md).

| Key              | What it names                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_dir`        | Where run folders live (default `tmp/orchestrate`). Keep it gitignored.                                                                                                                                                                           |
| `read_first`     | The documents every Delegation reads before it plans. Each must be in the repository; `[]` for none. Asked for when unset.                                                                                                                        |
| `routes`         | `commit` and `pull_request`: how a Delegation commits and opens its pull request, both asked for when unset. `merge`: printed, never run.                                                                                                         |
| `regate`         | The commands that re-check a finished branch. Asked for when unset; `[]` leaves it to CI.                                                                                                                                                         |
| `skills`         | The Companion skills a brief names: `implement`, `triage`, `review`.                                                                                                                                                                              |
| `triage_labels`  | Your labels for the five triage roles: the path of a document that maps them, or a mapping. Unset, each label is the role's name.                                                                                                                 |
| `models`         | The model for `analysis`, `build`, `review` and `qa` work. Unset, the harness's default.                                                                                                                                                          |
| `harness`        | The harness the Chief of Staff runs on, pinned (`claude-code-desktop`, `cursor`, …). Unset, found each run; a disagreement is a question for you.                                                                                                 |
| `executors`      | Not the default: `build`, `analysis` or `qa` work moved onto another harness's headless run.                                                                                                                                                      |
| `limits`         | `building`: the most building Delegations at once (default 3; QA does not count). `shared`: resources one Delegation holds at a time.                                                                                                             |
| `decisions`      | `to`: `pull-request` (default) or `issue-comment`. `marker`: a line each record starts with.                                                                                                                                                      |
| `ready_to_merge` | `review`: `settled` (default) or `approved`. `qa`: `none` (default) or `report` (a QA Delegation per head). `qa_labels`: with `qa: report`, the labels that need one. `review_workflow`: `detect` (default), `none`, or the review Caller's path. |
| `spec`           | `landing`: `ask` (default), `integration-branch` or `per-ticket`. `integration_branch`: the branch name, default `orchestrate/spec-<n>`.                                                                                                          |
| `tracker`        | Read only by a Team Run: `detect` (default, from the git remote's host), `github` or `gitlab`. Pin it for any host but `github.com` or `gitlab.com`.                                                                                              |
| `team`           | Read only by a Team Run. `labels`: the label for each of the six states (default `team: planned` and so on). `recent_activity`: milestones a Shared Board row keeps (default 5).                                                                  |

A route, command or skill name is free text: the brief carries it as written, so a route can be a command, a skill to use, or a sentence of convention.

**The YAML subset.** The reader takes JSON whole, and YAML only in a subset: block mappings and lists indented with spaces, plain or quoted scalars, flow lists and mappings that open and close on one line, and `#` comments. Every scalar is a string. Tabs, anchors, aliases, multi-line values, a flow collection that spans lines, a ` #` comment inside a flow collection, a `: ` inside an unquoted value, escapes inside quotes, duplicate keys, unknown keys, keys with no value and values of the wrong shape are **problems**: each is named with its line, and the run stops until it is fixed. A typo never becomes a silent default. A formatter can wrap a long flow mapping across lines and out of the subset, so write long entries in block style. In an unquoted value, ` #` starts a comment and the rest of the line is dropped, so quote any route or command that holds ` #` or `: `, as the example does.

**Check it** from the repository root, with the path of the installed skill folder:

```bash
node "<skill>/config.mjs" check
```

It prints JSON: the config's path, its problems, the effective values with every default applied, the harness and tracker it finds, and its readiness: what the run still **needs** and **notes** it will say. It exits 0 when the config has no problems, 1 when it has any, and 2 when the command or the answers file is wrong (bad usage, or an answers file that is missing, unreadable or outside `run_dir`). `--repo <dir>` checks another repository.

**With no config**, the skill asks in one message for what a run needs (`read_first`, `routes.commit`, `routes.pull_request` and `regate`), plus `ready_to_merge.qa` when a QA config is present and nothing sets it, writes your answers to `answers.json` in the run folder, and checks them with `check --answers <path>`. It offers to write them into a config file, and writes one only on your yes.
