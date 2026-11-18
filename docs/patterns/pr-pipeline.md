# Pattern guide: pull request pipeline

A way for an agent to open a pull request whose description comes from the branch's real diff, which tells a reviewer how risky the merge is, which carries only labels you allow, and which asks no one to review unless you say so. This is a **Pattern guide** ([ADR 0012](../adr/0012-pattern-guides-are-docs-a-consumer-adapts.md)): you read it, copy the skeleton, and adapt it. Agent-kit does not install or upgrade it.

Skeleton to copy: [`examples/patterns/pr-pipeline/`](../../examples/patterns/pr-pipeline/)

- [`pr-drafter.agent.md`](../../examples/patterns/pr-pipeline/pr-drafter.agent.md): the read-only drafting agent.
- [`SKILL.md`](../../examples/patterns/pr-pipeline/SKILL.md): the skill that calls the drafter, checks its output, and runs the runner.
- [`pr-runner.sh`](../../examples/patterns/pr-pipeline/pr-runner.sh): the runner stub, the only place the branch is pushed and the pull request is created.

## The problem

A commit message is attached to a real diff, so a wrong message is at least next to the truth. A pull request body is the whole deliverable, and nothing compares it to the branch. Left alone, an agent:

- writes the body from the conversation instead of the branch, so it describes work that is not there, or misses work that is. The drafting agent can return a complete, well-formed body without having run a single command.
- turns an intention into a result: "run the tests" in a test plan reads, to a reviewer, as "the tests were run".
- copies the linked issue's labels onto the pull request, including workflow labels that mean something to automation (`ready-for-agent`, for example) and nothing on a merged pull request.
- requests reviewers nobody asked for, or calls a bug worse than its own issue does.
- force-pushes over someone else's commits after a rebase.
- gives no sign of how hard a bad merge would be to undo, so a data migration gets the same review as a typo fix.

## The moving parts

```text
      main agent              drafting agent                 runner script
   ┌──────────────┐        ┌─────────────────┐           ┌───────────────────┐
   │ refuses base │──ask──▶│ runs merge-base,│ TITLE     │ recomputes merge  │
   │ branch       │        │ log, diff, reads│ LABELS    │ base, compares    │
   │              │◀───────│ linked issues   │ MERGE-BASE│ refuses bad risk  │
   │ writes body  │ draft  └─────────────────┘ body      │ line, bad labels  │
   │ to a file    │──title, body file, merge base,──────▶│ pushes safely,    │
   └──────────────┘  labels, reviewers (if named)        │ creates or reuses │
                                                         └───────────────────┘
```

1. **The main agent** checks it is not on the base branch, calls the drafter, splits the draft into its header lines and body, and runs the runner. It never edits the draft's merge base or risk line to get past the runner.
2. **The drafting agent** inspects the branch (merge base, commits, diff, linked issues) and returns a title, optional labels, the merge base it computed, and the body. It cannot push, create or edit anything.
3. **The runner** is one script that is the only way an agent pushes the branch and opens or updates the pull request. It re-checks the draft before anything leaves the machine.
4. **The skill** is the routing between them.

### The draft format

```text
TITLE: <type>(<scope>): <summary>
LABELS: <comma-separated names from your allowlist; the line is left out when none fit>
MERGE-BASE: <full SHA from git merge-base>

## Why
...
## Merge risk
**Reversible:** <yes or no> — <for no: the part a revert does not undo>
**Blast radius:** <one word> — <at most two sentences on what could break>
```

The three header lines sit above the first `##` heading, so the main agent strips them and they never reach the published body.

## The rules, and why each one exists

