---
name: security-response
description: Run a maintainer's response to private draft security advisories as a Security Response Run, a private local board that tracks and resumes the work; reconcile findings against current code, prioritize next work, run triage, and coordinate guarded remediation when explicitly authorized.
argument-hint: "status | next | triage <target> | fix <target> | reconcile | record <what> | close"
user-invocable: true
disable-model-invocation: true
metadata:
  agent-kit-scope: user
---

# Security response

Drives the backlog and remediation of security findings as a Security Response Run: one pass of the maintainer's response to every open draft security advisory, kept in a private local board with one row per concept id.

This skill is portable and does not include product-specific playbooks, threat packs, or ledgers. Consumers provide those assets.

Requires the `security-finding-triage` skill, installed alongside this one: `triage` mode runs it.

The run folder, the board and the states: [RUN.md](RUN.md). Load it before any mode.

## Modes

A `<target>` is a concept id or a `GHSA:F<n>`; `fix` also takes `next`.

- `status`: prints the board ([RUN.md](RUN.md#board)) in the local terminal
- `next`: recommend one prioritized next action
- `triage <target>`: run evidence-first triage for one finding with the `security-finding-triage` skill
- `fix <target>`: only with explicit authorization; implement and validate fix
- `reconcile`: refresh stale evidence and state after merges and releases
- `record <what>`: land a human step on the board (not available yet: say so, and record nothing)
- `close`: write the findings ledger and close the run (not available yet: say so, and close nothing)

## The run

Every mode starts by opening or resuming the Security Response Run, as [RUN.md](RUN.md#open-resume-or-nothing-to-respond-to) says: an open run is resumed; with none open and draft advisories present, a run is opened; with no drafts and no open run, the skill reports "nothing to respond to" and writes nothing. There are no `open` or `resume` modes.

Before the first write of a run, pass the ignore gate in [RUN.md](RUN.md#where-the-run-folder-lives): if `tmp/security-response/` is not ignored, offer the `.gitignore` line and write nothing without a yes.

This skill is the only writer of the run folder. Each change to the board is logged in `activity.md`.

## Guardrails

- Never expose advisory bodies, exploit steps, or secrets publicly. Nothing in the run folder leaves the machine.
- Prefer `concept-id` over report-local `F<n>` identifiers.
- `status`/`next`/`triage` do not authorize code fixes by default.
- `fix` still requires safe reproducible evidence before implementation.
- Save each advisory to the run's `originals/` before any PATCH that rewrites it publicly.

## Flow

1. Open or resume the run ([The run](#the-run)), and check the default branch's tip for the board header.
2. Reconcile finding evidence against the current code state.
3. Prioritize based on evidence, impact, exposure, and blast radius.
4. Triage to confirm or reject before fixing.
5. If authorized and reproducible, implement a minimal root-cause fix and validate it.
6. Update the board, log the change in `activity.md`, and report with public-safe wording.
