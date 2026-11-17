---
status: accepted
---

# Orchestrate's Chief of Staff may rule, under review

In an autonomous run, the **Chief of Staff** answers some Decision Requests itself instead of relaying them, and the human reviews every answer before anything merges. The human turns this on per run, with `go autonomous` on the Dispatch Plan's **Decision authority** line. An `autonomous` word in the invocation only fills that line in. There is no config key, because how far the human trusts a run is not a fact about the repository.

Each answer is a **Ruling**. The Chief of Staff makes one only where its result is a commit on an unmerged branch: a building Delegation's question about how to do the work within its issue's goal, a stall or crash restarted from its branch, a merge order between conflicting branches, a QA FAIL sent back or run again, and the delivery of a QA Plan. Everything else stays the human's: widening a scope fence, accepting a FAIL or waiving a manual scenario, an analysis Delegation's options, a write as the human not approved as routine, and every action under Authority. A question the Chief of Staff may not rule on parks only its own Delegation, and the run goes on.

A Ruling needs evidence that picks one option, checkable after the run: `path:line` at a commit SHA, command output saved in the run folder, a tracker permalink, or an earlier Ruling by its id. With no such evidence, or when the options cannot be undone by a later commit, the Chief of Staff escalates. Every Ruling goes into the run's **Ruling Ledger**. It is also recorded, labelled as unreviewed, where `decisions.to` says, and each Delegation's report maps its commits to the Rulings they followed.

The **Ruling Review** comes before Ready to Merge. A Delegation is Ready to Merge only once its Rulings are upheld. An overturned Ruling becomes an ordinary human answer, and the rework is a push like any other: the head goes back to step 7, and its QA is void. Every Ruling that cited an overturned one is reviewed again. It is not overturned with it.

## Considered Options

- **Every question to the human, always** (the rule until now). Kept as the default. A long run with the human away stalls on each question, and the questions that come up most (how to build within a settled issue, whether to re-run a flaky QA) are the ones the evidence already answers.
- **Full autonomy over every Decision Request.** Rejected. Widening a scope fence, accepting a FAIL, or settling an analysis Delegation's options changes what the human approved at "go", or builds on an unsettled design. A review after the fact cannot take back a write in the human's name.
- **Authority ticked per kind in the Dispatch Plan**, like routine writes. Deferred. It would add a second checklist to every plan, and nothing yet shows the fixed split is wrong.
- **Review after the merge.** Rejected. Before the merge, an overturn costs a commit. After it, an overturn costs a new issue, and Ready to Merge would no longer mean "can be merged now".

## Consequences

- **The rule "every question goes to the human whole" gets a mode.** In an autonomous run, the questions the human handed over are answered by Rulings, which are self-contained in the same way, so the human can review each one from the ledger alone.
- **Ready to Merge gains a condition**, upheld Rulings, in both copies of the glossary.
- **A spec run on an integration branch** waits for the Ruling Review on the integration branch's own pull request. An overturn for a ticket that has already landed is a fix Delegation on that branch.
- **On a harness below `verified`**, `go autonomous` is always typed after the plan is shown, as `go` is.
