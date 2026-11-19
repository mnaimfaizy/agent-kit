# The run folder

Where a Security Response Run keeps its state, so that `status` can print it and a later session can resume it. Load it before opening, updating or resuming a run.

A Security Response Run is one pass of the maintainer's response to every open draft security advisory, tracked in a private local board with one row per concept id, and closed by writing the findings ledger once every row and every advisory is final. `security-response` is the only skill that writes the run folder. `security-audit` and `security-finding-triage` produce output only, and never read or write it.

## Where the run folder lives

Each run lives in its own folder, `tmp/security-response/<run>/`, inside the repository. `<run>` is the date, `YYYY-MM-DD`, with `.2`, `.3` added when that folder is already there: `2026-11-07`, then `2026-11-07.2`. There is no config key, and no dependency on orchestrate or its config: the path is fixed, so the skill works in a repository that has only the security skills installed.

Before the first write of a run, check that the path is ignored, from the repository root: `git check-ignore -q tmp/security-response/`. When it is not ignored, offer to add `tmp/security-response/` to the root `.gitignore`, and write nothing without a yes. The folder holds advisory bodies and triage detail, so it must never be committable. With a yes, add the line and check again before writing.

When a run opens, warn the human once:

- `git clean -x` deletes the folder, and the run with it.
- A worktree cannot see it: the folder lives only in the checkout that opened the run. Run `security-response` from that checkout.

## Open, resume, or nothing to respond to

Every mode starts here, before it does its own work:

