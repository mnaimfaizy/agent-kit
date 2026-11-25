---
status: accepted
---

# The posted QA Report is a short summary with a strict header

`manual-qa` posts its QA Report on the pull request. That post was far too long: for nine passing scenarios in one repository it ran to over 11,000 characters, with a long run-deviations line, table rows of a thousand characters, local evidence paths nobody on GitHub can open, and an Execution record that repeated the table. Reviewers skipped it, and nothing machine-readable said what commit it covered.

This changes `manual-qa` for every user, not only in orchestrate, so it is its own decision.

## Decision

The posted QA Report becomes a short summary, in the shape of the My Organiser project's report (prototype variant A, chosen with the Maintainer):

- a marker, then a strict header line: the result (passed or failed), the full commit it covers, the number of items left for a person, and the number deferred; or, when no manual QA was needed, a header saying so with the commit;
- one line saying an agent ran it, on which commit and target, and the result;
- a three-column table: scenario, result, notes;
- the failures and how each was resolved;
- a list of what is left for a person.

**The header is read strictly,** by a parser, and orchestrate reads it to check a QA claim against its commit and counts. A header that does not match, or counts that disagree with the list, means no report: a malformed post can never pass as QA.

**Places are configurable.** Each item left for a person carries a Place. The default is the My Organiser one: a local Place holds a merge and counts as left for a person; staging and production are counted as deferred and never hold. A repository can rename Places, add its own, or turn them off, in which case items are untagged and all count as held. The Dispatch Plan shows the run's Places and lets the human change them for the run or save them; `qa-plan` picks each item's Place from that list when it writes the plan. A Review box the Chief of Staff ruled on keeps a note saying which Ruling checked it.

**The full report stays local.** Run facts, evidence paths, run deviations, the Execution record and side notes stay in the local QA Report and the run folder. One exception: a deviation that changes how far a result can be trusted goes, in a few words, in that scenario's notes. Uploaded evidence is linked from the notes, which keeps three columns.

**One comment per pull request,** edited on a re-run. A plan delivered to a tracker issue still gets its ticks and Execution record there, unchanged; the pull request always gets the summary.

## Considered Options

- **The full report as the post** (today). Rejected. It is what reviewers skip, it carries paths nobody can open, and it has no header a program can trust; the full report stays local for whoever needs it.
- **Variant B, verdict first with the detail folded.** Rejected. A folded section still ships the length into every comment and hides the table a reviewer wants first; the Maintainer preferred the flat summary.
- **Variant C, exceptions only.** Rejected. A report that lists only exceptions cannot show what passed, so a reviewer cannot tell a clean run from one that tested little.

## Consequences

- `manual-qa`'s posted output changes for every user; its tracker output does not.
- Orchestrate can check a QA claim against the commit and counts in the header instead of trusting prose.
- A report for an older head is visibly stale from its header, which is what lets the autonomous-QA handover ([ADR 0032](0032-autonomous-qa-handover-nothing-asked-mid-run.md)) drop the stale-report edit.
