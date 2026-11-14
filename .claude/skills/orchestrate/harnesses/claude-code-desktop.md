# Claude Code desktop app

- **Id:** `claude-code-desktop`
- **Support Level:** `verified`. Runs of `orchestrate` from Dispatch Plan to close-out have passed on it since its first run on 2026-11-13, as the maintainer reports.
- **Tier:** 1.
- **Headless run:** none: a Live Session belongs to the app. This harness can start the Claude Code CLI's (`claude-code-cli`).
- **Facts from:** the session tools the app gives a session, as offered on 2026-11-13.
- **Executors:** building, a Live Session; analysis, a sub-agent, or a Live Session if long; QA, a Live Session.

## Verbs

- `spawn`: start a new session with the brief as its first message, in its own worktree, with the plan's model. The handle is the session's id.
- `message`: send a message to the session by its id.
- `await`: end the turn. The app continues the Chief of Staff when a started session ends a turn, quoting the start of its latest report. Never poll.
- `report`: the session's report file, and its final message.
- A sub-agent, for an analysis Delegation: the in-session agent tool. Its result returns to the Chief of Staff when it finishes.
- A QA Delegation: start the session on its brief, and once its first phase has stopped, `message` it `/qa-plan <n>`; later, `/manual-qa <plan file>`.
- This harness may also run the Claude Code CLI's headless runs ([claude-code-cli.md](claude-code-cli.md)).

## Limits

- QA skills: a slash command sent as a message may not run as the human's own invocation. In the first run (2026-11-13), the QA session could not invoke `qa-plan` itself, and the human typed `/qa-plan <n>` there.

## Check before use

- Whether a sub-agent can be sent a follow-up message after it finishes.
- Whether the app runs a slash command sent as a message as the user's own invocation. Try it; if the session does not run it, the human types it. Record which happened.
