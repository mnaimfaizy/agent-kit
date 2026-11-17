---
status: proposed
---

# Every review finding is a thread; the Review report is only an index

The Review responder builds its Work list from one source: the unresolved inline threads a configured reviewer started (`reviewer_logins`, default `github-actions`). Its skill reads the reviewer's top-level comment as background and never answers it. The kit's CI reviewer (`agent-review-reusable.yml`), though, was told only to "anchor individual findings as inline comments where a specific line is at fault". It put the rest in its tracking comment. On [#254](https://github.com/mnaimfaizy/agent-kit/pull/254) one of six findings became a thread. The round answered that one, and the other five were left for a person, with nothing saying so.

The reviewer now posts every finding as an inline thread. That covers all three axes, nits included. The tracking comment becomes the **Review report**: an index of the review's Findings, one entry per thread, each linking to its thread. It holds no finding of its own.

- **Anchoring.** A finding is anchored to the changed line that causes it. If its real subject is a line outside the diff, or a missing file, it goes on the changed line that causes it, and its first sentence says where the problem actually is. If no line fits, it goes on the first changed line of the most relevant changed file. GitHub accepts review comments only on lines in the diff, and the inline-comment tool has no file-level comment. A finding never goes in a top-level comment.
- **Posted at once.** Every inline comment is created with `confirmed: true`, so the thread exists, with a link, before the reviewer writes the Review report. Without it, the tool holds the comment until the session ends.
- **Checked.** A trusted step after the reviewer reads the Review report and the pull request's review comments. Every entry must link to a review comment on this pull request by the reviewer's login. If an entry has no thread, the review job fails and names it, and the Handoff does not start.
- **Re-review.** The reviewer's brief lists its open threads on the pull request with their latest Verdict, and the reviewer does not post a thread again for a finding that already has one. It ignores threads that are fixed and resolved. It stays silent when it agrees with an `addressed` or `declined` Verdict. It replies on the thread, with why, only when it disagrees, which puts the thread back on the next round's Work list. A thread with no Verdict yet is left alone.

The responder's caps are unchanged: twenty Findings a round, and two rounds before auto mode stops.

## Considered Options

- **Have the responder parse the summary as well.** Rejected. A summary finding has no thread to reply on or resolve, so the round could not report a Verdict where the reviewer and the Maintainer see it. Its text is also free-form agent output that the trusted script would have to parse into Findings.
- **Threads for blocking findings only, nits in the summary.** Rejected. That brings back the gap for exactly the findings a person is least likely to chase. A nit the responder declines costs one reply.
- **A top-level or file-level comment for a finding with no line.** Rejected. A top-level comment is not a thread the responder can resolve, and the tool cannot post a file-level comment.
- **Enforce it in the reviewer's prompt only.** Rejected. A prompt rule is what let five findings slip on #254. The check after the reviewer makes it hold.
- **The reviewer replies to every answered thread on re-review.** Rejected. Agreeing replies would ping-pong between two agents from one model family, which [ADR 0005](0005-review-responder-holds-no-write-credential.md) warns against. Silence means agreement.

## Consequences

- **Pull requests get more threads.** A review with many nits opens many threads, and a person merging by hand resolves or ignores them.
- **The cap can bite.** A review with more than twenty threads takes more than one Response round. In auto mode the Handoff stops after two rounds, which leaves the rest for a person as before. This time each one is an open thread they can see.
- **A review job can fail on its own output.** A report entry without a thread fails the job. That is the intended signal: the review is incomplete and must not hand off.
- **The `address-pr-review` skill is unchanged.** Its "summary is background only" rule becomes true by construction.
- **Other reviewers named in `reviewer_logins` are not covered.** The check runs only on the kit's own reviewer. A third-party bot that writes findings only in its summary still leaves them unanswered.
