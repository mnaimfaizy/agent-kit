# Orchestrate

This guide covers `orchestrate`, a Portable skill that runs a set of issues, or a whole spec, through other agent sessions. Invoking it makes your current session the **Chief of Staff**. The Chief of Staff analyses the work and shows you one **Dispatch Plan**. After your "go", it hands each piece of work, a **Delegation**, to an **Executor**: a separate Live Session, a headless run, or a sub-agent. While the run goes on, it relays every **Decision Request** to you, keeps a board, and checks every report against git, the tracker and CI. At the end it gives you the **Ready to Merge** list and a merge order. The terms in **bold** are defined in the Orchestration section of [GLOSSARY.md](../GLOSSARY.md#orchestration). Why the skill is a core plus a config: [ADR 0004](adr/0004-orchestrate-is-a-core-plus-a-config.md).

The skill's own files are the reference; this page is the walkthrough:

- [`SKILL.md`](../.claude/skills/orchestrate/SKILL.md): the invocations, the rules and the ten workflow steps.
- [`SPEC.md`](../.claude/skills/orchestrate/SPEC.md): spec mode and the two landings.
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
- relay every question to you whole. A Delegation may push its own branch, open its own pull request and reply on its own review; every other write in your name (an issue comment, a new issue, a label, closing an issue) comes to you as a draft for your yes, unless you approved that kind of routine write in the Dispatch Plan;
- tell you only what it has checked: a report is a claim, and each line is checked against the branch, the pull request, CI and the config's re-gate commands;
- nudge a stalled Delegation once, then raise it to you; keep a crashed Delegation's branch and worktree as its handoff;
- find conflicts between finished branches with `git merge-tree` before it gives you a merge order;
- where the config requires QA, hand each finished head to a **QA Delegation** of its own, which runs the [`qa-plan` and `manual-qa`](qa.md) skills on that head, and treat the result as part of Ready to Merge. A push after QA, a review fix included, voids the result, and the new head is QA'd again;
- hold every change on a branch to its scope fence, fixes a reviewer, CI or an automated fixer prompts included: a change outside it is a Decision Request first, and step 7 checks the diff against the fence.

It does not:

- **merge.** The close-out prints the merge order, and the merge command for each pull request when the config names one. It never runs it. You merge.
- **invoke the QA skills itself.** `qa-plan` and `manual-qa` are invoked only by a person. A QA Delegation's session is sent each one as a message where the harness runs that as your invocation, and otherwise you type it there; the Dispatch Plan says which up front. Delivering a QA Plan is always a question for you, with the draft; posting the QA Report is a routine write you may approve for the run.
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
- **a harness that can start other agents**: one with Live Sessions (the Claude Code desktop app) or headless runs (the Claude Code CLI). On a harness that can start neither, the skill writes each brief for you to start by hand, one building Delegation at a time ([HARNESSES.md](../.claude/skills/orchestrate/HARNESSES.md#tier-3-harnesses-that-run-sequentially));
- **issues labelled with the five triage roles** (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), or your own labels mapped to them in the config;
- **a config** at the repository root, or your answers in chat on the first run ([The config](#the-config)).

Any Companion skill the config names (to implement, to triage, to review) must be installed on the harness the Executors run on. The skill is invoked by you, never by the model on its own.

## Invocations

Every form runs from the root of the repository the issues belong to.

| Invocation                      | What it does                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/orchestrate #12 #34`          | A run for these issues. The skill reads the config, analyses each issue, shows the Dispatch Plan, and waits for your "go".                                 |
| `/orchestrate #12 #34 go`       | The same, but the run starts as soon as the plan is shown, unless analysis raised a Decision Request: then it waits for the answer and your "go".          |
| `/orchestrate --spec 50 [go]`   | A run for the spec `#50` and the work it holds, in dependency order ([Spec mode](#spec-mode)). `--spec` takes one issue number and nothing else but `go`.  |
| `/orchestrate --status [<run>]` | Prints the board of the run named, or of the latest run, with each open Decision Request in full. It reads nothing else and changes nothing.               |
| `/orchestrate --resume <run>`   | Continues a run from its folder, after a usage limit, a closed laptop or a pause for merges. It checks every Delegation against git and the tracker first. |

Any other argument, or a mix of these forms, stops the run before anything is read, with the list of forms this version knows. `<run>` is the run folder's name, such as `2026-11-13-12-34` or `2026-11-13-spec-50` ([Run state](#run-state)).

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
10. **Close out.** It prints the Ready to Merge list, the merge order, the merge commands when the config names one, and what is not on the list and why. After you say you have merged, it offers a **Run Summary** on the umbrella issue the run's issues share, if they share one, posted only on your yes, and offers to resume the run if Delegations are parked behind the merges.

A Delegation is Ready to Merge only when every check on its head has passed, its review is settled, its QA requirement is met on its current head and its branch merges cleanly.

## QA

With `ready_to_merge.qa: report` (for every issue, or only those carrying one of `qa_labels`), each building Delegation gets a QA Delegation, `d<issue>-qa`, listed in the Dispatch Plan with its Executor and model (`models.qa`). It starts only when its building Delegation is verified: CI green, review settled, and a clean merge in the proposed order. It tests that one head:

1. It detaches its own working copy at that head, and stops if the pull request's head is anything else.
2. It composes a QA Plan with `qa-plan`, which is sent to its session as a message once the head is pinned, or typed there by you if the session cannot run it. The draft comes to you as a Decision Request, with its scenarios and where it would be delivered, and is delivered only on your yes. If you are in the QA session and answer `qa-plan` there, that is your answer.
3. It runs the plan with `manual-qa`. A QA Delegation against a local QA Stack holds it, so two never run at once, whatever `limits.shared` says. A building Delegation whose tests use the same ports needs those ports named in `limits.shared`.
4. It copies the QA Plan and QA Report into the run folder, and posts the report only if you approved that kind of write in the plan.

The Chief of Staff checks the plan's Head and the report's rows against the pull request. If every scenario passed, the building Delegation is Ready to Merge. Scenarios _left for a person_ come to you in one Decision Request, to run or waive. A FAIL comes to you with its evidence and three options: send it back (recommended), run QA again, or accept it. A push to the branch at any point voids the QA (`void` on the board), and the new head gets a new QA Delegation, `d<issue>-qa2`, under the same "go".

When a `qa.config.yml` (or `.yaml`, `.json`) is at the repository root and the config never sets `ready_to_merge.qa`, `config.mjs check` asks for it. With `qa: none` set, it only notes that the run plans no QA.

## The Dispatch Plan

Before any Delegation starts, the skill shows one table, one row per Delegation:

| Column           | What it says                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Issue            | The issue, or for a spec written as phases, the phase.                                                                                                                                                                               |
| Kind             | Building, analysis or QA.                                                                                                                                                                                                            |
| Executor         | A Live Session, a headless run, a sub-agent, or a session you start by hand, chosen from what the harness offers.                                                                                                                    |
| Model            | From the config's `models`, or the harness's default.                                                                                                                                                                                |
| Wave             | When it starts. No two Delegations in a wave overlap, a blocked issue is in a later wave than its blocker, and no wave holds more building Delegations than `limits.building`, or more than one on a harness that runs sequentially. |
| Scope fence      | The paths it may change.                                                                                                                                                                                                             |
| Shared resources | The named resources from `limits.shared` it will hold.                                                                                                                                                                               |

Under the table, it lists:

- the issues with no Delegation, and why (`ready-for-human`, listed for you; `wontfix`, skipped);
- the Decision Requests analysis raised, such as an issue with no triage label or two, or one an open pull request already closes;
- the **kinds of routine write** you may approve for the whole run, such as moving an issue's label from one triage role to another when its Delegation starts. A kind you approve goes ahead and is logged; any other write in your name is raised for a yes each time.

**The landing.** In a spec run, the plan also says how the work lands, with what each choice costs: one integration branch with one pull request at the end, or one pull request per ticket ([Spec mode](#spec-mode)). The config's `spec.landing` sets your repository's default; with `ask`, the default, the plan asks you, and your "go" names the landing. Either way the plan states it and the board records it. A run never changes its landing part way through.

**One "go" approves the whole plan**: every row, and the routine writes you tick. A change to any row is a new plan, shown again.

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

## Run state

A run keeps its state in a folder of its own inside the config's `run_dir` (default `tmp/orchestrate`). Keep `run_dir` gitignored: nothing in a run folder is committed, because a brief or a log can quote issue text and command output you have not chosen to publish.

```text
<run_dir>/<run>/
  board.md                  the board: one row per Delegation
  activity.md               the Chief of Staff's Activity Log
  answers.json              your answers in chat, when the config did not say
  delegations/<id>/
    brief.md                the brief, as started
    activity.md             the Delegation's Activity Log
    report.md               its latest report
    decisions.md            its Decision Requests, each marked when answered
```

- **`<run>`** is the date and the issue numbers, `2026-11-13-12-34`, or the date and the spec, `2026-11-13-spec-50`, with `.2`, `.3` added for a second run with the same name.
- **A Delegation's `<id>`** is `d<issue>`, such as `d12`. A phase of a spec with no tickets is `d<spec>-p<k>`, a fix on an integration branch is `d<spec>-fix<k>`, and a QA Delegation is `d<issue>-qa`, then `-qa2`, `-qa3`.
- **The board** has one row per Delegation: its issue, kind, Executor, the handle that reaches it, model, wave, branch, pull request, state and open Decision Requests. Its states run from `planned` through `running`, `waiting`, `reported`, `verified` and `ready to merge` to `merged`, with `parked`, `sent back`, `stalled`, `crashed`, `analysed`, `landed` and `dropped` for the other ends, and `passed`, `failed` and `void` for a QA Delegation ([RUN.md](../.claude/skills/orchestrate/RUN.md#states)).
- **Each Activity Log** is append-only: the time, what was done, and why. It is never rewritten.
- **A Delegation works in its own worktree or clone**, and writes its report and Decision Requests by absolute path into the Chief of Staff's run folder. An Executor in a clone that cannot reach the run folder ends its turn with its report or Decision Request as its last message, and the Chief of Staff writes it into the folder.

`--status` prints the board. `--resume <run>` reads the config again, then checks every Delegation not `merged` or `dropped` against git, the tracker, CI and its Executor, updates the board to what it found, starts each parked Delegation whose wait is over, and goes on with the loop.

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
| `limits`         | `building`: the most building Delegations at once (default 3; QA does not count). `shared`: resources one Delegation holds at a time.                                                                                                             |
| `decisions`      | `to`: `pull-request` (default) or `issue-comment`. `marker`: a line each record starts with.                                                                                                                                                      |
| `ready_to_merge` | `review`: `settled` (default) or `approved`. `qa`: `none` (default) or `report` (a QA Delegation per head). `qa_labels`: with `qa: report`, the labels that need one. `review_workflow`: `detect` (default), `none`, or the review Caller's path. |
| `spec`           | `landing`: `ask` (default), `integration-branch` or `per-ticket`. `integration_branch`: the branch name, default `orchestrate/spec-<n>`.                                                                                                          |

A route, command or skill name is free text: the brief carries it as written, so a route can be a command, a skill to use, or a sentence of convention.

**The YAML subset.** The reader takes JSON whole, and YAML only in a subset: block mappings and lists indented with spaces, plain or quoted scalars, flow lists and mappings that open and close on one line, and `#` comments. Every scalar is a string. Tabs, anchors, aliases, multi-line values, a flow collection that spans lines, a ` #` comment inside a flow collection, a `: ` inside an unquoted value, escapes inside quotes, duplicate keys, unknown keys, keys with no value and values of the wrong shape are **problems**: each is named with its line, and the run stops until it is fixed. A typo never becomes a silent default. A formatter can wrap a long flow mapping across lines and out of the subset, so write long entries in block style. In an unquoted value, ` #` starts a comment and the rest of the line is dropped, so quote any route or command that holds ` #` or `: `, as the example does.

**Check it** from the repository root, with the path of the installed skill folder:

```bash
node "<skill>/config.mjs" check
```

It prints JSON: the config's path, its problems, the effective values with every default applied, and its readiness: what the run still **needs** and **notes** it will say. It exits 0 when the config has no problems, 1 when it has any, and 2 when the command or the answers file is wrong (bad usage, or an answers file that is missing, unreadable or outside `run_dir`). `--repo <dir>` checks another repository.

**With no config**, the skill asks in one message for what a run needs (`read_first`, `routes.commit`, `routes.pull_request` and `regate`), plus `ready_to_merge.qa` when a QA config is present and nothing sets it, writes your answers to `answers.json` in the run folder, and checks them with `check --answers <path>`. It offers to write them into a config file, and writes one only on your yes.
