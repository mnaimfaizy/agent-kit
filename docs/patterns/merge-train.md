# Pattern guide: merge train

A way to merge a batch of pull requests so that every one lands on a head whose required checks ran against the base branch as it is at merge time, without a merge queue and without an admin bypass. This is a **Pattern guide** ([ADR 0012](../adr/0012-pattern-guides-are-docs-a-consumer-adapts.md)): you read it, copy the skeleton, and adapt it. Agent-kit does not install or upgrade it.

Skeleton to copy: [`examples/patterns/merge-train/`](../../examples/patterns/merge-train/)

- [`merge-train-core.mjs`](../../examples/patterns/merge-train/merge-train-core.mjs): the decision core. Every decision is a pure function here, the loop included.
- [`merge-train-core.test.mjs`](../../examples/patterns/merge-train/merge-train-core.test.mjs): the contract suite, driving the core over a fake shell.
- [`merge-train.mjs`](../../examples/patterns/merge-train/merge-train.mjs): the IO shell, the only place the forge, the clock and the sleep are touched.
- [`merge-order.agent.md`](../../examples/patterns/merge-train/merge-order.agent.md): a read-only agent that proposes the order and the command.
- [`SKILL.md`](../../examples/patterns/merge-train/SKILL.md): the skill that asks for the order, shows it, and runs the train on the user's go-ahead.
- [`auto-merge-mode.json`](../../examples/patterns/merge-train/auto-merge-mode.json): the mode setting for the optional auto-merge, starting `off`.

This guide does not change Agent-kit's own flows. They promise that nothing auto-merges, and they keep that promise. The train, and its auto-merge mode most of all, is a practice you may choose for your own repository.

## The problem

Strict up-to-date branch protection ("require branches to be up to date before merging") exists so that the exact tree that lands has passed the required checks. A batch of pull requests breaks that the moment the first one merges:

- Every other branch in the batch is now behind. Merging it means bringing it up to date, waiting for its checks again, and doing that once per pull request. Done by hand, that is a person clicking "Update branch" and coming back in ten minutes, N times.
- So people reach for the admin bypass. Each merge then lands a combined tree that no check ever ran on. Two pull requests that each passed alone can break the base branch together (one renames a function the other starts calling), and nobody finds out until the next push.
- A merge started from a read of the checks lands whatever is on the branch at merge time. A commit pushed between the read and the click merges unchecked.
- A list of required checks copied into a script goes stale the day someone adds a check to the ruleset, and the script merges without waiting for it.
- When something goes wrong halfway, the person is left working out which pull requests merged and which did not.

A merge queue solves this, where your forge offers one for your repository. The train is for when it does not, or when you do not want one.

## The moving parts

```text
   merge-order agent        skill / user              IO shell                   decision core
  ┌────────────────┐ order ┌──────────────┐ <pr>…   ┌────────────────┐ snapshot ┌──────────────────┐
  │ reads the open │──────▶│ shows order, │───────▶ │ gh: rules,     │────────▶ │ decideNext:      │
  │ pull requests, │ cmd   │ runs train   │         │ view, checks,  │          │ update | wait |  │
  │ proposes order │       │ on go-ahead  │◀─result─│ update, merge; │◀──step───│ merge <head> |   │
  └────────────────┘       └──────────────┘         │ clock, sleep   │          │ stop <reason>    │
                                                    └────────────────┘          └──────────────────┘
```

1. **The decision core** takes plain objects (one read of a pull request, the required check names) and returns the next step. It also holds the loop that drives one pull request and the train over the list, with the shell injected, so the contract suite covers every path without the network.
2. **The IO shell** turns forge calls into those objects and steps into forge calls. It holds no `if` that decides anything.
3. **The merge order agent** reads the pull requests and proposes an order and the one command. It cannot merge, update or comment.
4. **The skill** is the routing: ask for the order, show it to the user, run the train when the user says go, and report what it printed.