| Rule                                                                                                                         | Why                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An agent never runs `git push` or the forge's create command itself; it calls the runner.                                    | One entry point is the only place the other rules can be enforced.                                                                                                                                                                                                                                                                                   |
| The drafter must output the merge base it computed, and the runner recomputes it and refuses a missing or wrong SHA.         | The SHA is one fact the drafter cannot guess from its prompt. A drafter that returns it ran git against the branch. This proves the branch was inspected, not that the body is accurate, and it claims no more than that. The main agent must not fill the SHA in itself: that would defeat the check. A draft without one goes back to the drafter. |
| The drafter runs its inspection commands even when the prompt already describes the branch.                                  | A body assembled from the caller's summary reads as accurate and is not drawn from the diff.                                                                                                                                                                                                                                                         |
| The test plan reports commands already run, with their results; anything unverified goes under "Still to check".             | A reviewer reads the test plan to learn what was checked. An intention written as a plan step reads as a result.                                                                                                                                                                                                                                     |
| The drafter fact-checks its draft claim by claim before returning it, and never states a risk more strongly than its source. | Escalated wording and re-attributed numbers outlive the pull request and get quoted back as fact. A claim with no source in the diff, commits or issue is deleted.                                                                                                                                                                                   |
| Every body carries a **Merge risk** block: whether a revert undoes the merge, and the blast radius in one word.              | It tells a reviewer how much care the merge needs before they read the diff. A schema migration that drops data, a change to a stored format, or a removed field a shipped client reads cannot be undone by a revert, and should say so.                                                                                                             |
| The runner refuses, before pushing, a body whose risk line it cannot read.                                                   | Anything downstream that reads the line (a merge queue, a dashboard, a reviewer's filter) fails silently on a malformed one. Refusing early sends the draft back while the drafter still has its context.                                                                                                                                            |
| A pull request carries only labels from one allowlist, and no label by default.                                              | Workflow labels on issues are an interface to automation. Copied onto a pull request they mark merged work as ready for an agent. One allowlist (kind and area labels a human reads) keeps the two vocabularies apart, and the runner refuses anything else, even a label that exists on the repository. An unlabelled pull request is valid.        |
| Infer labels from the combined diff; a linked issue's labels are hints only.                                                 | The issue was labelled before the work existed. What the branch actually touches is the evidence.                                                                                                                                                                                                                                                    |
| No reviewers are requested unless the user names them.                                                                       | A review request notifies a person. An agent choosing who to notify is acting in the user's name without being asked.                                                                                                                                                                                                                                |
| The runner assigns the pull request to the authenticated user.                                                               | An agent's pull request still needs an owner a person can find.                                                                                                                                                                                                                                                                                      |
| A closing keyword (`Fixes #<n>`) only for an issue the branch resolves, and never inside a code span.                        | A wrongly closed issue ends unfinished work and notifies nobody. A keyword in backticks links the issue but never closes it, and the pull request looks correct.                                                                                                                                                                                     |
| An existing pull request for the branch is reused: its title and body are overwritten, and allowed labels are synced.        | Opening a second pull request for the same branch splits the review. Labels outside the allowlist, added by a person or a bot, are left alone.                                                                                                                                                                                                       |
| A diverged remote branch is refused; a rewrite needs an explicit lease, pinned to the remote commit the runner saw.          | After a rebase the push is not a fast-forward, and a plain force push can delete someone else's commits. A lease pinned to the observed SHA fails if the remote moved since.                                                                                                                                                                         |
| If the drafter fails, stop; do not fall back to a body built from commit subjects.                                           | A thin fallback body is fine for a person running the runner by hand, who knows it is thin. From an agent it looks like a finished description.                                                                                                                                                                                                      |

## Failure modes

- **The drafter returns a SHA from its prompt.** If the caller put the merge base in the prompt, the check proves nothing. Never pass the SHA to the drafter.
- **The merge base moves between drafting and running.** If the base branch is fetched in between, the recomputed merge base may differ from the draft's, and the runner refuses. Draft again; that is the correct outcome.
- **A shallow clone.** `git merge-base` fails without enough history. Fetch the base branch with history before running the drafter.
- **The risk block is written but wrong.** The runner checks that the line is readable, not that it is true. A reviewer still judges it, and the drafter is told to call a merge irreversible only on what the diff shows.
- **The allowlist drifts from the repository's labels.** The runner checks names against the allowlist and the forge rejects names that do not exist. Keep one source for the allowlist, and have the drafter read the same one.
- **Patch-equivalent commits after a rebase.** A rebase that resolved a conflict changes a commit's patch, so a simple "every remote commit has an equivalent here" check reports the author's own superseded commit as foreign. The skeleton refuses every diverged push and leaves the lease to an explicit flag; if you automate more than that, compare authors and subjects too.
- **The forge CLI is not authenticated.** The runner fails at its first `gh` call. Fix the login before saying the pull request exists.

## Adopting it

1. **Copy the skeleton.** Put `pr-drafter.agent.md` where your harness reads agent definitions, `SKILL.md` in your skills directory under a name of your choice, and `pr-runner.sh` wherever your scripts live. The stub uses the GitHub CLI; swap the `gh` calls for your forge's.
2. **Write your label allowlist** as one file, one label per line. The drafter reads it to choose labels and the runner reads it to refuse others. Keep workflow labels for issues out of it.
3. **Fill in every placeholder.** Each is written `<like this>` or as a `TODO(adopt)` line. They cover: the runner's path, the base branch, the allowlist path, your body sections, the paths that make a merge irreversible in your repository, and your blast radius words.
4. **Wire it into your instructions.** Your always-on agent instructions say that pull requests go through the runner and never through `git push` or the forge's create command directly, and name the skill to load when opening one.
5. **Try a refusal on purpose.** Run the runner with a made-up merge base, with a body whose risk line ends in a full stop, and with a label not on the allowlist, and check that each is refused before anything is pushed.