1. Look for the open run. A run is open until its board's header carries `Closed <date>`; a run that reads `Closing: ledger PR #n` is still open. The folder under `tmp/security-response/` whose board is open is the open run.
2. **An open run:** the mode resumes the open run. Opening while a run is open always resumes it, and never starts a second one. At most one run is open at a time. If more than one board is open, which should never happen, resume none and write nothing: name the folders and ask the human which one is current.
3. **No open run, and draft advisories exist:** the mode opens a run. List the drafts with `gh api --paginate "repos/<owner>/<repo>/security-advisories?state=draft"`. Pass the ignore gate above, make the folder (the next free `<run>` name), save each draft to `originals/<GHSA-id>.json`, give each finding its provisional concept id ([Concept ids](#concept-ids)), and write the board and the first `activity.md` entry.
4. **No draft advisories and no open run:** report "nothing to respond to", and stop. The mode writes nothing: no folder, no board, no log.

When no run is open and the advisory list cannot be read (no access, no network), say so and write nothing. A run is never opened, or "nothing to respond to" reported, on a list the run could not read. An open run is still resumed, and reconcile shows its board with the advisory API not checked ([An unavailable source](#an-unavailable-source)).

A closed run is read-only, and stays on disk until the human deletes it. The next invocation after a close opens a new run.

## Reconcile

Reconcile is step one of every mode: after the run is opened or resumed, and before the mode does its own work, the run is checked against GitHub and git, so the board the human reads shows the sources as they are now, and a session days later picks up exactly where the last one stopped. The `reconcile` mode runs it alone. On every reconcile the header's `checked <time>` updates, and the board is rewritten whole with what changed.

### Sources

Each fact on the board is checked against the source that owns it:

| Board fact                   | Source                | Check                                                                                                                                                                       |
| ---------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Advisory list, state, CVE id | advisory API          | `gh api --paginate "repos/<owner>/<repo>/security-advisories?state=draft"`, plus `gh api repos/<owner>/<repo>/security-advisories/<GHSA-id>` for each advisory on the board |
| `fix PR open`                | private fork          | `gh pr list` and `gh pr view` on the advisory's private fork, until publish deletes it                                                                                      |
| `merged`                     | `origin/main`         | `git fetch`, then `git merge-base --is-ancestor <fix SHA> origin/main`                                                                                                      |
| `released`                   | tags                  | `git tag --contains <fix SHA>` lists the recorded tag                                                                                                                       |
| `fixed` (no code)            | the API, where it can | the setting through `gh api` where there is an endpoint for it (a ruleset, say); otherwise the human's report stands                                                        |
| Concept ids already recorded | the findings ledger   | read only, to flag a concept id already there; the Caller's `findings_ledger_path`, otherwise `.security/findings-ledger.md`                                                |

### Who wins

When the board and a source disagree:

- **The source wins** for the facts it owns: advisory state, CVE id, fork PR state, the fix SHA on `main`, and the tag.
- **The board wins** for the facts only it holds: Evidence, fork PR numbers and fix SHAs after the fork is gone, a CVE request, and accepted-risk. A source that no longer shows them (publish deletes the fork, `cve_id` stays empty until a CVE is assigned) changes nothing.

### Moves

Verified moves happen on their own, with no human report:

- `fix PR open` → `merged`, once the fork PR is merged and its fix SHA is an ancestor of `origin/main`. The fix SHA goes into the row's Record.
- `merged` → `released`, once a release tag contains the fix SHA. The tag goes into the row's Record.

A source may also take a row that is not final backward: a fork PR closed without merging takes its row back to `open`, and a `merged` row whose fix SHA is no longer on `origin/main` goes back to `open`, its Record keeping the SHA. An advisory's state and CVE id follow the advisory API.

Judgements never happen on their own: Evidence, Severity, accepted-risk, `fixed` with no check behind it, and approving a publish, a close or a CVE request come only from triage or the human. A human's report of a merge or a release only prompts the check above.

### An unavailable source

When a source cannot be reached (no advisory access, a draft advisory's private fork unreachable, no network for `git fetch`), the board is still shown. The header's `checked <time>` covers the sources the run did read, and the header adds `not checked: <source> unavailable` for each one it could not: `Default branch: main@<sha>, checked <time>; not checked: advisory API unavailable.` Reconcile moves no row on that source. A fork that publish has deleted is not unavailable: it is no longer a source, and the board keeps what it recorded. A row is never moved, and an advisory never dropped, on a source the run could not read.

### Final rows and advisories

Final rows and advisories are not checked again. A source the run reads for something else can still contradict one: a `published` advisory back in the draft list, or a `released` fix SHA no longer on `origin/main`. A contradicted final row stays final, and so does a contradicted final advisory: it goes to the top of Waiting on you, naming what the source now shows, and is logged in `activity.md`. Final values stay final for the run; the entry stays at the top of Waiting on you until the human acknowledges it.

### Rows are never deleted

Reconcile never deletes a row. It only adds rows, and moves them as above:

- A new draft advisory joins the open run, and each of its findings gets a provisional concept id and an `untriaged` row, as on open ([Concept ids](#concept-ids)). Its original is saved to `originals/<GHSA-id>.json`.
- A draft the human made for a row with advisory `none yet` is matched to that row by the concept id in its title or body. A draft with no concept id to match is raised in Waiting on you, for the human to confirm the match.
- An advisory's findings are compared with `originals/<GHSA-id>.json`: a new `F<n>` with no row gets an `untriaged` row. A missing `F<n>` keeps its row, and is raised in Waiting on you.
- A finding whose concept id is already in the findings ledger gets its row as [Concept ids](#concept-ids) says.

### The log

Each correction is logged in `activity.md` as `reconciled: <old> → <new>, checked <how>`, with the row or advisory it is about: `reconciled: fix PR open → merged, checked git merge-base --is-ancestor c2d0bd5 origin/main`. A new row, a contradicted final row and an unavailable source are logged too. One change is not logged: a reconcile that changes nothing but the header's `checked <time>` logs nothing.

## Layout

```text
tmp/security-response/<run>/
  board.md                  the board: the findings and advisories tables, with every transition record
  activity.md               append-only: each transition, with its time, who made it (agent or human), and what was verified
  triage/<concept-id>.md    the security-finding-triage output for one row, saved verbatim
  originals/<GHSA-id>.json  the advisory as first fetched
```

`activity.md` is append-only: an entry is never edited or removed. Each entry starts with the time and `agent` or `human`.

Each advisory is saved to `originals/<GHSA-id>.json` when the run first reads it, and always before any PATCH that rewrites it publicly. A saved original is never overwritten, so it shows what CI or the reporter first filed. Advisory originals live only here: an older copy kept elsewhere by a harness stays where it is as history, and is not moved.

A private-fork clone is not kept in the run folder. The advisory's row on the board records the clone's path, and the clone is removed after the advisory is published.

Nothing in the run folder is committed or sent anywhere: it holds advisory bodies and triage detail. The findings ledger, written when the run closes, is the run's only public projection.

The board is rewritten whole on each change, never edited in part: write the new board beside the old one, then rename it over the old one, so an interrupted write leaves the last whole board in place.

## Concept ids

A draft advisory filed by the audit numbers its findings `F<n>`, each under a `### F<n> — <short title>` heading. When the run opens, and when a new draft joins it, each `GHSA:F<n>` gets a provisional concept id from its title: the title in lowercase kebab-case, the way the findings ledger writes concept ids. Findings with the same id fold into one row, and that row's Advisory cell lists both advisories, short id and finding: `hg89 F2, xmp7 F1`. Findings with different ids stay separate rows, even when they look alike: triage decides whether one is a duplicate.

A provisional id may be renamed until triage. It is final at triage, and stable from then on: a later change of mind is a new concept id, never a rename.

A finding whose concept id is already in the findings ledger still gets its row, `untriaged`, with Record `in ledger: <status>`. The run reads the ledger only; it never edits it before close.

## Landing a triage outcome

`security-response triage <target>` runs the `security-finding-triage` skill on one row, then lands its outcome on the board, so each judgement is kept with its reasons. A standalone `security-finding-triage` run is not picked up: the run lands only the output of a triage it ran itself, and never looks for one elsewhere. To land a judgement made in a standalone run, run `security-response triage <target>`.

Triage lands on a row that is not final. A final row stays final for the run ([Final](#final)).

To land an outcome:

1. The output is saved verbatim to `triage/<concept-id>.md`, under the final concept id. A later triage of the same row is saved beside it as `triage/<concept-id>.2.md`, then `.3`; a saved output is never overwritten.
2. The concept id becomes final: it is the output's **Concept id**. When that differs from the row's provisional id, the row is renamed, and the rename is logged. A regression of a concept id already in the findings ledger takes the new id triage chose. When the output's id is another row's, and its Outcome is not `duplicate`, nothing lands: the run raises it in Waiting on you for the human.
3. Map the Outcome to Evidence and Delivery ([Outcome to Evidence](#outcome-to-evidence)). **Severity (after triage)** becomes the row's Severity, with no `?`; a `duplicate` row's reads `—`.
4. Add the outcome's record to the row's Record: for `rejected`, one public-safe line from the Decision on why, or on what would reopen it; for `duplicate`, `of <canonical id>`.
5. Add a row for each finding the output found in triage ([Found in triage](#found-in-triage)), rewrite the row's Next, Waiting on you and Next (agent), and log the move in `activity.md`: `triaged: untriaged → <evidence>, saved triage/<concept-id>.md`.

The output's Proposed ledger row is kept in the saved file and goes nowhere else: the run's `close` drafts the ledger from it. Triage never edits the findings ledger.

### Outcome to Evidence

| Outcome         | Evidence      | Delivery                                                      |
| --------------- | ------------- | ------------------------------------------------------------- |
| `confirmed`     | `confirmed`   | unchanged: `open` until a fix                                 |
| `rejected`      | `rejected`    | `—`                                                           |
| `below-floor`   | `below-floor` | unchanged: `open` until its hardening lands                   |
| `duplicate`     | `duplicate`   | `—`                                                           |
| `accepted-risk` | `confirmed`   | unchanged: a recommendation ([Accepted risk](#accepted-risk)) |

An `accepted-risk` outcome whose Severity is under the Medium floor maps to `below-floor` instead.

### Duplicates

A finding triage shows to be the same concept as another row, or as a concept id already in the findings ledger, is kept as a `duplicate` row with Record `of <canonical id>`. It keeps its own concept id, its Severity and Delivery read `—`, and its Next reads `final`. It is never deleted or folded into the canonical row, because its advisory still needs closing once the canonical row's advisory is final. The canonical id must be a row on the board or a concept id in the findings ledger; when it is neither, nothing lands, and the run raises it in Waiting on you.

### Accepted risk

An `accepted-risk` outcome is only a recommendation. Its Evidence lands as above, and its Delivery stays as it is until the human records it: Waiting on you gets one item, to accept the risk on the row with `record accepted-risk <concept-id>: <reason>` or to ask for a fix, and the row's Next reads `you: decide accepted risk`. The run never sets the Delivery `accepted-risk` from a triage outcome.

### Found in triage

Each finding in the output's **Found in triage** section enters as a new `untriaged` row, with advisory `none yet`, the severity claimed with a `?`, and Record `found in triage of <concept id>, <date>`: the triaged row's concept id and the triage date. Its own judgement comes from its own triage, `security-response triage <its concept id>`. When its concept id is already a row on the board, no row is added, and the run raises it in Waiting on you.

A found-in-triage row confirmed at Medium or above needs a draft advisory before `fix PR open`, because the private fork that holds the fix lives on the advisory. Until reconcile matches a draft to the row ([Rows are never deleted](#rows-are-never-deleted)), Waiting on you asks the human to create a draft advisory for it, and `fix` refuses the row.

## Board

```markdown
# Security Response Run <run>

Started <date> <time>. Default branch: main@<sha>, checked <time>.

**Waiting on you:**

1. <a human step, naming its pull request, setting or release>

**Next (agent):** <one action, or `nothing until one of the above lands`>

## Findings

| Concept id                                   | Advisory | Severity | Evidence  | Delivery | Record                  | Next             |
| -------------------------------------------- | -------- | -------- | --------- | -------- | ----------------------- | ---------------- |
| `implementer-git-config-write-executes-code` | hg89 F1  | high     | confirmed | merged   | fork PR #1, fix c2d0bd5 | you: cut release |
| `glob-brace-expansion-escapes-pattern-check` | hg89 F2  | medium?  | untriaged | open     |                         | agent: triage    |

## Advisories

| Advisory            | Created    | Rows | State | CVE           | Fork clone             | Next                   |
| ------------------- | ---------- | ---- | ----- | ------------- | ---------------------- | ---------------------- |
| GHSA-hg89-9pp4-v549 | 2026-10-12 | 2    | draft | not requested | ../agent-kit-ghsa-hg89 | wait: 2 rows not final |
```

The header names the run and when it started. Its `Default branch` line is the default branch's name and tip, and when it was last checked; every invocation checks it again. When a source cannot be reached, the line for it reads `not checked: <source> unavailable` (for the default branch, `Default branch: not checked: git unavailable`), and nothing on the board moves on that source.

**Waiting on you:** is a numbered list of the human's steps, each naming the pull request, setting or release it is about, or reads `nothing`. **Next (agent):** is one action, or `nothing until one of the above lands`. Both are rewritten on every update: they are what the human reads first, so nobody has to scan the Next column of every row.

The findings table has one row per concept id:

| Column     | Holds                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concept id | The row's concept id, provisional until triage.                                                                                                                                             |
| Advisory   | Each advisory finding in the row, short id and `F<n>` (`hg89 F2, xmp7 F1`); `none yet` for a finding found in triage with no draft yet; `n/a` for a `below-floor` row.                      |
| Severity   | Before triage, the severity the advisory claims, with a `?` (`high?`); after triage, the triaged severity. `—` for a `duplicate` row.                                                       |
| Evidence   | One of the [Evidence](#evidence) values.                                                                                                                                                    |
| Delivery   | One of the [Delivery](#delivery) values; `—` for a row whose Evidence is `rejected` or `duplicate`.                                                                                         |
| Record     | One free-text cell that collects the row's transition records as it moves: the fork PR number, the fix SHA, the release tag, `of <canonical id>`, a one-line reason, `in ledger: <status>`. |
| Next       | The row's next step, prefixed `agent:` or `you:`, or `final`.                                                                                                                               |

Rows are ordered by severity, highest first (`critical`, `high`, `medium`, then anything below), then by advisory. Final rows stay in place, so the table keeps its shape as the work moves.

The advisories table has one line per draft advisory in the run:

| Column     | Holds                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Advisory   | The full GHSA id.                                                                                                                 |
| Created    | The date the advisory was created.                                                                                                |
| Rows       | How many finding rows it has.                                                                                                     |
| State      | One of the [Advisory state](#advisory-state) values.                                                                              |
| CVE        | `not requested`, `requested <date>`, or the CVE id once assigned.                                                                 |
| Fork clone | The local path of the private fork's clone, or `—`.                                                                               |
| Next       | Why it is not yet publishable (`wait: 3 rows not final`), `close once <canonical advisory> is final` for a duplicate, or `final`. |

`status` prints the board as it is after the run is opened or resumed and then reconciled, in the local terminal only.

## States

### Evidence

What is known about the finding: `untriaged | confirmed | rejected | duplicate | below-floor`.

- `untriaged`: not yet triaged against the current tree.
- `confirmed`: repeatable, safe evidence supports a reachable finding at or above the Medium floor.
- `rejected`: a false positive, or out of the threat model. Its Record gives one public-safe line on why, or on what would reopen it.
- `duplicate`: the same concept as another row. Its Record names the canonical concept id, `of <canonical id>`. The row stays on the board, because its advisory still needs closing.
- `below-floor`: real, but under the Medium floor, so it gets hardening rather than an advisory. It is not `rejected`, which means false.

`accepted-risk` is not evidence: it is a Delivery ending.

### Delivery

What has been shipped: `open → fix PR open → merged → released`, plus `fixed` and `accepted-risk`.

- `open`: no fix yet.
- `fix PR open`: a fix pull request is open on the advisory's private fork. Its Record gives the fork PR number.
- `merged`: the fix is on the default branch and its release is pending. Its Record gives the fix SHA, written before publishing deletes the fork.
- `released`: a release tag contains the fix. Its Record gives the tag.
- `fixed`: done with a change that needs no release (a ruleset or a setting, say).
- `accepted-risk`: the human has decided to accept the risk. Its Record gives one public-safe line on why.

A `below-floor` row uses the same values; its pull request is an ordinary public one.

### Advisory state

Each advisory in the advisories table: `draft → published | closed`.

- `draft`: open, and private.
- `published`: published, through `gh api`, once the human approves it.
- `closed`: closed without publishing, once the human approves it.

A CVE request is recorded beside the state, in the CVE column. GitHub's `cve_id` stays empty until a CVE is assigned, so the board keeps the request itself.

### Final

- **A row** is final when its Evidence is `rejected` or `duplicate`, or its Delivery is `released`, `fixed` or `accepted-risk`.
- **An advisory** is final when its state is `published` or `closed`.
- **The run** can close only when every row and every advisory is final.

A row that is not final may move backward: a closed fix pull request takes it back to `open`, and new evidence takes it back to `untriaged`. Final values stay final for the run: reopening a final row means a new concept id, or the next run.
