---
name: security-response
description: Run a maintainer's response to private draft security advisories as a Security Response Run, a private local board that tracks and resumes the work; reconcile the run against GitHub and git, prioritize next work, run triage, and coordinate guarded remediation when explicitly authorized.
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
- `triage <target>`: run evidence-first triage for one finding with the `security-finding-triage` skill, and land its outcome on the board ([RUN.md](RUN.md#landing-a-triage-outcome))
- `fix <target>`: only with explicit authorization; implement and validate fix. A row found in triage and confirmed at Medium or above needs a draft advisory first ([RUN.md](RUN.md#found-in-triage))
- `reconcile`: reconcile only ([RUN.md](RUN.md#reconcile)): check the run against GitHub and git, and do nothing else
- `record <what>`: land a human step from a closed set, and verify whatever the run can ([RUN.md](RUN.md#record)); after `record approve`, publish, close or request a CVE for an advisory through `gh api` ([Advisory actions](#advisory-actions))
- `close`: write the findings ledger and close the run (not available yet: say so, and close nothing)

## The run

Every mode starts by opening or resuming the Security Response Run, as [RUN.md](RUN.md#open-resume-or-nothing-to-respond-to) says: an open run is resumed; with none open and draft advisories present, a run is opened; with no drafts and no open run, the skill reports "nothing to respond to" and writes nothing. There are no `open` or `resume` modes.

Reconcile is step one of every mode: once the run is opened or resumed, check it against GitHub and git, as [RUN.md](RUN.md#reconcile) says, before the mode does its own work.

Before the first write of a run, pass the ignore gate in [RUN.md](RUN.md#where-the-run-folder-lives): if `tmp/security-response/` is not ignored, offer the `.gitignore` line and write nothing without a yes.

This skill is the only writer of the run folder. Each change to the board is logged in `activity.md`.

## Advisory actions

The run publishes, closes, or requests a CVE for an advisory only after `record approve` for that action, and only once the advisory passes its gate in [RUN.md](RUN.md#advisory-actions). Each is one `gh api` call, made with the human's own `gh` login (the `repo` scope, or a fine-grained token with "Repository security advisories" write); there is no `gh` advisory command:

- Publish: `gh api --method PATCH repos/<owner>/<repo>/security-advisories/<GHSA-id> -f state=published`
- Close: `gh api --method PATCH repos/<owner>/<repo>/security-advisories/<GHSA-id> -f state=closed`
- Request a CVE: `gh api --method POST repos/<owner>/<repo>/security-advisories/<GHSA-id>/cve`

After each call, read the advisory back with `gh api repos/<owner>/<repo>/security-advisories/<GHSA-id>`, and move the board only on what it shows.

## Guardrails

- Never expose advisory bodies, exploit steps, or secrets publicly. Nothing in the run folder leaves the machine.
- Prefer `concept-id` over report-local `F<n>` identifiers.
- `status`/`next`/`triage` do not authorize code fixes by default.
- The findings ledger is not edited before close: `triage` lands its outcome on the board, and triage's Proposed ledger row waits in `triage/<concept-id>.md`.
- `fix` still requires safe reproducible evidence before implementation.
- Save each advisory to the run's `originals/` before any PATCH that rewrites it publicly.
- Never publish, close, or request a CVE for an advisory without `record approve` for that action, and never past its gate.

## Flow

1. Open or resume the run ([The run](#the-run)), and check the default branch's tip for the board header.
2. Reconcile the run against GitHub and git ([RUN.md](RUN.md#reconcile)).
3. Prioritize based on evidence, impact, exposure, and blast radius.
4. Triage to confirm or reject before fixing.
5. If authorized and reproducible, implement a minimal root-cause fix and validate it.
6. Update the board, log the change in `activity.md`, and report with public-safe wording.
