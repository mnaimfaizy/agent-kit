---
name: qa-plan
description: Write a QA Plan for an open pull request — only the manual verification a passing CI run would not establish — and deliver it where the team runs QA.
disable-model-invocation: true
argument-hint: "[pull request number or URL]"
metadata:
  agent-kit-scope: user
---

# QA Plan

A user-invoked compose skill. For one open pull request it writes a **QA Plan**: the **Residue**, the manual verification a passing CI run would not establish, in a format a person or an agent elsewhere can run from the plan alone. The `manual-qa` skill runs it. This skill composes; it runs no scenario and commits nothing.

Load [ANATOMY.md](ANATOMY.md) before writing the plan: it is the format, section by section. Load [ADAPTER.md](ADAPTER.md) when reading or writing `qa.config.yml`, or when a Hazard pack is involved. Load [DESIGN.md](DESIGN.md) when a rule needs its reason, or before changing this skill.

`<skill>` in a command below is the absolute path of the folder this file is in, written with forward slashes (`C:/Users/me/...` on Windows), inside double quotes because it may contain spaces. Every command runs from the root of the repository the pull request belongs to.

## Rules

- **Residue only.** A scenario earns its place by naming what no passing suite establishes. Re-testing what CI proves wastes the tester and hides the scenarios that matter.
- **Every coverage claim is tagged** `[observed]` or `[reconstructed]` ([ANATOMY.md](ANATOMY.md#what-automation-already-proves)). This skill has no two-point runner yet, so every claim it writes is `[reconstructed]`: read from CI results, the diff and the issue history.
- **Read the UI from source.** Every step quotes the real label, button text or copy from the code or templates the pull request ships. When the source does not say, write that the step needs the label confirmed, rather than a guess.
- **No credentials in the plan**, not even a public QA Account's values: role ids, at most emails, and where the values come from ([ANATOMY.md](ANATOMY.md#no-credentials-travel-with-a-plan)).
- **Compose in `working_dir`, commit nothing**, and deliver only after the person has seen the draft and said yes.

## Workflow

### 1. Check the precondition

A QA Plan is about one pull request at one head. Find it: the pull request the person named, or `gh pr view --json number,url,state,isDraft,baseRefName,headRefName,headRefOid,closingIssuesReferences` for the current branch.

Stop and name the next step when:

- the checkout is on the default branch or a detached head: _create a branch for the change, push it and open a pull request, then run `/qa-plan` again_;
- the branch has no open pull request: _push it and open one (`gh pr create --draft`), then run `/qa-plan` again_;
- the local `HEAD` is not the pull request's head commit: _push (or pull) so the two agree; the plan is pinned to the head the tester will get_.

Without `gh`, ask the person for the pull request's URL and the issue it closes; never compose a provisional plan for a change that has no pull request.

**Done when:** one open pull request is identified, and its head SHA equals the local `HEAD`.

### 2. Read the config

```bash
node "<skill>/adapter.mjs" check --for plan
```

- Exit 1: the config has **problems**. Show each one, with its line, and stop until the config is fixed. A misread config composes against the wrong base or the wrong suites.
- `readiness.needs` not empty: list exactly what is missing, and ask for it in one message. Compose goes on with the answers given in chat. Then offer to write them into `qa.config.yml`, and write it only on a yes: put the answers in a JSON file in `working_dir` and run `node "<skill>/adapter.mjs" render < <answers.json>` for the file body ([ADAPTER.md](ADAPTER.md#readiness-check)).
- `readiness.notes`: say each one, and go on.

Check that `working_dir` is ignored: `git check-ignore -q <working_dir>/x`. If it is not, say so and ask before writing there: everything in it must stay out of commits.

**Done when:** the base ref, the suites, `working_dir`, the publish rules and the Hazard packs are known, each from the config or from an answer the person gave.

### 3. Fix the anchors and the subject

- **Merge-base:** `git fetch` the base ref, then `git merge-base <base_ref> HEAD`.
- **Head:** the pull request's head SHA from step 1.
- **Subject issue:** the issue the pull request closes (`closingIssuesReferences`, or a `Closes #n` in its body). Several: ask which one is the subject. None: ask the person; compose no plan without one.
- **Child issues:** the subject's GitHub sub-issues (`gh api repos/{owner}/{repo}/issues/<n>/sub_issues`). With none, the branch's commits (`git log --reverse <merge-base>..HEAD`) are the breakdown of the change instead.

Read the subject, each child, and their comments: their acceptance criteria are what the change promises.

**Done when:** all four anchors are known, and every promise the subject and its children make is listed.

### 4. Establish what automation already proves

For each promise, find what proves it: the CI checks on the head (`gh pr checks`), the configured suites whose `surfaces` cover the changed paths, the tests the diff adds or changes (`git diff --stat <merge-base> HEAD`), and what the issue history says was tested. Write each as a claim tagged `[reconstructed]`, naming the suite or check.

A check that fails on the head and also fails at the merge-base is an **expected red herring**, not a regression; a failure only on the head is a regression: stop, and tell the person to fix it before a plan is worth writing.

Optional, when a claim carries the plan: perturb the code it covers (comment out the guard, invert the condition) and run the suite. A green suite that stays green is not a proving suite; the promise moves to the Residue. Revert the change before going on.

**Done when:** every promise is either covered by a named claim or left for the Residue.

### 5. Match the Hazard packs

```bash
git diff --name-only <merge-base> HEAD | node "<skill>/adapter.mjs" hazards
```

Each pack it prints matched at least one changed path. Exit 1 means a pack in `hazards` is missing or malformed: show the problem and stop.

**Done when:** every matching pack is known, with the paths it matched.

### 6. Compose the Residue

Each promise step 4 left uncovered becomes a scenario ([ANATOMY.md](ANATOMY.md#scenarios)). For each one, read the code and templates it exercises and quote their real labels in the steps. A scenario that touches a path a Hazard pack matched gets that pack's _Rule out first_ list; every matching pack's _Capture rules_ go into the Run brief.

**An empty Residue is a valid outcome.** When every promise is covered, write no plan: tell the person the change is proved by automation, name the claims that prove it, and recommend merging without one. Stop here.

**Done when:** every uncovered promise is a scenario with every field [ANATOMY.md](ANATOMY.md#scenarios) requires, or the Residue is empty and the person has been told.

### 7. Write the draft and show it

Write the plan to `<working_dir>/qa-plan-pr-<n>.md`, in the shape [ANATOMY.md](ANATOMY.md) gives, with the _Execution record_ exactly `_Not run yet._`. Read it back against [ANATOMY.md](ANATOMY.md): nine sections in order, the marker on line 1, every claim tagged, no credentials. Show the person the draft and where it would be delivered (step 8), and ask them to confirm or correct it.

**Done when:** the person has confirmed the draft, as written or after the corrections they asked for.

### 8. Deliver

```bash
node "<skill>/adapter.mjs" delivery --label <label> --label <label> …
```

Pass each of the subject issue's labels. It prints `to`, and the rule that chose it:

- **`working-copy`:** the file from step 7 is the plan. Give the person its path to hand on.
- **`tracker-issue`:** one issue per subject. Search first, `gh issue list --state all --search "\"qa-plan format=1 subject=#<n>\" in:body"`, and edit the issue it finds (`gh issue edit <m> --body-file <plan>`); create one only when there is none (`gh issue create --title "QA Plan: #<n> <title>" --body-file <plan>`, with `--label <label>` when the rule names one). Link it from the pull request in one comment the first time.
- **`pr-comment`:** one comment on the pull request. Find the comment whose body starts with the plan's marker and edit it; post a new one only when there is none.

A revision of the plan replaces the delivered one; it never adds a second. With `tracker: none`, the plan stays in the working copy whatever the rules say.

**Done when:** the plan is at the target the rules chose, the person has its path or URL, and nothing was committed.
