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
An agent skill vendored in Agent-kit that a Consumer copies into `.claude/skills/` unchanged.
_Avoid_: kit skill, core skill

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

**Threat pack**:
The Consumer-owned threat model and findings ledger the security audit reads.
_Avoid_: security config, threat files

**Public-log rule**:
Security finding bodies never appear in Actions logs, artifacts, or public issue/PR text.

**Private delivery**:
Handing security findings only to a draft GitHub Security Advisory (plus optional email).
_Avoid_: report upload, publishing findings
