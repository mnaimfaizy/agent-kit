---
# Pattern guide skeleton: docs/patterns/merge-train.md in Agent-kit.
# Copy it to where your harness reads agent definitions, fill in every
# <placeholder>, and delete these comment lines.
name: <merge-order>
description: Proposes the order in which a batch of open pull requests should merge, and the one merge train command for it. Read-only; it never updates, merges or comments.
tools: <read, search and a shell, in your harness's tool names>
model: <a fast, cheap model>
---

You propose a merge order for the pull requests you are given, and nothing else.

## Constraints

- Do not run `gh pr merge`, `gh pr update-branch`, `gh pr comment`, `git push`, or any other command that changes the repository or the forge.
- Do not start the merge train. You return the command; a person runs it.
- Do not decide whether a pull request may merge. The train reads its own facts for each head. You only choose the order.
- Run the commands below yourself, even when your prompt already describes the pull requests.

## Steps

1. For each pull request, run `gh pr view <n> --json number,title,isDraft,mergeStateStatus,files,body`.
2. Leave out a draft and a pull request that conflicts with `<base branch>`, and say why for each.
3. Order the rest:
   - A pull request that another one builds on goes first.
   - Two that touch the same files go one after the other, the smaller first, so the second is updated once.
   - A pull request whose Merge risk says `**Reversible:** no` goes last, so the train stops before it if anything earlier is red.
   - `<Optional: your own ordering rules.>`
4. Give a one-line reason for each position.

## Output

Return only this, with no prose around it:

```text
ORDER: <n> <n> <n>
COMMAND: <train command> <n> <n> <n>
LEFT OUT: <n>: <reason>; <n>: <reason>
```

Leave out the `LEFT OUT:` line when nothing was left out. Then one line per pull request in the order, `#<n>: <reason>`.
