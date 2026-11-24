---
status: accepted
supersedes: ADR-0013
---

# In an approved-QA autonomous run, QA asks nothing mid-run: the autonomous-QA handover

This supersedes [ADR 0013](0013-in-an-autonomous-orchestrate-run-the-qa-skills-run-from-the-brief.md). It restates what survives from it, so a reader needs only this one.

A Maintainer approves a `go autonomous` run so it can go on without them, but QA still needed them at every step: typing both QA commands, answering the readiness question, confirming the QA Plan, passing every Review box, answering QA Decision Requests, and clicking a card to start each QA session. ADR 0013 moved the QA skills onto the brief for local-stack targets but kept hosted targets, run needs, Review boxes, scenarios left for a person and every desktop QA start with the human. This decision finishes the handover.

## What survives from ADR 0013

- **The brief route.** `qa-plan` and `manual-qa` stay user-invoked (not model-invocable). In an autonomous run the QA brief carries each skill's instructions, as the CI reviewer's brief carries `code-review`, and the QA session follows `qa-plan` and then `manual-qa` as phases of its brief. Nobody types either command. Outside an autonomous run, a person invokes them.
- **Each QA skill owns its run mapping.** A "Run from an autonomous brief" section in each skill lists every step where it waits on the person and what replaces the wait. Only the skill knows where it waits, so the mapping moves with it. A contract test fails when a step that waits on the person has no row.
- **Readiness is asked in the Dispatch Plan,** once, in every run, never in a QA session and never as a Ruling: readiness answers are facts about the repository. They are reused only within the run and only for a pull request with the base branch they were given for.

## Decision

**QA is approved by a separate yes.** In a `go autonomous` run, the Dispatch Plan asks whether to approve QA whenever the config proposes QA rows, and asks nothing when it proposes none. The Maintainer may strike single rows. The yes is its own answer, not implied by `go autonomous`, so a run can go autonomous without QA. The QA Rulings join the autonomous half of the Decision authority split only when QA is approved. The yes covers re-QA on new heads under the same answers. Plain `go` leaves QA on the typed route.

**"No" means no QA.** Declined QA drops the QA requirement for the run: the affected rows become Ready to Merge without it, the readiness question is not asked, and the board and close-out record that QA was declined in the Dispatch Plan.

**Nothing is asked mid-run.** Once QA is approved, no QA Delegation sets itself waiting on the human. Every question QA would ask goes one of three ways:

- _Asked once in the Dispatch Plan:_ facts only the human knows (readiness answers, the run's needs, hosts and the seeder answer, whether posting is a routine write, the Places, the upload opt-in).
- _Ruled by the Chief of Staff_ under the evidence bar: QA Plan delivery, the subject issue, `unknown` rows, the add-the-test send-back, the surface, and sending back or re-running a FAIL.
- _Held for close-out:_ accepting a FAIL, waiving a scenario, and any Ruling question the evidence does not settle. The row stays short of Ready to Merge, the run goes on, and the held questions are listed right after the Ruling Review, outside the Ruling Ledger because they are not Rulings. A row is Ready to Merge once they are answered.

**Review boxes are ruled on quoted evidence and never ticked by an agent.** A box that asks for literal words is a Ruling: the QA session quotes the file at the pinned head and classifies the box, and the Chief of Staff re-reads the source at that commit before ruling, so the session's quote is never the only evidence. A box that asks for judgment is held for close-out. A box whose words the file lacks is a FAIL and goes back to the building Delegation. The tick stays a person's sign-off, even under a "holds" Ruling.

**Scenarios left for a person are held.** A surface with no driver, a role restore on a hosted target, a run that could not carry a scenario out, and a need that appears only after the plan is composed are held for close-out with their steps. A scenario that can only run after merge is held with the options pass, waive, or run after merge. No agent runs or passes one.

**Hosts are typed in the Dispatch Plan.** Hosted targets become autonomous, but confirming a host stays with a person: the human types each host in their own reply to the Dispatch Plan, where code checks it and only a hosted verdict goes ahead. The host reaches the QA session only through its brief, with a record of where it came from, and the session checks it again before signing in. A typed host is never saved to the config and is deleted at close-out. The config may list candidate hosts, but no config key confirms a hosted address: the human types each one, per host, per run. A target may take one address or several, one per surface or named service, each checked on its own so that one bad entry holds only the scenarios that use it.

**Role values come only from the seeder.** The Dispatch Plan asks whether the environment's owner ran the repository's seeder there. If yes, the QA session prints the values itself, so no secret passes through a file or an agent. If no, every scenario that signs in there is held. Values are never collected up front. A QA session that refuses a relayed host holds its scenarios and is never moved to the typed route mid-run.

**Desktop QA sessions are parked.** On the desktop harness the app refuses to start a session on a turn it began itself, so every QA start would have become a card the human clicks. Instead, on the human's "go" turn, one Live Session per QA row starts, each in its own worktree on a brief that has no head yet, and is messaged its head once the row is verified. The human's "go" is the consent for all of them. A re-QA runs in the same parked session. A session that was archived, crashed or dropped holds its row, and no card is started mid-run. The QA Stack stays with one session at a time. Headless QA through the CLI executor is offered as an opt-in, with its costs named.

**Uploads are one opt-in, and there is no stale edit.** Uploads are off by default; one opt-in in the Dispatch Plan, with the public-repository warning beside it, approves uploading what the evidence rules accept, with no per-file question. An approved-QA run never makes the stale-report edit: the posted report's header names its commit, so an older report is visibly stale, and a re-QA's post replaces the comment. If posting was not approved, the old comment stays and the close-out lists it as stale.

## Considered Options

- **QA implied by `go autonomous`.** Rejected. A Maintainer must be able to hand over decisions without handing over QA, and QA spends a browser, a stack and time.
- **Mid-run QA Decision Requests.** Rejected. A run with a human needed at every QA step is not unattended; facts, Rulings and close-out hold cover every question.
- **Hosted targets kept on the typed route** (ADR 0013's rule). Rejected. The safeguard is that a person gives the host, not where they type it: the Dispatch Plan keeps that and the check.
- **Typed role values or a values file.** Rejected. A secret would pass through an agent or a file, which the safeguards refuse; the seeder route passes none.
- **A sub-agent or a scheduled task to start QA.** Rejected. A QA session needs a working copy and a browser of its own, which a sub-agent lacks, and a scheduled task goes around the consent rule instead of meeting it.
- **The QA skills made model-invocable for everyone.** Rejected, as in ADR 0013. It would undo the person-gates for every user of the skills, not only in a run where the human handed those questions over.
- **Keep the human typing the QA commands** (ADR 0013's rule for everything beyond a local stack). Rejected, as above: the run is not unattended if a person must be at every QA session.
- **Put the run mapping in orchestrate's brief.** Rejected, as in ADR 0013: the brief would drift from the skills; the section in each skill moves with it.

## Consequences

- Each QA skill's run mapping and its contract test gain a row for every wait this decision moves; a step that waits on the person with no row still fails the test.
- The hosted-target rule in `manual-qa` widens to accept a host the human typed in the Dispatch Plan, as the brief records.
- A QA Delegation is still never a sub-agent.
