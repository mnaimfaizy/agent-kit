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

1. Look for the open run. A run is open until its board's header carries `Closed <date>`; a run that reads `Closing: ledger PR #n` is still open. The newest folder under `tmp/security-response/` whose board is open is the open run.
2. **An open run:** the mode resumes the open run. Opening while a run is open always resumes it, and never starts a second one. At most one run is open at a time. If more than one board is open, write nothing: name the folders and ask the human which one is current.
3. **No open run, and draft advisories exist:** the mode opens a run. List the drafts with `gh api --paginate "repos/<owner>/<repo>/security-advisories?state=draft"`. Pass the ignore gate above, make the folder (the next free `<run>` name), save each draft to `originals/<GHSA-id>.json`, give each finding its provisional concept id ([Concept ids](#concept-ids)), and write the board and the first `activity.md` entry.
4. **No draft advisories and no open run:** report "nothing to respond to", and stop. The mode writes nothing: no folder, no board, no log.

When the advisory list cannot be read (no access, no network), say so and write nothing. A run is never opened, or "nothing to respond to" reported, on a list the run could not read.

A closed run is read-only, and stays on disk until the human deletes it. The next invocation after a close opens a new run.

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
| Delivery   | One of the [Delivery](#delivery) values; `—` for a row whose Evidence is final.                                                                                                             |
| Record     | One free-text cell that collects the row's transition records as it moves: the fork PR number, the fix SHA, the release tag, `of <canonical id>`, a one-line reason, `in ledger: <status>`. |
| Next       | The row's next step, prefixed `agent:` or `you:`, or `final`.                                                                                                                               |

Rows are ordered by severity, high first, then by advisory. Final rows stay in place, so the table keeps its shape as the work moves.

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

`status` prints the board as it is after the run is opened or resumed, in the local terminal only.

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
