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

**Copilot archive**:
An inert, restorable alternative runner for the First-class flows; never live alongside the Claude path.
_Avoid_: Copilot flow, second runner

**Release line**:
The SemVer tag sequence of Agent-kit, versioning every shipped file together.
_Avoid_: channel, track

### Gates and trust

**Kill switch**:
A Consumer-owned control that, when on, makes a First-class flow do nothing.
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

The `qa-plan` and `manual-qa` Portable skills; why they are two skills: [ADR 0003](docs/adr/0003-qa-is-two-skills-joined-by-a-copied-plan-format.md). Each skill's `DESIGN.md` ([`qa-plan`](.claude/skills/qa-plan/DESIGN.md#glossary), [`manual-qa`](.claude/skills/manual-qa/DESIGN.md#glossary)) carries the same definitions, word for word, so the skill keeps them when it is installed alone; `scripts/qa-glossary-contract.test.py` keeps the three the same.

**QA Plan**:
The Markdown file `qa-plan` writes for one pull request at one head, in the format its `ANATOMY.md` gives, carrying only the Residue and runnable from the plan alone.
_Avoid_: test plan, QA checklist

**Residue**:
The manual verification a passing CI run would not establish; the only thing a QA Plan's scenarios cover.
_Avoid_: manual tests, remaining tests

**QA Account**:
A role's sign-in on a test system, with fixed public values derived from tracked source and a reserved-domain email (`*.test`), created by an idempotent seeder that refuses any non-local database. Never copied into a QA Plan.
_Avoid_: test user, demo account

**Scenario account**:
An account a QA Plan's scenario creates during a run, with values the tester chooses then. Never seeded, and never copied into a QA Plan or QA Report.
_Avoid_: created account, temp user, run account

**Session**:
One signed-in identity in a QA Plan's scenario, with cookies and storage no other session shares; a scenario has one or more.
_Avoid_: profile, tab, browser context

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
A screenshot, recording or log captured during a QA run, saved locally by default at each scenario's expected result; private until the person picks it for upload.
_Avoid_: evidence upload, attachment

**QA Report**:
The self-contained Markdown file `manual-qa` writes for one run of one QA Plan: the build it checked, one row per scenario (PASS, FAIL, or left for a person), and the evidence.
_Avoid_: test report, QA results

### Orchestration

The `orchestrate` Portable skill; why it is a core plus a per-repository config: [ADR 0004](docs/adr/0004-orchestrate-is-a-core-plus-a-config.md). The skill's [`DESIGN.md`](.claude/skills/orchestrate/DESIGN.md#glossary) carries the same definitions, word for word, so the skill keeps them when it is installed alone; `scripts/orchestrate-glossary-contract.test.py` keeps the two the same. "Live Session" is always written in full: a **Session** alone is a QA term.

**Chief of Staff**:
The session that runs `orchestrate`: it analyses the work, proposes the Dispatch Plan, hands out each Delegation, relays every Decision Request and verifies every report, and never builds a Delegation's work or merges.
_Avoid_: orchestrator, coordinator, lead agent

**Delegation**:
One piece of a run, an issue to build, an issue to analyse, or a pull request head to QA, handed to one Executor with one brief.
_Avoid_: task, job, ticket (for the piece handed out)

**Executor**:
What carries out a Delegation: a Live Session, a headless run, or a sub-agent in the Chief of Staff's own session.
_Avoid_: worker, runner

**Live Session**:
A separate agent session the human can open, read and talk to while it works; always written in full, because a Session is a signed-in identity in a QA scenario.
_Avoid_: session (alone), live agent

**Brief Contract**:
The eight items every Delegation's brief carries: what to read first, the goal and what done means, phases with explicit stop points, scope fences, the repository's command routes, the rules for writes, the Decision Request form, and the Delegation's report and log files.
_Avoid_: brief template, prompt template

**Decision Request**:
A question a Delegation cannot settle from its brief, raised to the human through the Chief of Staff, self-contained, with options, evidence and a recommendation.
_Avoid_: question, escalation, blocker

**Dispatch Plan**:
The one table the Chief of Staff shows before any Delegation starts, giving each one's scope, Executor, model and wave, with the kinds of routine write the human may approve; one "go" approves it whole.
_Avoid_: run plan, schedule

**Activity Log**:
An append-only record of what was done in a run and why, kept by the Chief of Staff and by each Delegation in the run folder.
_Avoid_: transcript, journal

**Run Summary**:
The account of a finished run, offered after the human merges, for the issue that groups the run's work.
_Avoid_: wrap-up, final report

**Ready to Merge**:
A Delegation whose CI is green, whose review is settled, whose QA requirement is met on its current head and whose branch merges cleanly; the only Delegations the closing list names.
_Avoid_: done, mergeable, green
