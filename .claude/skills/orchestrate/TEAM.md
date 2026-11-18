# Team Run

`/orchestrate --spec <n> --team [go] [autonomous]` runs a spec as a **Team Run**: teammates who split a spec's tickets each run their own Chief of Staff, on their own machine and harness, over the tickets assigned to them, and every one of them reads one **Shared Board** on the issue tracker. Load this file only for `--team`, after [SPEC.md](SPEC.md), or on `--resume` of a run whose board says it is a Team Run. A run without `--team` never reads it. It changes SPEC.md and steps 1 to 4 of [SKILL.md](SKILL.md#workflow) where it says so, and leaves every rule and every other step as written there. Why it is shaped this way: [DESIGN.md](DESIGN.md#team-run).

A Team Run is federated. No Chief of Staff drives another person's machine, and there is nothing to join: each teammate starts their own run. Each keeps its own run folder, exactly as a single-person run does ([RUN.md](RUN.md#layout)); the Shared Board is a projection of it, never a store. A Chief of Staff never assigns, unassigns or reassigns a ticket: the tracker's assignee is the human's to set, and the only sign of whose ticket it is.

## Find the tracker

At SKILL.md step 1, `check` prints a `tracker` report beside the `harness` one: `pinned`, the config's `tracker` value, or null for `detect` ([CONFIG.md](CONFIG.md#tracker)); `remote_host`, the host of the repository's git remote (`origin`, or its only remote); and `detected`, the tracker that host points to, or null for a host detection does not know.

| `pinned`  | `detected`                           | The tracker                                                                                                                                                                                                                               |
| --------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| null      | a tracker                            | That tracker.                                                                                                                                                                                                                             |
| a tracker | null, or the same one                | The pinned one. An unknown host, such as a self-hosted GitLab on its own domain, is what the pin is for.                                                                                                                                  |
| a tracker | another tracker                      | The two disagree: a Decision Request before anything else, never a silent choice. Say the pin, the remote's host and what it points to. Recommend the remote's, and setting the pin to match, since the remote is where the tickets live. |
| null      | null (no remote, or an unknown host) | A Decision Request: say the remote's host, or that there is none, and ask which tracker the spec's tickets are on. Recommend pinning `tracker` in the config, so the next run does not ask.                                               |

Then load [TRACKERS.md](TRACKERS.md), which names the operations a Team Run reads the tracker through, and that tracker's own file under [trackers/](trackers/), and only that one. A tracker with no file there stops the run before anything else is read: say which trackers this version has a file for.

