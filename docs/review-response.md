# Review response First-class flow

Review response closes the loop after a review: plan → implement → review → **respond to the review**. It answers the code review on a pull request. Each unresolved review thread the reviewer started is a **Finding**, and each Finding gets a **Verdict**: `fixed` (one commit), `addressed` (the branch already handles it) or `declined` (with a reason). Setup steps: [Getting started](getting-started.md). Every input and secret: [reference.md](reference.md#review-response). Why the CI flow is built the way it is: [ADR 0005](adr/0005-review-responder-holds-no-write-credential.md).

The whole procedure lives in one Portable skill, [`address-pr-review`](../.claude/skills/address-pr-review/SKILL.md). You can run it yourself in any repository, with no CI at all. The CI flow runs the same skill unattended, and keeps for itself what an unattended agent must not be trusted with: the gate, the Work list, checking and pushing its commits, and speaking on the pull request.

Terms used here (Review responder, Finding, Work list, Verdict, Response round, Handoff, Maintainer guidance) are defined in the [glossary](../GLOSSARY.md#review-response).

## Run the skill yourself

Install it once, in your own skills directory ([Install individual skills](install-skills.md)), or adopt the kit, which copies it to `.claude/skills/address-pr-review/`. It needs Node 22 or later, `git`, and `gh` signed in to the repository. From the root of the repository the pull request belongs to:

```text
/address-pr-review 42
```

One run is one **Response round** per pull request you name:

1. It reads the optional config, `address-pr-review.config.{yml,yaml,json}` at the repository root (keys `reviewer_logins`, `working_dir`, `worktree`, `commit_command`, `push_command`; see [ADAPTER.md](../.claude/skills/address-pr-review/ADAPTER.md)). A problem in the config stops the run, with its line.
2. It refuses a pull request that is closed or comes from a fork, and records the head as the round's start.
3. It builds the **Work list**: unresolved threads whose first comment a login in `reviewer_logins` wrote (default `github-actions`), oldest first, outdated threads included, at most 20. It says how many were left for the next round. It also shows top-level comments and requested-changes reviews by trusted people, and asks whether each one is a finding.
4. Each finding gets a provisional Verdict. A finding with no single clear fix (more than one reasonable fix, a behaviour change nobody asked for, work for its own issue, a finding it thinks is wrong) goes into **one batched question** with a recommendation.
5. It fixes in a `git worktree` under `working_dir` (default `tmp/address-pr-review`, which must be gitignored), so your checkout never moves. One commit per fixed finding, after the checks that cover it.
6. It shows you one batch: the commits, every reply in full, and which threads it will resolve. Nothing is pushed or posted until you confirm.
7. It pushes to the pull request's own head branch (never force, never another branch, not at all if the branch moved during the round), then posts the replies and resolves what [the resolution rule](#the-resolution-rule) allows.

Run by a person, guidance counts only from thread replies by `OWNER`, `MEMBER` or `COLLABORATOR`. Anyone else's reply is shown to you, labelled as untrusted, and never acted on. One pass per run: it never polls, waits for CI or merges. Run it again after the next review.

## The CI flow

| Piece              | Where                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable workflow  | `.github/workflows/agent-review-response-reusable.yml`                                                                                                                                 |
| Caller example     | [`examples/review-response-caller.yml`](../examples/review-response-caller.yml), or `npx @mnaimfaizy/agent-kit init --flows review-response`                                           |
| Trusted script     | `.github/agent-review-response/review-response.mjs` (Kit-owned)                                                                                                                        |
| Skill              | `.claude/skills/address-pr-review/` (Kit-owned)                                                                                                                                        |
| Trigger label      | `agent:address-review` on a pull request (`trigger_label`), consumed by the gate                                                                                                       |
| Kill switch        | `CLAUDE_REVIEW_RESPONSE_ENABLED`: the flow runs only when it is `true`                                                                                                                 |
| Mode               | `CLAUDE_REVIEW_RESPONSE_MODE`: exactly `auto` turns on [auto mode](#auto-mode); anything else, or unset, is manual                                                                     |
| Model              | `CLAUDE_MODEL_REVIEW_RESPONSE`, then `CLAUDE_MODEL`, then `claude-opus-5`                                                                                                              |
| Secret             | `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`. GitHub access is the job token throughout: no Claude GitHub App, no personal access token.                                       |
| Caller permissions | `contents: write`, `pull-requests: write`, `actions: write`. Only the publish job holds all three (the gate holds `pull-requests: write`); the job that runs the agent gets read-only. |

The Caller owns its toolchain and checks, the same way the implement Caller does: `setup_commands` (copy a [setup preset](../examples/setup-presets/)) runs before the agent, and `verify_commands` are the checks the agent runs before each fix commit, its only build command. Both are code the job runs: never build them from issue or pull request text. The other inputs are `allowlist_actors`, `reviewer_logins`, `extra_protected_paths`, `ci_workflow` and `model`; [reference.md](reference.md#review-response) has each one.

### What a round does

A round is three jobs, and each holds only what it needs:

1. **gate** checks the Kill switch and the Allowlist, consumes the label, and reads the pull request live from the API. It refuses what no round may run on ([below](#refusals-and-protected-paths)), and records the head commit and the **trusted commit**: the default branch's tip, read now.
2. **respond** builds the pull request's code, so it holds `contents: read`, `pull-requests: read`, no `id-token`, and no credential that can write to GitHub. It reads the trusted script, the skill and the confinement hooks from the trusted commit's objects, never the working tree. It refuses a pull request that changes a protected path, and builds the Work list and the agent's brief, all before any pull request code runs. Then it runs `setup_commands` with npm, pnpm and Yarn 2+ install scripts always off, and the agent with its commands in a bubblewrap sandbox with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. The agent may read and edit the checkout, run `verify_commands`, `git add` and `git commit`: no push, no `gh`, no reads of `.git/`, no web access. Its commits leave as a git bundle (at most 500000 bytes) and its `review-response.json` as text (at most 150000 bytes).
3. **publish** runs on a fresh runner with only the trusted commit checked out, and is the only job that pushes or starts a run. It pushes nothing if the branch moved during the round. It accepts the bundle only as a straight line of at most 20 ordinary commits on the start head, with no merge, symlink or submodule, and no protected, workflow or Windows-unsafe path. It pushes with the job token, starts the held CI run ([below](#ci-on-the-pushed-commits)), then reads the threads from GitHub again and replies, resolves and posts one summary comment.

The agent's response is a claim, never trusted: a `fixed` Verdict must name a commit publish itself pushed, and a verdict for a thread that was not on the Work list is dropped. Replies are capped at 4000 characters and cannot mention anyone or carry an HTML comment.

### The runtime comes from your default branch

The trusted script, the hooks (`.github/agent-runtime/`) and the skill are read from your **default branch's tip**, not from the kit tag your `uses:` pins. So copy the Kit-owned paths there, and merge them before the first round: a round on a repository whose default branch lacks them fails in respond. This is also why a pull request into any other branch is refused: that branch's author would become the trust root.

### CI on the pushed commits

GitHub does not start your CI for a push made with the job token: it creates the `pull_request` runs and holds them for approval. Set `ci_workflow` to the one workflow (`.github/workflows/<file>.yml`) whose held run publish may start, and it starts that run, for exactly the commit it pushed. Nothing else the push queued is approved. With `ci_workflow` unset, the summary says CI did not start: approve it from the pull request's checks ("Approve workflows to run").

### One run per pull request at a time

The review and response workflows share one concurrency group per pull request (`agent-kit-pr-<number>`), so a review and a response never run on the same pull request at once; the second waits. GitHub keeps only one waiting run per group: a third run queued meanwhile cancels the waiting one, whose label then stays on the pull request. Remove the label and apply it again to start that round.

## Manual and auto mode

### Manual mode

The default. A login on the Allowlist (`allowlist_actors`) applies `agent:address-review` to the pull request, and one round runs. An empty Allowlist skips that check, so anyone who can apply labels can start a round, and then accepts guidance from no one. Apply it again for the next round. Every `workflow_dispatch` run of the Caller is refused, including a person pressing "Run workflow".

### Auto mode

With `CLAUDE_REVIEW_RESPONSE_MODE` set to exactly `auto`, a finished review that left findings starts a round on its own: the **Handoff**. The review workflow's `handoff` job reads the trusted script from the default branch, counts the findings the round would see and the rounds the pull request has had, and dispatches your Review response Caller on the default branch with `pr_number`. A reusable workflow cannot be dispatched, so it dispatches your Caller file.

Both Callers need wiring.

**The review Caller** (the job that `uses:` `agent-review-reusable.yml`) passes the mode, names your Review response Caller, and grants `actions: write` for the handoff job. Every review Caller needs that job-level grant, even in manual mode: GitHub refuses a called workflow whose job asks for more than its Caller grants, even when that job would not run. The [example](../examples/plan-implement-review-caller.yml) already has it. Add the four `response_*` lines:

```yaml
review:
  permissions:
    contents: read
    issues: read
    pull-requests: write
    actions: write
  uses: mnaimfaizy/agent-kit/.github/workflows/agent-review-reusable.yml@<tag>
  with:
    # ...the review inputs you already pass...
    response_mode: ${{ vars.CLAUDE_REVIEW_RESPONSE_MODE || 'manual' }}
    response_workflow: .github/workflows/agent-review-response.yml
    # The handoff counts findings with the round's own lists: keep these equal
    # to the Review response Caller's allowlist_actors and reviewer_logins.
    # Empty, they fall back to this job's allowlist_actors and github-actions.
    response_allowlist_actors: '["your-github-login"]'
    response_reviewer_logins: "[]"
```

**The Review response Caller** passes `response_mode` too, and has a `workflow_dispatch` trigger with a `pr_number` input. The [example Caller](../examples/review-response-caller.yml) has both:

```yaml
on:
  pull_request:
    types: [labeled]
  workflow_dispatch:
    inputs:
      pr_number:
        description: "Pull request number (set by the review handoff)"
        required: true
```

The `|| 'manual'` fallback matters: `agent-kit doctor` treats a variable read without one as required, and an unset mode is the normal manual case. `agent-kit doctor` checks the rest of this wiring once the mode is `auto`.

The rules of auto mode:

- **Only the handoff's dispatch is accepted.** The gate accepts a `workflow_dispatch` run only from `github-actions[bot]` as both actor and triggering actor, only on the default branch, and only in `auto` mode. A person's dispatch, or re-run of a dispatched round, is refused in every mode, and its run log points to the label. A dispatched round skips the Allowlist actor check (the bot is on no Allowlist) and consumes no label; guidance still comes only from the Allowlist.
- **At most two rounds per pull request**, counted by the summary comments `github-actions[bot]` posted, so rounds started with the label count too. After two, the handoff says so on the pull request once and starts no more. Apply the label to run another round by hand.
- **A round never starts a review.** Two agents of one model family reviewing and answering each other converge on agreement, which is the failure to avoid. Apply `agent:review` yourself when you want a fresh review.
- **The handoff never runs on** a fork pull request, one into any branch but the default, or a Dependabot pull request.
- The dispatched round waits for the review run to end, in the shared concurrency group. If another run queued on the pull request meanwhile replaces it, no round reports; the handoff's comment says to apply the label then. If GitHub refuses the dispatch (no such Caller on the default branch, or no `workflow_dispatch` trigger with `pr_number`), the handoff says so on the pull request and in an error annotation, and the review run stays green.

## Refusals and protected paths

No round runs, and the pull request gets a comment saying why, on:

- a pull request from a **fork**: its branch is not this repository's to push to, and a fork run gets no secrets. The example Caller also skips fork pull requests before any run starts;
- a pull request **into any branch but the default one**;
- a **Dependabot** pull request (author `dependabot[bot]` or a `dependabot/` branch): a round builds the pull request, which would run a package version nobody has read beside the subscription token;
- a pull request whose branch name has characters outside `A-Z`, `a-z`, `0-9`, `.`, `_`, `/` and `-`;
- a pull request that **changes a protected path**. Address that review by hand.

A login not on the Allowlist that applies the label gets a comment saying so. A pull request with no unresolved findings gets "nothing to address".

The **protected paths** are fixed by the kit: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.mcp.json`, `.claude.json` and `.gitmodules` at any depth; `.claude/`, `.agents/skills/` and `.husky/` at any depth; `.github/agent-runtime/`; and every Kit-owned path. They are the files that steer the agent itself, so a round would otherwise take its instructions from the change under review. Comparisons ignore case and trailing dots and spaces, as a case-insensitive checkout sees the path. `extra_protected_paths` adds plain paths from the repository root (one per line or comma-separated; no globs, `!`, `.` or `..`). Nothing can remove a path from the list.

A round never commits to a protected path or to `.github/workflows/` either: the job token cannot push a workflow change. A finding that needs one is declined. One commit that breaks this rule fails validation, and none of the round's commits are pushed.

## Steer a finding

Reply on the finding's thread. On the next round, a reply by a login in the Caller's `allowlist_actors` reaches the agent as **Maintainer guidance** for that finding only: "use the second option", "this is intended, decline it", "fix it in the helper instead". Replies by anyone else are dropped before the agent sees them, whatever they say: anyone can reply on a public pull request. With an empty `allowlist_actors`, no reply is guidance. The reviewer's own follow-up replies on its threads reach the agent as part of the Finding.

Then apply `agent:address-review` again (in auto mode, the next review that leaves findings hands off on its own).

The flow keeps no state of its own. GitHub's thread state is the memory:

- A **resolved** thread drops out.
- Every reply a round posts ends with a verdict marker (`<!-- address-pr-review verdict=fixed -->`). A thread whose last trusted comment (the reviewer's, an Allowlist maintainer's, or the round's own) carries one is **answered**: it stays off the Work list until the reviewer or a maintainer replies again.
- A finding that an earlier round reported `fixed` and is still open **persists**: the reviewer or a maintainer did not accept the fix. In CI it is declined with that note and never tried a second time; run by a person, it goes to the batched question.
- In CI nobody can answer the batched question, so a finding that would go into it is **declined**, with the question and the agent's recommendation in its reply. Your reply on that thread is the answer, next round.

## The resolution rule

A thread is resolved only when the commit its `fixed` Verdict names was pushed by this round **and** changes the file the finding is on. A resolved thread then always means something changed where the reviewer pointed. Everything else gets a reply and stays open for you or the reviewer:

| Outcome on the summary                       | When                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Fixed, resolved                              | `fixed`, and the pushed commit changes the finding's file                                                 |
| Reported fixed in another file, left open    | `fixed`, and the pushed commit changes other files only                                                   |
| Already addressed, left open                 | `addressed`: nothing changed                                                                              |
| Declined, left open                          | `declined`, with the reason or the question                                                               |
| Claimed fixed, not verified — left untouched | `fixed`, but the commit is not one this round pushed (or touches a refused path): no reply, no resolution |
| No verdict — left untouched                  | the agent wrote no entry for it                                                                           |
| Publishing failed, see the run               | GitHub refused the reply or the resolution (a locked conversation, a deleted thread); the job then fails  |

Each round posts one summary comment, starting with `<!-- agent-review-response -->`, with counts, the table above per finding, how many findings were over the limit of 20 and left for the next round, why commits were not pushed or CI did not start, and the commits the round ran against and pushed. It holds no text the agent wrote, because its author and marker are what auto mode counts rounds by. A round that fails publishes only what it can prove.

## The `github-actions` caveat

The default reviewer login, `github-actions`, is shared. Every workflow in the repository that posts with the job token posts as `github-actions`, so any such workflow's review thread looks exactly like the kit reviewer's, and becomes a Finding. Anyone able to push a branch can add or change a workflow that posts that way. That person is already trusted: they can change the code directly, so letting their threads become findings gives them nothing new. Anyone who cannot push cannot post as `github-actions`. A repository whose reviewer posts as its own app login should list that login in `reviewer_logins` (and in `response_reviewer_logins` for auto mode) instead.

## What the agent can reach

The respond job builds pull request code, so whatever runs there (dependency code, build scripts, the agent's commands) may reach anything on that runner. The design gives that runner nothing that can write to GitHub. What it does hold is the subscription token, which the agent step needs while pull request code builds, and the read-only job token. See [Security model](security-model.md#review-response) for the full account, and [ADR 0005](adr/0005-review-responder-holds-no-write-credential.md) for the options rejected.
