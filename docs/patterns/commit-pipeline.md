# Pattern guide: commit pipeline

A way for an agent to commit work so that every commit runs your hooks, contains only what you meant to stage, and leaves an agent a precise next step when something fails. This is a **Pattern guide** ([ADR 0012](../adr/0012-pattern-guides-are-docs-a-consumer-adapts.md)): you read it, copy the skeleton, and adapt it. Agent-kit does not install or upgrade it.

Skeleton to copy: [`examples/patterns/commit-pipeline/`](../../examples/patterns/commit-pipeline/)

- [`commit-drafter.agent.md`](../../examples/patterns/commit-pipeline/commit-drafter.agent.md): the read-only drafting agent.
- [`SKILL.md`](../../examples/patterns/commit-pipeline/SKILL.md): the skill that stages, drafts, runs the runner and handles a failure.
- [`commit-runner.sh`](../../examples/patterns/commit-pipeline/commit-runner.sh): the runner stub, the only place `git commit` runs.

## The problem

An agent left to commit on its own goes wrong in a few ways:

- It runs `git add .` and commits a scratch file, a build output or an `.env` file.
- It hits a slow or failing hook and reaches for `--no-verify`, or cancels the hook and moves on, so the commit lands without the checks your humans' commits go through.
- When a hook fails it reads a wall of output, guesses which check failed, and changes the wrong file.
- It writes the message from what it remembers doing rather than from the diff, so the message describes work that is not in the commit.
- A bug fix lands with nothing saying which change introduced the bug, so nobody can later measure which reviewed changes let defects through.

None of these is a model being careless. They happen because nothing between the agent and `git commit` stops them.

## The moving parts

```text
      main agent                drafting agent            runner script
   ┌──────────────┐  staged   ┌───────────────┐  msg   ┌──────────────────┐
   │ stage named  │──diff────▶│ reads the     │──────▶ │ refuses empty or │
   │ paths only   │           │ staged diff,  │ (file) │ secret index,    │
   │              │◀──────────│ returns text  │        │ runs git commit  │
   │ fix, retry   │  failure  └───────────────┘        │ with hooks, ends │
   └──────────────┘◀─trailer───────────────────────────│ a failure with a │
                                                       │ labelled trailer │
                                                       └──────────────────┘
```

1. **The main agent** decides what to stage, with the user when the tree is mixed. It is the only part that stages, edits files, or repairs a failure.
2. **The drafting agent** reads the staged diff and returns a commit message, and does nothing else. It cannot stage, commit or edit.
3. **The runner** is one script that is the only way an agent commits. It checks the index, runs `git commit` with the hooks, and on failure prints the hook output followed by a short trailer that names the reason.
4. **The skill** is the routing between them: when to call the drafter, how to call the runner, and what to do for each failure reason.

## The rules, and why each one exists