The tracker file gives its **Support Level**, in the words harness files use ([HARNESSES.md](HARNESSES.md#support-level)). Below `verified`, the Dispatch Plan says so with what it means for this run, and waits for the human's "go" even when the invocation carried `go`, as for a harness.

Read this teammate's login with the `viewer` operation. Record on the board, under the spec's line, `Team Run: <tracker>, as <login>`, with the tracker file's Support Level, and log both in the Activity Log.

**Done when:** the tracker is named, its file is loaded, and the board says this is a Team Run, for whom.

## Whose tickets

Read the spec as SPEC.md says. A Team Run is planned in the [Tickets](SPEC.md#tickets) shape only, since a ticket's assignee is what says whose run builds it:

- **Phases:** a phase has no assignee. Make SPEC.md's offer to publish the phases as tickets; on a yes, the tickets are made unassigned, so the plan has no tickets of this teammate's ([below](#no-tickets-of-your-own)) until the team assigns them. Without a yes, stop, and say that `--spec <n>` without `--team` runs phases.
- **Neither:** as SPEC.md says.

List the spec's tickets with the `spec-tickets` operation. A closed ticket is done work, as in SPEC.md. Each open ticket goes in exactly one group, by its assignees:

| Assignees                                    | Group                                 | In this run                                                                                                                   |
| -------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| only this teammate                           | this teammate's tickets               | Analysed and planned as SPEC.md's [Tickets](SPEC.md#tickets) says, each by its triage role.                                   |
| one other person                             | **Teammates' tickets (not run here)** | Listed with its assignee and its state. That teammate's own Team Run builds it.                                               |
| nobody                                       | `unassigned`                          | Listed. Nobody runs it, and nothing is written on it, until someone is assigned.                                              |
| two or more, this teammate among them or not | needs one assignee                    | Listed, with its assignees. Nobody runs it until exactly one remains: two runs building one ticket would race for one branch. |

A ticket's **state** is the one state label it carries, read through the config's `team.labels` ([CONFIG.md](CONFIG.md#team)): `planned`, `parked`, `running`, `waiting`, `ready to merge` or `merged`. A ticket with none says `no state yet`. One with two or more says which it carries: only its assignee's run writes it, and that run puts it right.

### Blocking across teammates

SPEC.md's waves hold for this teammate's tickets, with the blockers each one has, read with the `blockers` operation. A blocker that is another ticket of the spec, but not this teammate's, is not SPEC.md's "blocker that gets no building Delegation" Decision Request: it is built in someone else's run, or in nobody's yet. The ticket it blocks is parked until that blocker's pull request is merged, read with the `merged` operation, so it is built on the code it will merge into. The plan names, beside the parked ticket, whose ticket it waits on, or that nobody runs it yet when it is `unassigned` or needs one assignee. A blocker outside the spec is as SPEC.md says.

## The Dispatch Plan

SKILL.md step 4, with SPEC.md's additions, changed as follows. What is not named here is as written there.

- **It opens** with the harness, as step 4 says, then the tracker, its Support Level ([above](#find-the-tracker)) and this teammate's login.
- **The table** has a row for only this teammate's tickets: one building or analysis Delegation for each, and its QA Delegation where it needs one, as SPEC.md says for one pull request per ticket.
- **Landing:** a Team Run always lands one pull request per ticket: there is no integration branch shared between teammates, and a teammate's ticket that blocks yours lands by its own merge. The plan says `**Landing:** per-ticket`. When the config's `spec.landing` is `integration-branch` or `ask`, it adds that `spec.landing: <value>` is overridden in a Team Run, with the value filled in. SPEC.md's [one pull request per ticket](SPEC.md#one-pull-request-per-ticket) is the landing, from wave to wave.
- **The lists**, after SKILL.md step 4's own:
  - **Teammates' tickets (not run here)**: each with its number, title, assignee and state, and the tickets of this teammate's it blocks.
  - **`unassigned`**: each with its number and title. Nobody runs these.
  - **Needs one assignee**: each with its assignees. Nobody runs these until exactly one remains.
- **Routine writes:** the kinds step 4 lists, and "Shared Board: row comment and state labels on my assigned tickets". It covers only this teammate's own tickets, never a teammate's or an `unassigned` one, and is approved once, at "go". When the `public` operation says the repository is public, that section opens with the line: "This repository is **public**: row comments and state labels are readable by anyone." This version of the skill does not give the row's form yet, so it writes no row comment and no state label: the plan says so, and the approval is recorded on the board.
- **Decision authority** is per teammate: the line covers this teammate's run only, and this teammate's `go` or `go autonomous` sets it. Each teammate chooses their own in their own run, and an `autonomous` run makes Rulings only on its own Delegations.

The board records the three lists beside the plan's rows.

### Missing state labels

Read the repository's labels with the `labels` operation, and compare them with the six names in `team.labels`. When any are missing, the plan lists them with one ask to create them all with the `create-label` operation. Creating a label is a write as the human, never routine: it is a Decision Request in the plan, answered with the "go" or before it, and the labels are made only on a yes. A no leaves them uncreated, says so on the board, and the run goes on: a missing label is shown as such, never made without the yes.

### No tickets of your own

When no open ticket's only assignee is this teammate, the plan has no rows. It says that no ticket of spec `#<n>` is assigned to this teammate alone, by their login, shows the three lists, and points to `--status` to follow where the spec stands. There is nothing to "go" on: close the run on the board as having no tickets, and stop. Once a ticket is assigned to them, they start a new Team Run.

**Done when:** the human has said "go" to the plan, or the plan said there are no tickets of their own; the board records which, with the three lists.
