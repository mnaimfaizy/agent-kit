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
One agent run of a First-class flow with its own model, effort and Kill switch: plan, implement, review, review response, or security audit.
_Avoid_: step, phase, pipeline

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
A Consumer-owned control that, when on, makes a First-class flow or one Stage of it do nothing.
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

**Public-log rule**:
Security finding bodies never appear in Actions logs, artifacts, or public issue/PR text.

**Private delivery**:
Handing security findings only to a draft GitHub Security Advisory (plus optional email).
_Avoid_: report upload, publishing findings

### Manual QA

The `qa-plan` and `manual-qa` Portable skills; why they are two skills: [ADR 0003](docs/adr/0003-qa-is-two-skills-joined-by-a-copied-plan-format.md); how an autonomous `orchestrate` run follows them from a brief: [ADR 0013](docs/adr/0013-in-an-autonomous-orchestrate-run-the-qa-skills-run-from-the-brief.md). Each skill's `DESIGN.md` ([`qa-plan`](.claude/skills/qa-plan/DESIGN.md#glossary), [`manual-qa`](.claude/skills/manual-qa/DESIGN.md#glossary)) carries the same definitions, word for word, so the skill keeps them when it is installed alone; `scripts/qa-glossary-contract.test.py` keeps the three the same.

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

**Surface**:
What a scenario drives (`web`, `desktop`, `mobile` or `api`). The Run brief gives the plan's default; a scenario may override it.
_Avoid_: platform, channel

**Driver**:
The tool a run uses to drive a Surface. It can observe some things and not others.
_Avoid_: runner, harness

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
The self-contained Markdown file `manual-qa` writes for one run of one QA Plan: the build it checked, one row per scenario with one of five results (PASS, FAIL: regression, FAIL: pre-existing, Not proven, or left for a person), and the evidence.
_Avoid_: test report, QA results

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
The agent product a session runs in (Claude Code desktop, Claude Code CLI, Cursor, Codex CLI and the like), which decides how one session can start, message and wait for another; two versions of one product that behave differently are two harnesses.
_Avoid_: tool, IDE, client, platform

**Support Level**:
How far `orchestrate` has been proven on a harness: verified (a full run passed), tried (a run happened, with known gaps) or documented (built from the harness's documentation alone).
_Avoid_: compatibility, maturity, tier (a tier is what the harness can do)

**Live Session**:
A separate agent session the human can open, read and talk to while it works; always written in full, because a Session is a signed-in identity in a QA scenario.
_Avoid_: session (alone), live agent

**Brief Contract**:
The eight items every Delegation's brief carries: what to read first, the goal and what done means, phases with explicit stop points, scope fences, the repository's command routes, the rules for writes, the Decision Request form, and the Delegation's report and log files.
_Avoid_: brief template, prompt template

**Decision Request**:
A question a Delegation cannot settle from its brief, raised to the human through the Chief of Staff (or, in an autonomous run, answered by a Ruling), self-contained, with options, evidence and a recommendation.
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

**Ready to Merge**:
A Delegation whose CI is green, whose review is settled, whose QA requirement is met on its current head, whose Rulings are upheld, and whose branch merges cleanly into the default branch as it now is, and is not behind it where the repository requires branches to be up to date, unless the human chose to merge it as it is; the only Delegations the closing list names.
_Avoid_: done, mergeable, green

**Team Run**:
A spec run started with `--team`, in which each teammate runs their own Chief of Staff over the spec's tickets assigned to them alone, beside the others, and every one of them reads one Shared Board.
_Avoid_: team mode, shared run, joining a run

**Shared Board**:
The board of a Team Run on the issue tracker: one row comment on each spec ticket, written only by its current assignee's Chief of Staff, and one state label mirroring its state; a published projection of each teammate's own run folder, never a store.
_Avoid_: team board, shared run folder

### Review response

The `address-pr-review` Portable skill, which answers the code review on a pull request. Its [`DESIGN.md`](.claude/skills/address-pr-review/DESIGN.md#glossary) carries the same definitions, so the skill keeps them when it is installed alone. **Handoff** names the Auto mode that the Review response First-class flow adds; the skill alone has none.

**Review responder**:
The agent addressing a review.
_Avoid_: fixer, review bot

**Finding**:
One unresolved review thread a configured reviewer started. Written alone, **Finding** means this; a security finding (the Threat pack's) and an **Upstream Finding** keep their qualifiers.
_Avoid_: comment, issue (for a review point), review finding

**Review report**:
The reviewer's tracking comment on a pull request: an index of its Findings, one entry per thread, under the three axes. It holds no finding of its own.
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
