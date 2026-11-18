# GitHub

- **Id:** `github`
- **Support Level:** `documented`. No Team Run has been recorded on GitHub yet; the first one that reaches its close-out moves it, citing its Activity Logs.
- **Facts from:** the `gh` CLI, version 2.102.0, read on 2026-11-19 (`gh issue view --json`, `gh repo view --json`, `gh label list --json`, `gh api user`), and GitHub's REST API for sub-issues and issue dependencies, as [SPEC.md](../SPEC.md#read-the-spec) reads them, on 2026-11-13.

Every command runs from the repository root, with `gh` signed in as the teammate. `<owner>/<repo>` is `gh repo view --json nameWithOwner --jq .nameWithOwner`.

## Operations

### `viewer`

```bash
gh api user --jq .login
```

The login of the signed-in user. A ticket is this teammate's when its only assignee has this login.

### `spec-tickets`

```bash
gh api --paginate --slurp repos/<owner>/<repo>/issues/<n>/sub_issues
```

One array of pages: read every page. Each item is a ticket, with `number`, `title`, `state` (`open` or `closed`), `assignees[].login` and `labels[].name`. Why `--paginate --slurp`: [SPEC.md](../SPEC.md#read-the-spec).

### `blockers`

```bash
gh api --paginate --slurp repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by
```

Each item is an issue that blocks ticket `<n>`, with its `number` and `state`. A "Blocked by" section in the ticket's body, listing issues by number, is a blocker too, read the same way ([SPEC.md](../SPEC.md#read-the-spec)).

### `merged`

```bash
gh issue view <n> --json closedByPullRequestsReferences --jq '.closedByPullRequestsReferences[].number'
gh pr view <pr> --json state,mergedAt
```

The first lists the pull requests that close ticket `<n>`. The ticket's pull request is merged when one of them has `state` `MERGED`. A closed ticket with no merged pull request is not merged: it was closed by hand, so it is a question for the human, not a cleared blocker.

### `public`

```bash
gh repo view --json visibility --jq .visibility
```

`PUBLIC` means anyone can read the repository's issues, so a Shared Board row is on the open web. `PRIVATE` and `INTERNAL` do not.

### `labels`

```bash
gh label list --limit 1000 --json name --jq '.[].name'
```

Every label name in the repository. `gh label list` returns 30 labels unless `--limit` says more.

### `create-label`

```bash
gh label create "<name>" --description "orchestrate Team Run state"
```

Creates one label. It is a write as the human: made only on the yes to the Dispatch Plan's one ask for the missing state labels ([TEAM.md](../TEAM.md#missing-state-labels)), never as a routine write. It needs write access to the repository; a refusal is shown to the human as `gh` printed it.

## Check before use

- `closedByPullRequestsReferences` lists the pull requests whose body closes the issue; a pull request that only mentions it is not listed. The first Team Run that relies on `merged` records in its Activity Log what it returned.
- The sub-issues and dependencies endpoints, as [SPEC.md](../SPEC.md#read-the-spec) says.
