---
# Pattern guide skeleton: docs/patterns/commit-pipeline.md in Agent-kit.
# Copy this folder's SKILL.md into your skills directory, fill in every
# <placeholder>, and delete these comment lines.
name: <commit-change>
description: Use when the user asks to commit the current work, make a commit, or save the staged changes as a commit. Stages named paths, has <commit-drafter> draft the message from the staged diff, and commits only through <runner command> so the hooks always run.
---

# Commit change

## Who does what

| Step                                      | Owner                                  |
| ----------------------------------------- | -------------------------------------- |
| Inspect the tree and decide what to stage | You, asking the user when it is mixed  |
| Draft the message from the staged diff    | `<commit-drafter>` agent (read-only)   |
| Run `git commit` with the hooks           | `<runner command>`                     |
| Repair a failure the runner reports       | You, then run `<runner command>` again |

Never ask `<commit-drafter>` to stage, commit or fix anything.

## Rules

- Never run `git commit` yourself. The only way to commit is `<runner command> --message-file <path>`.
- Pass the message as a file. Do not pipe it on stdin or put it in a quoted argument.
- Wait for the runner to return. Do not cancel it, background it, or start other work while its hooks run.
- Never run `git add .` or `git add -A`. Stage the paths the user means to commit, by name.
- Do not stage a secret-looking file: `<your list, for example .env and .env.* except the example files, private keys, credential files>`. If one is already staged, unstage it with `git restore --staged <path>` and tell the user.
- If `<commit-drafter>` proposes a split, stop and ask which group to commit first. Do not commit every proposed message.
- On a fix (`<how your repository marks a fix: a fix/ branch, a fix commit type, or both>`), at least one commit on the branch carries an origin line on a line of its own: `Introduced by #<pull request>`, or `Introduced by unknown: <why>` when `git log -S` and `git blame` found nothing. The drafter cannot know the origin, so add the line to the message file yourself. Never invent a number.

## Staging

1. Run `git status --short`.
2. If nothing is staged, list the changed and untracked paths and ask which to stage. Do not call `<commit-drafter>` yet.
3. If some paths are staged and others are not, list both sets and ask before staging more or committing.
4. Call `<commit-drafter>` only once the index holds exactly the intended commit.

## Steps

1. Finish staging as above.
2. Call `<commit-drafter>`. If it returns `NO_STAGED_CHANGES:`, go back to staging.
3. Write its message to a temporary file, adding the origin line on a fix.
4. Run `<runner command> --message-file <path>` and wait for it.
5. On success, report the commit's short hash and subject.
6. On failure, read the trailer at the end of the output and act on its `reason` (below). Run the narrow check in `hint` until it passes, then run the same runner command again.

## Failure reasons

The runner ends every failure with:

```text
---
commit-runner: failed
reason: <reason>
scope: <only when the check named one>
paths: <only for reason secret>
hint: <the command to run next>
---
```

| reason        | What to do                                                                   |
| ------------- | ---------------------------------------------------------------------------- |
| `empty-index` | Stage the intended paths (asking the user), call `<commit-drafter>`, retry.  |
| `secret`      | Unstage every path in `paths`. Do not retry until they are out of the index. |
| `format`      | Run the `hint` command, check what it rewrote, retry.                        |
| `lint`        | Run the `hint` command, fix what it reports, retry.                          |
| `hook`        | Read the hook output above the trailer, fix that check, retry.               |
| `unknown`     | Read the output above the trailer, fix the cause, retry.                     |

<!-- TODO(adopt): add a row for each reason you add to the runner, such as `message` for a commit-msg hook. -->

Do not retry until the check in `hint` passes.