For each pull request, in the order given, the train loops: read it; if the base branch has moved past it, update the branch; wait until every required check has a green run on that new head; merge exactly that head; move to the next. It stops at the first thing it cannot pass on its own and prints what merged, where it stopped and why, and the pull requests it never reached.

## The rules, and why each one exists

| Rule                                                                                                                       | Why                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One pull request at a time, in the order given; the next starts only after this one merged.                                | It is the merge of this one that makes the next one behind. Two at once would each be checked against a base branch the other is about to change.                                                                                  |
| A branch that is behind is updated **before** its checks are read.                                                         | Checks on a stale head say nothing about the tree that would land. Reading them first is how a train ends up merging green-but-stale branches.                                                                                     |
| The required checks are read from the ruleset on every run, never listed in the script.                                    | A list in the script goes stale silently. Read from the forge, a check added to the ruleset is waited on the day it is added. If no required checks can be read, the train merges nothing: it will not merge what it cannot check. |
| A required check with no run on the head is waiting, never green.                                                          | Right after an update the new head has no checks at all. Treating "no failures" as a pass merges an unchecked tree, the exact thing the train exists to stop.                                                                      |
| The merge names the exact head whose checks were read (`--match-head-commit <sha>`).                                       | A push between the read and the merge then makes the forge refuse the merge instead of landing an unchecked commit.                                                                                                                |
| No `--admin`, and no flag that would add it.                                                                               | The bypass is the problem this solves. A train with a bypass flag uses it the first time a check is slow.                                                                                                                          |
| Stop at the first red required check, conflict, draft, or blocking review, and name the pull requests never reached.       | None of these turns green by waiting. Stopping keeps the order meaningful (a later pull request may build on the stopped one), and naming what was not reached means nobody has to work out the state of the batch.                |
| Every wait is bounded: updates per pull request, merge refusals on a green head, reads that stay `BLOCKED`, and a timeout. | Each bound marks the point where waiting has become a loop. Something else merging as fast as the train, a rule the train does not know about, or a stuck run all need a person, and the stop reason says which.                   |
| All decisions live in the pure core; the shell only does IO.                                                               | The dangerous cases (a missing check, a head that moved, a refusal) are hard to stage against a real forge. Over fixtures they are one test each, and a new surprise becomes a new test rather than a new `if` in the shell.       |
| The train runs from a person's own login, by hand, and only on their go-ahead for that batch.                              | A merge is a write in someone's name that a revert does not take back. On GitHub there is a second reason: a merge made with a workflow's `GITHUB_TOKEN` does not start the `push` workflows on the base branch.                   |
| The agent proposes the order; it does not apply merge rules.                                                               | If the session decides that a pull request is "safe enough" to skip a check, the merge rests on a model's reading of a page. Keep the agent to ordering and let the train read its facts.                                          |

## Optional: auto-merge

The train can also decide for itself whether a candidate merges, with no person starting each one. This is the riskiest thing in the guide, so it is a separate mode, off by default, reached only through a period in which it decides and changes nothing.

**One setting holds the mode:** `off`, `shadow` or `on`, in a file like [`auto-merge-mode.json`](../../examples/patterns/merge-train/auto-merge-mode.json). The train reads it from the base branch, never from the working tree, so a train started from a feature branch or after a local edit cannot switch itself on. Anything it cannot read is `off`. Changing the mode is a pull request, and that file sits on a path only a person may approve.

- **`off`:** `--auto` does nothing.
- **`shadow`:** the train posts one comment on each candidate, "would merge at `<sha>`" or "held: `<reason>`", edits that same comment on later passes, and merges nothing.
- **`on`:** the train merges a candidate that no rule holds, through the same loop a person's train uses.

**It merges only on facts read for the exact head it merges.** Each rule reads one fact and can only hold:

- every required check is green on this head;
- the latest run on the base branch is green;
- a review verdict approves, and names this head (a verdict for an earlier head is stale);
- the pull request does not change a guarded path: the mode file, the rules the train reads, or whatever decides a pull request's review level. Check this against the base branch's copy, which the pull request has not changed, or it can approve itself.

