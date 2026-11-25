# Agent-kit

A versioned kit of portable agent skills and reusable GitHub Actions flows that Consumer repositories adopt by tag. The Consumer keeps everything product-specific.

## Language

### Parties

**Agent-kit**:
This repository and its tagged releases, adopted as one unit.
_Avoid_: the kit library, framework

**Consumer**:
A repository that adopts Agent-kit by pinning its reusable workflows and copying its skills from the same tag.
_Avoid_: client, user repo, downstream

**Skill installer**:
Someone who installs individual Portable skills without adopting the rest of Agent-kit; not a Consumer.
_Avoid_: skill user, standalone Consumer

**Reference Consumer**:
The Consumer (Issuebridge) whose target state defines what a complete adoption looks like.
_Avoid_: demo repo, sample

**Caller**:
A workflow file in a Consumer that invokes an Agent-kit reusable workflow and owns its triggers, gates, and secrets.
_Avoid_: wrapper, trigger workflow

### What ships

**First-class flow**:
A supported end-to-end automation shipped as reusable workflows plus their prompts and helpers: security audit, or plan → implement → review.
_Avoid_: pipeline (alone), feature

**Agent flow**:
The First-class flow plan → implement → review, behind one master Kill switch. Not the security audit or Review response, though agents run those too.
_Avoid_: pipeline, agent pipeline

**Stage**:
One agent run of a First-class flow with its own harness, model, effort and Kill switch: plan, implement, review, review response, or security audit.
_Avoid_: step, phase, pipeline

**Launcher**:
What starts a Stage on its harness, hands the agent its brief, and collects the result; one Launcher serves every harness, in CI and on a maintainer's machine alike.
_Avoid_: runner, wrapper, action

**Harness adapter**:
What tells the Launcher how to install, start and stop one harness, and which model credential and model API that harness uses; the kit ships one for each harness it supports.
_Avoid_: provider (a provider is the model API), driver (a driver is the sandbox runtime), plugin

**Custom harness**:
A harness the kit ships no Harness adapter for, which a Consumer describes in a file of their own and selects for a Stage by name; it starts at the documented Support Level.
_Avoid_: third-party harness, plugin harness

**Harness image**:
The image the kit publishes for one harness, holding that harness at its pinned version; what the contract tests ran against is what a Stage runs.
_Avoid_: agent image, CLI image, toolbox image

**Sandbox image**:
The image a Stage's sandbox starts from: the kit's own by default, or one a Consumer names to bring their project's toolchain.
_Avoid_: base image, runner image, container image

**Guard**:
An outcome a Stage requires of whatever runs it, stated without naming how it is reached, such as "reads stay in the workspace" or "the agent holds no GitHub write credential"; a harness that cannot reach every Guard a Stage requires is refused for that Stage.
_Avoid_: hook, confinement hook, restriction (a hook, a sandbox or a policy is a way to reach a Guard)

**Stage result**:
What leaves a Stage's sandbox for trusted code to read as data: the one file the agent writes where its brief says and, on a Stage that changes code, its commits; nothing the agent says in its own text is part of it.
_Avoid_: output, final message, response

**Proving run**:
A run of a Stage on a harness whose Support Level is below what the Stage requires, made on purpose to record the evidence that raises the level.
_Avoid_: trial run, test run, override

**Portable skill**:
An agent skill vendored in Agent-kit that a Consumer copies into `.claude/skills/` unchanged, and that a Skill installer may install on its own.
_Avoid_: kit skill, core skill

**User-scope skill**:
A Portable skill that works from a user's own skills directory in any repository.
_Avoid_: global skill

**Repo-scope skill**:
A Portable skill that works only inside a repository holding its supporting files (repository files it cannot do its job without, not optional configuration), so it is installed into that repository and nowhere else.
_Avoid_: local skill, project skill

**Kit-owned path**:
A path a Consumer copies verbatim from one tag and replaces whole on upgrade; the Consumer never edits it.
_Avoid_: vendored files, kit folders

**Explainer Page**:
A self-contained HTML page, produced by the `explainer` Portable skill, that lets a named reader answer one question about a system from the page alone.
_Avoid_: design page, onboarding page

