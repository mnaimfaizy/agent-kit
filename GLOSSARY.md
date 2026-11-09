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
