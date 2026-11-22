---
status: proposed
---

# Every GitHub write is a trusted step working from the Stage result

On the Launcher's path no agent writes to GitHub and the Launcher holds no GitHub token of any kind, so it runs the same on a maintainer's machine. Everything an agent needs from GitHub is read into its brief's files before the sandbox starts. Everything a Stage publishes is written afterwards by a trusted workflow step, from the **Stage result**, as plan, review response, security audit and Deep scan already do. Implement and review move to the same shape:

- **Trigger.** The workflow's own gate reads the Trigger label; a trusted step computes the branch name from `branch_prefix` and `branch_name_template`.
- **Status comment.** A trusted step posts one kit-written comment when a run starts (Stage, harness, run link) and edits it to the outcome at the end. It carries no agent text and nothing reads it.
- **Implement.** The Stage result is the bundle plus one JSON file holding a title and a body. A trusted job validates the bundle and pushes the branch; the Caller's `verify_commands` run on that branch in a job with no write credential; then a trusted job opens the pull request, always as a draft. The kit writes `Closes #<issue>` and the contract notes; the agent's title and body are published as untrusted text, capped in size and with mentions neutralised. A missing or invalid file fails the run.
- **Review.** The Stage result is one JSON file: entries under the three axes, fixed and checked notes per axis, and replies. An entry is either new (axis, path, line, summary, body) or existing (axis, summary, the URL of one of the reviewer's open threads listed in the brief). A trusted step checks every anchor against the diff, posts all new entries as one pull request review, reads the thread URLs back and writes the **Review report** itself. A finding whose line is not in the diff is moved to the first changed line of its file, or of the first changed file, under a kit-written first line naming the claimed location; none is dropped. A result over the count or size cap, or an existing entry naming a thread that is not the reviewer's on this pull request, fails the review with nothing published.

Writes use the job token by default. The two pushes that need CI to start, the implement publish (push and pull request) and the review response publish (push), start the held run of the Caller's `ci_workflow`, as review response does today.

A Consumer may instead supply their own GitHub App: the repository variable `AGENT_KIT_APP_ID` and the secret `AGENT_KIT_APP_PRIVATE_KEY`, passed by the Caller as an optional input and secret. Its token is minted with `actions/create-github-app-token` only inside the trusted publish job, for this one repository, with `contents: write` and `pull-requests: write`, and is used for exactly those two pushes and for opening the pull request. `ci_workflow` is then ignored, and the log says so. One of the two set without the other fails the run with a named cause ([ADR 0022](0022-stage-settings-are-named-for-the-kit-not-the-harness.md)). Every comment, thread, reply and Verdict stays on the job token, so the reviewer and the Review responder remain `github-actions[bot]`.

Decided in [GitHub layer for non-Claude Stages](https://github.com/mnaimfaizy/agent-kit/issues/449), on the map [Wayfinder: Stages run on a Consumer-chosen harness](https://github.com/mnaimfaizy/agent-kit/issues/438).

## Considered Options

- **A Consumer-owned App as the only identity**, mirroring the Claude GitHub App. Rejected as the default: a Consumer who picks a harness would have to create and install an App and store its key before the first run, where today's review response already starts CI without one.
- **The job token as the only identity.** Rejected: the pull request's author is `github-actions[bot]` and CI starts only through `ci_workflow` or a manual approval, which some Consumers will not accept.
- **The App token for every write.** Rejected: the reviewer's threads and the responder's Verdict markers are trusted by their author, and a second author would change those rules for no gain.
- **A GitHub token or tools inside the sandbox** (an MCP server, `gh`). Ruled out by [ADR 0025](0025-a-stages-guards-are-reached-by-the-launchers-sandbox.md).
- **A live progress comment** fed from the harness's event stream. Rejected: the stream is never parsed, and the comment would be an agent-written public channel.
- **Verifying from the bundle before anything is pushed.** Rejected: a failed verify would leave the work in an artifact, where today it leaves a branch a human can inspect.
- **The Review report written by the reviewer and checked afterwards**, as on `claude-code-action`. Rejected: when trusted code writes the report from the threads it posted, [ADR 0011](0011-every-review-finding-is-a-thread.md)'s rule holds by construction.

## Consequences

- On the Launcher's path the implementer's pull request no longer needs the Claude GitHub App, and `keep-draft`, the in-session push and `mcp__github__create_pull_request` retire. `open-draft-pr.sh` becomes the one way a pull request opens.
- `review-threads.mjs` keeps `open-threads` and `post-replies` and gains the posting. `check-report` is needed only while the review Stage is still on `claude-code-action`.
- The publish jobs never run in a job where the agent ran, so [ADR 0005](0005-review-responder-holds-no-write-credential.md) holds with either identity.
- `agent-kit doctor`, with the App set: the variable and the secret both exist, the App is installed on the repository (skipped on a personal account, as the Claude App check is), and the ruleset bypass check covers any GitHub App. Without it: `ci_workflow` on the implement and review response Callers names a workflow with a `pull_request` trigger, and an empty one warns that CI needs a manual approval. The `claude-app` check runs only while a Stage still resolves to `claude-code-action`. `init` prints the App steps as optional.
- The implement Caller gains `ci_workflow`.