**Upstream Brief**:
A dated, cited report, produced by the `instruction-drift-audit` Portable skill, comparing a repository's own agent instructions to the official upstream documentation for the Ecosystems a human names. The skill's other terms (Ecosystem, Baseline, Horizon, Instruction Claim, Upstream Finding, Evidence, Upstream Opportunity, Incidental Observation) are defined in its [`DESIGN.md`](.claude/skills/instruction-drift-audit/DESIGN.md#glossary).
_Avoid_: upgrade plan, dependency audit

**Companion skill**:
A procedure skill (e.g. `implement`, `tdd`) that Agent-kit relies on but does not vendor; it comes from the **Companion library**.
_Avoid_: dependency skill, bundled skill

**Companion library**:
The external skills repository Companion skills come from; outside the Release line.

**Pattern guide**:
A page under `docs/patterns/` plus a skeleton under `examples/patterns/` describing an agent workflow a Consumer sets up in its own repository; the Consumer copies and edits the skeleton, so it is never a Kit-owned path ([ADR 0012](docs/adr/0012-pattern-guides-are-docs-a-consumer-adapts.md)).
_Avoid_: playbook, template skill

**Copilot archive**:
An inert, restorable alternative runner for the First-class flows; never live alongside the Claude path.
_Avoid_: Copilot flow, second runner

**Release line**:
The SemVer tag sequence of Agent-kit, versioning every shipped file together.
_Avoid_: channel, track

### Gates and trust

**Kill switch**:
A Consumer-owned control that, when on, makes a First-class flow, one Stage of it, or the Factory do nothing; the Factory's drains, starting nothing new while running Stages finish.
_Avoid_: feature flag, toggle

**Allowlist**:
The set of actors a Caller permits to trigger a First-class flow.
_Avoid_: whitelist, permitted users

**Trigger label**:
An issue/PR label that starts one stage of plan → implement → review and is consumed by that run.
_Avoid_: command label, action label

**Verified plan**:
A plan comment authored by the trusted plan job and starting with its marker; the only input implement may act on.
_Avoid_: approved plan, plan comment

**Maintainer brief**:
An issue comment starting with `<!-- agent-kit-brief -->`, written by a login the Caller lists in `trusted_spec_authors`; review's Spec source when the issue has no Verified plan.
_Avoid_: triage comment, spec comment

**Threat pack**:
The Consumer-owned threat model and findings ledger the security audit reads.
_Avoid_: security config, threat files

**Scan recipe**:
The Consumer-owned file that tells a Deep scan how to build, start and seed the repository's own app and what it may probe; it sits beside the Threat pack, not in it.
_Avoid_: deep scan config, sandbox config

**Public-log rule**:
Security finding bodies never appear in Actions logs, artifacts, or public issue/PR text.

**Private delivery**:
Handing security findings only to a draft GitHub Security Advisory (plus optional email).
_Avoid_: report upload, publishing findings

**Deep scan**:
A `security-audit` run that also builds, runs and probes the repository's own code inside a sandbox, to reproduce its findings and find more along the Threat pack's attack paths.
_Avoid_: pen test, dynamic audit, DAST

**Verification run**:
A confirm-only Deep scan, run locally with `agent-kit deep-scan --verify <file> --ref <ref>` on the maintainer's own branch or a reviewed branch of the advisory's private fork, that re-attempts the Reproduction of known findings to check whether a fix holds. The finding file goes into the sandbox with the agent's brief, after the network cut; its report never leaves the machine.
_Avoid_: retest, regression scan

**Reproduction**:
Confirming a security finding by triggering it in a running copy of the code inside a sandbox. It is recorded as an observation, never as a runnable recipe.
_Avoid_: PoC, exploit

**Concept id**:
The kebab-case name of one security finding, used across advisories, the Security Response Run, and the findings ledger. It is provisional until triage, and stable from then on.
_Avoid_: F-number, finding id

**Medium floor**:
The severity below which a confirmed security finding gets hardening rather than an advisory.

**Security Response Run**:
One pass of a maintainer's response to every open draft security advisory, tracked in a private local board with one row per concept id, and closed by writing the findings ledger once every row and every advisory is final.
_Avoid_: security board, advisory run, triage session

### Manual QA

The `qa-plan` and `manual-qa` Portable skills; why they are two skills: [ADR 0003](docs/adr/0003-qa-is-two-skills-joined-by-a-copied-plan-format.md); how an autonomous `orchestrate` run follows them from a brief: [ADR 0032](docs/adr/0032-autonomous-qa-handover-nothing-asked-mid-run.md), which supersedes ADR 0013. Each skill's `DESIGN.md` ([`qa-plan`](.claude/skills/qa-plan/DESIGN.md#glossary), [`manual-qa`](.claude/skills/manual-qa/DESIGN.md#glossary)) carries the same definitions, word for word, so the skill keeps them when it is installed alone; `scripts/qa-glossary-contract.test.py` keeps the three the same.

**QA Plan**:
The Markdown file `qa-plan` writes for one pull request at one head, in the format its `ANATOMY.md` gives, carrying only the Residue and runnable from the plan alone.
_Avoid_: test plan, QA checklist

**Residue**:
The manual verification a passing CI run would not establish; the only thing a QA Plan's scenarios and its Review boxes cover.
_Avoid_: manual tests, remaining tests

**Review box**:
A box in a QA Plan's Sign-off checklist for a promise only reading can check, such as a doc's copy or a static file the app does not serve, naming what to read and what it must say. Never a scenario and never a PASS: a person reads it and ticks it.
_Avoid_: review scenario, doc check

**QA Account**:
A role's sign-in on a test system, with fixed public values derived from tracked source and a reserved-domain email (`*.test`), created by an idempotent seeder that refuses any non-local database. Never copied into a QA Plan.
_Avoid_: test user, demo account

**Scenario account**:
An account a QA Plan's scenario creates during a run, with values the tester chooses then. Never seeded, and never copied into a QA Plan or QA Report.
_Avoid_: created account, temp user, run account

**Fix scenario**:
A QA Plan scenario whose plan gives an **Expected before:** line, the defect the merge-base should show. On a `stack` target it runs Before, at the merge-base, and After, at the head; any other scenario, and every scenario on a `url` target, runs After only.
_Avoid_: bug scenario, regression scenario, fix flag

**Session**:
One signed-in identity in a QA Plan's scenario, with cookies and storage no other session shares; a scenario has one or more.
_Avoid_: profile, tab, browser context

**Cut**:
A step in a multi-session scenario whose Session is not the previous step's; the story moves to that Session there, and it shows that Session's own on-screen result before it moves on.
_Avoid_: handoff, switch, session change

**Scene**:
A run of consecutive steps in one Session, from the scenario's first step or a Cut up to the next Cut; a single-session scenario is one Scene.
_Avoid_: segment, chapter, act

**Title card**:
The full-frame board, one centred sentence from the plan, that opens each Scene in a scenario's MP4 and heads its steps in the Storyboard.
_Avoid_: intro board, slate, caption

**Story**:
A QA Plan scenario's field giving one sentence per Scene, in order and in the product's own words; each sentence opens its Scene on a Title card in the MP4 and heads that Scene's steps in the Storyboard.
_Avoid_: narrative, script, synopsis

**Surface**:
What a scenario drives (`web`, `desktop`, `mobile` or `api`). The Run brief gives the plan's default; a scenario may override it.
_Avoid_: platform, channel

**Driver**:
The tool a run uses to drive a Surface. It can observe some things and not others.
_Avoid_: runner, harness (the agent product the run happens in)

**QA Stack**:
A local copy of the application a tester starts and stops with the repository's `up`, `migrate`, `seed` and `down` commands; teardown touches only what `up` started.
_Avoid_: test environment, local env

**Hazard pack**:
A repository-owned Markdown file naming one area where QA is easily fooled: `when:` globs, a _Rule out first_ list `qa-plan` copies into matching scenarios, and _Capture rules_ `manual-qa` obeys.
_Avoid_: QA gotchas, known issues

**Execution record**:
A QA Plan's last section, empty after compose, where whoever runs the plan records each scenario's result.
_Avoid_: results section, test log

**QA Artifact**:
A capture from a QA run that stands alone: someone holding only the file can tell the scenario, what each side expected, what each side did, and the result. It is saved locally by default, and stays private until the person picks it for upload.
_Avoid_: evidence upload, attachment

**Storyboard**:
The QA Artifact for a scenario with a screen: a band naming the scenario, the result, each side's expected and observed text and the commits, above numbered steps with Before beside After.
_Avoid_: contact sheet, filmstrip, combined image

**QA Report**:
The self-contained Markdown file `manual-qa` writes for one run of one QA Plan: the build it checked, one row per scenario with one of five results (PASS, FAIL: regression, FAIL: pre-existing, Not proven, or left for a person), and the evidence. The pull request gets a short summary of it, with a strict header; the full file stays local.
_Avoid_: test report, QA results

**Place**:
Where a person checks an item left for a person: `local`, `staging` and `production` by default, or the names a repository configures. A Place that holds a merge counts as left for a person in the posted summary; any other is deferred and never holds.
_Avoid_: environment, stage

### Hosted targets

How a `url` QA target names more than one address, and who confirms each: the terms [`manual-qa`](.claude/skills/manual-qa/SKILL.md) and the `orchestrate` Dispatch Plan share. `manual-qa` alone carries them, in its [`DESIGN.md`](.claude/skills/manual-qa/DESIGN.md#glossary), word for word, since it uses them; `scripts/qa-glossary-contract.test.py` keeps the two the same.

**Host candidate**:
A hosted address that a QA config lists under `run.hosts`. No config key confirms a hosted address, so it counts as a host only once the human types it, per host and per run (in chat, or in an approved-QA run's Dispatch Plan), and `adapter.mjs host` gives `hosted`.
_Avoid_: configured host, saved host

**Service**:
A named hosted service of a `url` target, such as `billing`, that has an address of its own; a scenario picks it with **Service:**, and without one it uses the entry for its surface. Not a QA Stack service, which is what `plan.suites[].services` names (a `postgres` a suite runs against).
_Avoid_: backend, microservice, a suite's `services`

### Orchestration

The `orchestrate` Portable skill; why it is a core plus a per-repository config: [ADR 0004](docs/adr/0004-orchestrate-is-a-core-plus-a-config.md). The skill's [`DESIGN.md`](.claude/skills/orchestrate/DESIGN.md#glossary) carries the same definitions, word for word, so the skill keeps them when it is installed alone; `scripts/orchestrate-glossary-contract.test.py` keeps the two the same. "Live Session" is always written in full: a **Session** alone is a QA term.

**Chief of Staff**:
The session that runs `orchestrate`: it analyses the work, proposes the Dispatch Plan, hands out each Delegation, relays every Decision Request (or, in an autonomous run, makes a Ruling on those it may) and verifies every report, and never builds a Delegation's work or merges.
_Avoid_: orchestrator, coordinator, lead agent

**Delegation**:
One piece of a run, an issue to build, an issue to analyse, or a pull request head to QA, handed to one Executor with one brief.
_Avoid_: task, job, ticket (for the piece handed out)

**Executor**:
What carries out a Delegation: a Live Session, a headless run, or a sub-agent in the Chief of Staff's own session.
_Avoid_: worker, runner

**Harness**:
The agent product an agent run happens in (Claude Code desktop, Claude Code CLI, Cursor, Codex CLI, Gemini CLI and the like), which decides how a run starts without a human, what it may touch, and how one session can start, message and wait for another; two versions of one product that behave differently are two harnesses.
_Avoid_: tool, IDE, client, platform

**Support Level**:
How far `orchestrate` has been proven on a harness or a tracker: verified (a full run passed), tried (a run happened, with known gaps) or documented (built from its documentation alone). A Stage's level belongs to the harness and Stage pair, so one harness holds a different level for each Stage.
_Avoid_: compatibility, maturity, tier (a tier is what the harness can do)

**Live Session**:
A separate agent session the human can open, read and talk to while it works; always written in full, because a Session is a signed-in identity in a QA scenario.
_Avoid_: session (alone), live agent

**Brief Contract**:
The eight items every Delegation's brief carries: what to read first, the goal and what done means, phases with explicit stop points, scope fences, the repository's command routes, the rules for writes, the Decision Request form, and the Delegation's report and log files.
_Avoid_: brief template, prompt template

**Decision Request**:
A question a Delegation, or a Factory task, cannot settle from its brief, raised to the human (through the Chief of Staff, or on the issue with `factory:needs-decision`) or, in an autonomous run, answered by a Ruling; self-contained, with options, evidence and a recommendation.
_Avoid_: question, escalation, blocker

**Ruling**:
A Decision Request the Chief of Staff answers itself in an autonomous run, because the human handed it that kind at "go" and the evidence it cites picks one option; it stands until the Ruling Review.
_Avoid_: auto-decision, CoS decision, judgement

**Ruling Ledger**:
The ordered list of every Ruling in a run, each with its question, options, choice and evidence, kept in the run folder for the Ruling Review.
_Avoid_: decision log, audit log

**Ruling Review**:
The human's pass over a run's Ruling Ledger, in which each Ruling ends upheld or overturned; overturning one sends every Ruling that cited it back for review.
_Avoid_: sign-off, approval

**QA held for you**:
In an approved-QA run, the list, right after the Ruling Review, of the QA questions the human keeps, each with its row, evidence and options; not Rulings, so outside the Ruling Ledger, and a row is Ready to Merge once they are answered.
_Avoid_: QA queue, held Rulings

**Parked QA session**:
In an approved-QA run on Claude Code desktop, a Live Session for QA started at the `go` turn on a brief with no head yet; it idles until the Chief of Staff messages it the head, and runs a re-QA in the same session.
_Avoid_: idle session, standby session

**Dispatch Plan**:
The one table the Chief of Staff shows before any Delegation starts, giving each one's scope, Executor, model and wave, with the kinds of routine write the human may approve; one "go" approves it whole.
_Avoid_: run plan, schedule

**Activity Log**:
An append-only record of what was done in a run and why, kept by the Chief of Staff and by each Delegation in the run folder.
_Avoid_: transcript, journal

**Heartbeat**:
A check on every Delegation the run waits on that comes again at a set interval, whatever happened since the last one, so that a run never waits on one signal alone.
_Avoid_: poll, timer, cron job

**Foreground watch**:
The Heartbeat on a harness with nothing to schedule it: the Chief of Staff keeps its turn open, waiting for a change in any Delegation or for a time cap, then waits again.
_Avoid_: poll loop, busy wait, sleep loop

**Run Summary**:
The account of a finished run, offered after the human merges, for the issue that groups the run's work.
_Avoid_: wrap-up, final report

**Run Record**:
The structured, machine-readable account of one run (an `orchestrate` run, or one Stage run of a Factory task, on either Factory engine), written at close-out and holding only fields that are safe to publish (counts, ids, durations, outcomes, and each human intervention with its kind), never quoted issue text or command output; what a Consumer may keep or upload once the raw run folder is gone.
_Avoid_: run metadata, telemetry, run log

**Run Event**:
One timestamped, structured entry for a single step of a run (a spawn, a human step, a land, a review, a CI result), written as it happens by whoever did it; the Run Record is derived from a run's Run Events.
_Avoid_: log line, trace span

**Sink**:
A store off the machine that a Consumer has configured to receive Run Records, or opted-in raw run folders; one Sink may serve many repositories, each writing only into its own namespace.
_Avoid_: backend, destination, remote

**Ready to Merge**:
A Delegation whose CI is green, whose review is settled, whose QA requirement is met on its current head, whose Rulings are upheld, and whose branch merges cleanly into the default branch as it now is, and is not behind it where the repository requires branches to be up to date, unless the human chose to merge it as it is; the only Delegations the closing list names.
_Avoid_: done, mergeable, green

**Team Run**:
A spec run started with `--team`, in which each teammate runs their own Chief of Staff over the spec's tickets assigned to them alone, beside the others, and every one of them reads one Shared Board.
_Avoid_: team mode, shared run, joining a run

**Shared Board**:
The board of a Team Run on the issue tracker: one row comment on each spec ticket, written only by its current assignee's Chief of Staff, and one state label mirroring its state; a published projection of each teammate's own run folder, never a store.
_Avoid_: team board, shared run folder

### Factory

Turning labelled issues into merge-ready pull requests with no human typing code, while humans keep risky merges and releases. Being charted; the terms below are settled, the design is not.

**Factory**:
The whole system that moves an issue from ready for an agent to merged: its lifecycle labels on the tracker, its Run Records, and its merge gate, whichever Factory engine does the work.
_Avoid_: pipeline, software factory (as a name for one flow)

**Factory engine**:
What does the factory's work in one repository: the Workflow engine or the Orchestrate engine. Named for what it runs on, not where it runs.
_Avoid_: runtime, backend, self-hosted mode

**Workflow engine**:
The Factory engine built from the kit's reusable workflows, on GitHub-hosted or self-hosted runners alike.
_Avoid_: CI mode, Actions engine

**Orchestrate engine**:
The Factory engine that runs `orchestrate` from a long-running process on the user's own machine, on their own harnesses and model keys.
_Avoid_: self-hosted engine, local factory, orchestrator

**Dispatcher**:
The deterministic loop inside a Factory engine that claims, locks, retries and caps the factory's work; it judges nothing, and leaves judgement to the agents it starts.
_Avoid_: orchestrator, scheduler, Chief of Staff

**Factory state**:
The one `factory:*` label a Factory task's issue carries at a time, naming where the task stands: queued, planning, planned, building, reviewing, checking, ready to merge, merged, or needs decision.
_Avoid_: status, stage (a Stage is a run, not a state)

**Human move**:
One of the few Factory state changes a person with write access may make by hand: enter a task, pause or unpause it, send it to needs decision, re-queue it once answered, restart it, or withdraw it; the Dispatcher reverts any other hand-made change.
_Avoid_: override, manual transition

**Claim**:
A Dispatcher's hold on a Factory task while an agent works on it: a lock comment naming the engine, Stage, Attempt and expiry, read back after writing, plus an assignee where the engine runs as a person; never a state of its own.
_Avoid_: lock state, reservation

**Attempt**:
One try at a Factory task that ends in a failure the Dispatcher counts (a failed build, changes requested, a failed check, an expired Claim); a set number of them sends the task to needs decision.
_Avoid_: retry, run

**Plan header**:
The machine-readable part of a Verified plan, checked by a trusted step before it is posted: the Risk tier, the Allowed paths, the test plan, and any questions or split.
_Avoid_: plan metadata, front matter

**Risk tier**:
How risky a Factory task's change is, `low`, `medium` or `high`: the higher of the planner's proposal and what the risk rules give for its paths, and only ever raised later.
_Avoid_: risk level, severity

**Merge gate**:
The part of the Factory that decides, for a task's exact pull request head, whether it merges by itself or waits for a person; it can only hold on a judgment, never merge on one, and it merges nothing while its mode is `off` or `shadow`.
_Avoid_: auto-merger, merge bot, merge queue (a queue is GitHub's own feature)

**Guarded path**:
A path whose change no Factory task may auto-merge, judged against the base branch's copy: the gate's own mode, the risk rules, the factory config and the workflows.
_Avoid_: protected path, locked file

**Allowed paths**:
The paths a Factory task's build may change, named in its Plan header; on the Orchestrate engine they are the building Delegation's scope fence, word for word.
_Avoid_: touch list, file list

**Stage check**:
The `pass` or `fail` one Stage (review, QA or security) records on one head commit of a Factory task's pull request, written by a trusted step and read by the merge gate; a new head starts with none.
_Avoid_: verdict (a Verdict answers one review thread), gate result, approval

**Snapshot**:
The GitHub reads an Orchestrate engine writes into an agent's sandbox, refreshed every sweep, so the agent learns what the tracker says without holding a GitHub credential.
_Avoid_: mirror, cache, context dump

**Outbox**:
Where an agent on the Orchestrate engine asks the engine for a GitHub write or a new Delegation; the engine checks each request before it acts, and refuses any it does not allow.
_Avoid_: mailbox, bridge, broker

**Factory mode**:
`orchestrate` as the Orchestrate engine runs it, one Chief of Staff per build Stage run with nobody in chat: always autonomous, its Rulings checked by the review Stage, and any question it does not rule on ending the Stage as a Decision Request on the issue.
_Avoid_: headless orchestrate, unattended mode

**Engine lease**:
The one running Orchestrate engine's hold on a repository, renewed every sweep, so a second engine finds it and refuses to start.
_Avoid_: engine lock, heartbeat

**Factory control issue**:
The one pinned issue per Factory repository that holds what belongs to the whole Factory rather than to a task: the Engine lease, the merge gate's trip marker, and the daily cap's notices.
_Avoid_: control panel, status issue, dashboard issue

**Factory blueprint**:
The files a Consumer copies once from Agent-kit to set up a Factory and owns from then on: the factory config, the risk rules, the Callers, the code-owner lines and the ruleset; never a Kit-owned path.
_Avoid_: factory template, starter kit, scaffold

**Task size**:
How much work a Factory task's build is expected to take, `s`, `m` or `l`, proposed by the planner in the Plan header; it picks the build's token cap, and only a person raises it.
_Avoid_: estimate, effort (Effort is a model setting), complexity

**Daily cap**:
The most tokens a Factory may spend in one repository in one UTC day, counting what finished runs spent and the full cap of every run still going; reaching it starts nothing new until midnight.
_Avoid_: budget, spend cap, quota

**Rollout phase**:
One step on a Consumer's supervised path from an installed Factory to one that auto-merges a Risk tier, each step entered by a person only once the measured bar of the step before it is met.
_Avoid_: stage (a Stage is one agent run), level, autonomy level

### Review response

The `address-pr-review` Portable skill, which answers the code review on a pull request. Its [`DESIGN.md`](.claude/skills/address-pr-review/DESIGN.md#glossary) carries the same definitions, so the skill keeps them when it is installed alone. **Handoff** names the Auto mode that the Review response First-class flow adds; the skill alone has none.

**Review responder**:
The agent addressing a review.
_Avoid_: fixer, review bot

**Finding**:
One unresolved review thread a configured reviewer started. Written alone, **Finding** means this; a security finding (the Threat pack's) and an **Upstream Finding** keep their qualifiers.
_Avoid_: comment, issue (for a review point), review finding

**Review report**:
The one comment on a pull request that indexes the reviewer's Findings, one entry per thread, under the three axes. It holds no finding of its own. Where the reviewer hands back a Stage result, the report is written from it, not by the reviewer.
_Avoid_: review summary, summary findings

**Work list**:
The findings one round is given.
_Avoid_: backlog, queue

**Verdict**:
`fixed`, `addressed` or `declined`.
_Avoid_: status, outcome

**Response round**:
One run, local or CI.
_Avoid_: pass, iteration

**Handoff**:
Auto mode: a finished review starting a round.
_Avoid_: trigger, chain

**Maintainer guidance**:
A trusted person's reply on a finding's thread, passed to the next round.
_Avoid_: instructions, feedback

### Docs gate

**Doc fact**:
A fact that has one source in Agent-kit's code or config and also appears in its docs, such as a variable name, a protected path, an agent's tool limits or a Trigger label.
_Avoid_: doc constant, shared fact

**Generated block**:
A marked part of a doc page whose text is written from a Doc fact's source and checked in CI, while the prose around it stays hand-written.
_Avoid_: snippet, include, autogen section

**Deprecation register**:
The one record of each removed or renamed name, its replacement, the release it changed in, and where the old name may still appear.
_Avoid_: rename map, removed-names list

**Docs map**:
A repository's list that pairs areas of its code with the doc pages that describe them, read by the review to find pages a change may leave stale.
_Avoid_: doc index, sitemap

**Docs-impact finding**:
A review finding that names a doc page still describing what the change under review added, renamed, changed or removed.
_Avoid_: stale-doc warning, docs drift
