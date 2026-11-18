---
# Pattern guide skeleton: docs/patterns/pr-pipeline.md in Agent-kit.
# Copy this folder's SKILL.md into your skills directory, fill in every
# <placeholder>, and delete these comment lines.
name: <create-pull-request>
description: Use when the user asks to open, create or publish a pull request for the current branch. Has <pr-drafter> draft the title, labels, merge base and body from the branch, then opens or updates the pull request only through <runner command>. Requests no reviewer unless the user names one.
---

# Create pull request

## Who does what

| Step                                                | Owner                            |
| --------------------------------------------------- | -------------------------------- |
| Check the branch is not the base branch             | You                              |
| Draft the title, labels, merge base and body        | `<pr-drafter>` agent (read-only) |
| Write the body to a file and run the runner         | You                              |
| Push, assign, and create or update the pull request | `<runner command>`               |

Never ask `<pr-drafter>` to push, create the pull request or edit files.

## Rules

- Never run `git push` or `gh pr create` yourself. The only way to open a pull request is `<runner command>`.
- Always pass `--title`, `--body-file` and `--merge-base` from the draft.
- The `MERGE-BASE:` line shows the drafter inspected the branch. If it is missing, send the draft back. Never compute the SHA yourself and add it, and never put a SHA in the drafter's prompt.
- If the runner refuses the `**Reversible:**` line, send the draft back to `<pr-drafter>` with the runner's message. Do not fix the line yourself.
- Pass each name on the `LABELS:` line with `--label`. Pass no `--label` when the line is absent. Never add a label the draft did not choose.
- Request a reviewer only when the user names one, with `--reviewer <login>`.
- If the drafter fails, stop and report it. Do not open a pull request with a body built from commit subjects.
- After a rebase, the runner refuses the push until you pass `--force-with-lease`. Never run `git push --force`.
- Report the title and the pull request's URL. Do not paste the body back.

## Steps

1. If the current branch is the base branch, stop.
2. Call `<pr-drafter>`. Do not give it a merge base.
3. If it returns `ON_BASE_BRANCH:` or `NO_BRANCH_COMMITS:`, stop and report that line.
4. Split the draft: the `TITLE:` line, an optional `LABELS:` line, the `MERGE-BASE:` line, then the body from the first `##` heading. Write only the body to a temporary file.
5. If there is no `MERGE-BASE:` line, stop and call `<pr-drafter>` again.
6. Run:

   ```sh
   <runner command> --title "<title>" --body-file <path> --merge-base <sha>
   ```

   adding `--label <name>` for each label, `--reviewer <login>` for each reviewer the user named, and `--draft` when the user asked for a draft.

7. Return the title and the URL the runner printed.

## Checks before you report

- The body file holds no `TITLE:`, `LABELS:` or `MERGE-BASE:` line.
- Every label is on `<path to your label allowlist>`.
- The runner printed a URL. If it reported an authentication or push failure, fix that first; the pull request does not exist yet.