| Rule                                                                                        | Why                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An agent never runs `git commit` itself; it calls the runner.                               | One entry point is the only place the other rules can be enforced. A rule written in a prompt is a rule the agent can skip under pressure; a rule in a script is not.                                                                                       |
| The runner never passes `--no-verify` and has no flag that would.                           | The hooks are what make an agent's commit as checked as a person's. A bypass flag that exists will be used the first time a hook is slow.                                                                                                                   |
| The agent waits for the runner to finish and never backgrounds or cancels it.               | A cancelled hook leaves a half-formatted tree and no commit, and an agent that "moves on" then commits again from the wrong state.                                                                                                                          |
| Stage named paths only; never `git add .` or `git add -A`.                                  | A wildcard stage commits whatever happens to be in the tree. Naming paths makes the agent decide, and the decision is visible in the transcript.                                                                                                            |
| Ask the user when nothing is staged, or when staged and unstaged changes are mixed.         | Which files belong in a commit is the user's call. Guessing turns one logical change into two half-commits.                                                                                                                                                 |
| The runner refuses a staged path that looks like a secret, and names it.                    | `.env`, private keys and credential files are the costliest thing to commit and the easiest to stage by accident. A path check is cheap and runs before anything leaves the machine. It is a backstop, not a secret scanner: it checks names, not contents. |
| The runner refuses an empty index.                                                          | Otherwise `git commit` fails with a message an agent tends to misread, and the agent "fixes" it by staging everything.                                                                                                                                      |
| The drafting agent is read-only and drafts from the staged diff only.                       | A message written from memory or from the unstaged tree describes a change the commit does not contain. Keeping the drafter unable to write also keeps it from "helpfully" fixing a hook failure.                                                           |
| The message reaches the runner as a file, never on stdin or in a quoted argument.           | Quoting and terminal handling differ between shells; a multi-line message on stdin or in `-m` arrives mangled on some of them.                                                                                                                              |
| If the drafter proposes splitting the commit, stop and ask which group goes first.          | Running the runner once per proposed message commits every group without the user choosing the boundaries.                                                                                                                                                  |
| Every failure ends with a trailer naming a reason, and the skill maps each reason to a fix. | An agent reading raw hook output guesses. A trailer with `reason: lint` and a hint command lets it rerun the one check that failed, fix only that, and retry.                                                                                               |
| Retry only after the narrow check named in the hint passes.                                 | Retrying the whole commit to "see if it works now" reruns every hook and teaches the agent nothing about what failed.                                                                                                                                       |
| A fix commit says what introduced the defect, or that the search found nothing.             | See [Origin lines on fixes](#origin-lines-on-fixes).                                                                                                                                                                                                        |

### The failure trailer

The runner reprints the hook output, then ends every failure with a block an agent can parse:

```text
---
commit-runner: failed
reason: lint
scope: <the project or package the check named, when it names one>
paths: <the refused paths, for reason secret>
hint: <the one command to run next>
---
```

`reason` is a closed set. The skeleton uses these, and you can add to them:

| reason        | Produced by                                       | What the agent does                                             |
| ------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| `empty-index` | the runner, before committing                     | Stage the intended paths (asking the user), draft again, retry. |
| `secret`      | the runner, before committing                     | Unstage each path in `paths`; do not retry until they are out.  |
| `format`      | a hook's output matched your formatter's pattern  | Run the formatter command in `hint`, check the rewrite, retry.  |
| `lint`        | a hook's output matched your linter's pattern     | Run the lint command in `hint`, fix what it reports, retry.     |
| `hook`        | a hook failed and no pattern matched              | Read the hook output above the trailer, fix that check, retry.  |
| `unknown`     | git failed outside the hooks, or bad runner input | Read the output, fix the cause, retry.                          |

The classifier is a few regular expressions over the hook output. Which patterns identify your formatter and linter, and what the hint command is, are the main thing you fill in when you adopt it.

### Origin lines on fixes

When a commit fixes a bug, the person or agent who just traced it knows where it came from, and that is the cheapest moment to write it down. So at least one commit on a fix branch carries a line of its own:

```text
Introduced by #<pull request>
```

or, when the search (`git log -S`, `git blame`) found nothing:

```text
Introduced by unknown: <what was searched and why it found nothing>
```

The `unknown` form keeps the requirement honest: "we looked and could not tell" is a recorded outcome, distinct from "nobody wrote anything", and the reason after the colon stops a bare `unknown` from standing in for the search. The drafting agent cannot know the origin from a diff, so the main agent adds this line to the message file itself and never invents a number.

Writing it is the convention. Checking it is optional: a CI step can read the fix branch's commits since the merge base and fail when none carries either line. A convention with no check tends to be skipped, so add the check once the line is habit.

### Optional: a commit message format check

The drafter writes Conventional Commits, but nothing in this pipeline rejects a message that is not one. If you want that enforced, add a `commit-msg` hook (commitlint, or a short script) and have the classifier map its failure to a `message` reason whose hint is "redraft the message". The pipeline works without it; the drafter's format is a convention until you add the hook.

## Failure modes

- **The drafter is given the diff in its prompt and does not run git itself.** It then drafts from whatever the caller summarised. Keep the instruction to inspect the index itself, and judge its output against the staged diff, not against the conversation.
- **A hook prints nothing a pattern matches.** The trailer says `hook` and the agent has to read the output. That is the right fallback, but if one check lands there often, give it a pattern and a reason of its own.
- **The secret guard is mistaken for a scanner.** It blocks known filenames only. A key pasted into a source file passes. Keep a content scanner (in a hook or in CI) if you need one.
- **The runner is bypassed.** An agent with shell access can still type `git commit`. Say "never run `git commit` directly" in your always-on instructions, and if your harness supports it, add a pre-tool hook that refuses `git commit` outside the runner and refuses `--no-verify` anywhere.
- **Hooks are not installed.** If your hook manager installs on `postinstall` or similar, a checkout without dependencies commits with no hooks run, and the runner reports success. A green commit there proves nothing; CI has to run the same checks.
- **A formatter hook rewrites files and the commit does not include the rewrite.** If your hook formats, it must also restage what it changed, or the commit holds the unformatted version and the tree is left dirty.
- **The trailer format drifts.** Agents parse it. Treat its field names and the reason set as an interface: add reasons, do not rename them.

## Adopting it

1. **Copy the skeleton.** Put `commit-drafter.agent.md` where your harness reads agent definitions, `SKILL.md` in your skills directory under a name of your choice, and `commit-runner.sh` wherever your scripts live.
2. **Fill in every placeholder.** Each is written `<like this>` or as a `TODO(adopt)` line. They cover: the runner's path and how it is invoked, your hook manager, the formatter and linter patterns and their hint commands, the secret-looking path rules, and the drafter's model and scopes.
3. **Wire the runner into your instructions.** Your always-on agent instructions (`AGENTS.md` or its equivalent) say that commits go through the runner and never through `git commit`, and name the skill to load when committing.
4. **Decide on the optional checks.** The origin-line check on fix branches and the commit message format hook are both optional. Write the convention down either way.
5. **Try a failure on purpose.** Stage a file with a lint error and a file named `.env.local`, ask the agent to commit, and check that you get the `secret` trailer first, then the `lint` trailer, and that the agent fixes only what each one names.