A fact the train could not read holds, with the reason named. Under `on` the facts are judged once to skip early and again at the head about to merge, after any update.

**A judgment can hold a merge back but never allow one.** A model's view of the diff, such as the [pull request pipeline](pr-pipeline.md)'s Merge risk block, is not tied to a commit and anyone can edit it. So the train reads only the line that holds (`**Reversible:** no`). A missing block, a missing line, or `yes` changes nothing. No judgment is ever on the list of things that must be true for a merge.

**Unlike the hand-started train, a held candidate is skipped, and the pass moves on.** In an auto pass a hold is the normal answer, not an incident.

**`shadow` moves to `on` only on a measured record.** Choose the bar before you start, for example at least 20 "would merge" decisions over at least two weeks, where every one was merged by a person without changes, none was reverted or needed a follow-up fix within seven days, and no "held" reason was a misread. Count from the shadow comments, so the record is on the pull requests themselves.

**A bad auto-merge sends it back to `shadow`.** If an auto-merged pull request is reverted or needs a follow-up fix within your window, set the mode back to `shadow` and start the count again. Loosening any rule later takes a record of its own, kept under `on`.

## Failure modes

- **Something merges around the train.** The bypass usually still exists for emergencies. The train cannot see a merge it did not make, so measure what the guarantee loses: count pull requests that merged while the base branch had moved past their head. The target is zero.
- **The forge's merge state lags its checks.** Right after the last check finishes, the forge can still say `BLOCKED` for a few seconds. One such read is noise; the core allows a few in a row before it stops.
- **The base branch moves between green and merge.** The forge refuses the merge, the next read says `BEHIND`, and the train updates again. That costs one more check run per pull request, bounded by the update limit.
- **Required checks live in classic branch protection.** GitHub's branch-rules endpoint, which the shell reads, returns rulesets only. With classic protection it returns no required checks, and every run stops with "no required checks could be read". That fails closed, but the train is unusable until the shell also reads `branches/<base>/protection/required_status_checks`, or you move the checks into a ruleset.
- **A check name changes.** A renamed job reports under its new name while the ruleset still requires the old one, so the old one waits forever and the train stops at the timeout. Change the ruleset in the same pull request as the job.
- **A skipped required check.** GitHub counts a skipped required check as passing, so the core reads `skipping` as green. If your forge does not, change that one line.
- **The shell grows decisions.** A quick fix lands as an `if` in the shell, untested. Move it into the core with a test, however small.
- **Shadow comments pile up.** Without a marker the train posts a new comment on every pass. Find the comment your login wrote that holds the marker and edit it; never edit a comment someone else wrote, even if it holds the marker.

## Adopting it

1. **Copy the skeleton.** Put the core, its test and the shell together where your scripts live, `merge-order.agent.md` where your harness reads agent definitions, and `SKILL.md` in your skills directory under a name of your choice. The stubs use Node.js and the GitHub CLI; swap the `gh` calls for your forge's. Leave out `auto-merge-mode.json` and the auto-merge half of the core until you want it.
2. **Fill in every placeholder.** Each is written `<like this>` or as a `TODO(adopt)` line. They cover: the base branch, the timeout, the merge method, the train command, and, for auto-merge, the mode file path and how each fact is read for one head.
3. **Run the contract suite in CI.** Every rule above has a test in it. Add one whenever the train surprises you.
4. **Wire it into your instructions.** Your always-on agent instructions say that a batch merges through the train, never through the forge's merge command or the admin bypass, and name the skill to load.
5. **Try a stop on purpose.** Run the train over three pull requests where the second has a failing required check, and check that the first merges, the train stops at the second with that check's name, and the third is listed as not reached.
6. **For auto-merge, start in `shadow`.** Run `--auto` for your chosen period, compare each comment with what you actually merged, and only then open the pull request that sets `on`.
