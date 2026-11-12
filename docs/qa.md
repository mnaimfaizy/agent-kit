# QA: qa-plan and manual-qa

This guide covers manual QA of a pull request before it merges, with two Portable skills joined only by a file. A developer runs `/qa-plan` and gets a **QA Plan**: only the **Residue**, the manual verification a passing CI run would not establish. A QA team, in the same room or elsewhere, gives that plan to `/manual-qa`, which runs it as written and writes a **QA Report**. The QA terms in **bold** in running text (**QA Plan**, **Residue**, **QA Account**, **QA Stack**, **Hazard pack**, **Execution record**, **QA Artifact**, **QA Report**) are defined in [GLOSSARY.md](../GLOSSARY.md); a bold lead-in on a list item is emphasis only. Why QA is two skills: [ADR 0003](adr/0003-qa-is-two-skills-joined-by-a-copied-plan-format.md).

Each skill's own files are the reference; this page is the walkthrough:

- `qa-plan`: [`SKILL.md`](../.claude/skills/qa-plan/SKILL.md), the plan format [`ANATOMY.md`](../.claude/skills/qa-plan/ANATOMY.md), config keys and Hazard packs [`ADAPTER.md`](../.claude/skills/qa-plan/ADAPTER.md).
- `manual-qa`: [`SKILL.md`](../.claude/skills/manual-qa/SKILL.md), its `run:` keys, the QA Stack and QA Account contracts, the host rule and posting [`ADAPTER.md`](../.claude/skills/manual-qa/ADAPTER.md).
- Templates to copy: [`examples/qa.config.yml`](../examples/qa.config.yml) and the sample Hazard pack in [`examples/qa-hazards/`](../examples/qa-hazards/).

Both skills are User-scope: they work from your own skills directory as well as from a repository that adopted the kit ([Install individual skills](install-skills.md)). Both need Node 22 or later, and both are run by hand; no First-class flow runs them.

## The handoff

1. **The developer opens a pull request.** `qa-plan` refuses to compose without one: it stops on the default branch, a detached head, a branch with no open pull request, or a local `HEAD` that is not the pull request's head. A QA Plan is about one pull request at one head.
2. **The developer runs `/qa-plan`.** It reads `qa.config.yml` ([readiness check](#readiness-check)), fixes the anchors (subject issue, pull request, merge-base, head), and runs each configured suite at the head and at the merge-base with `two-point.mjs` to see what automation already proves. A test that passes at the merge-base, or a new test, failing at the head is a regression: it stops, and no plan is written until that is fixed. Every coverage claim is tagged `[observed]` (compared test by test from JUnit XML) or `[reconstructed]` (exit code only, CI results, the diff or the issue history). What no suite proves becomes a scenario, each quoting the real labels from the code the pull request ships, with the _Rule out first_ list of every [Hazard pack](#hazard-packs) that matched.
3. **An empty Residue is a result.** When every promise is covered, `qa-plan` writes no plan and recommends merging without one.
4. **The developer confirms and delivers.** The draft is composed in `working_dir` (gitignored, never committed), checked with `adapter.mjs plan`, and shown. Only on a yes does it go where `plan.publish` says: kept as a working copy for the developer to hand on, one tracker issue per subject, or one pull request comment. A revision edits the delivered plan; it never adds a second.
5. **The QA team gets the plan, not the repository.** The plan's _Run brief_ carries what a run needs: the target kind, the surface, the build (head SHA and version endpoint), the roles by id and purpose, where role values come from, and the inlined _Capture rules_. No credential travels with a plan, not even a public QA Account's: `manual-qa` refuses a plan that carries one.
6. **The QA person runs `/manual-qa` on the plan**, pasted, attached or at a path. It never composes: with no plan, it stops and names `/qa-plan`. It checks the plan against the format, reads the `run:` section of `qa.config.yml` when there is a repository, and checks the build against the plan's head: with `gh`, the pull request's head; otherwise the version endpoint; otherwise the report opens with **build not verified against plan**. A pull request whose head has moved makes the plan stale, and the run stops.
7. **It runs each scenario as written**, against a local QA Stack or a hosted test URL ([targets](#targets-and-the-host-rule)), and records PASS, FAIL or _left for a person_. Only a person passes a _left for a person_ scenario. If an outcome under the plan's _Stop and do not merge if_ occurs, it stops there and says so.
8. **It writes the QA Report** in `working_dir`, with an evidence folder, whether or not anything is posted. Posting to the pull request or the plan's tracker issue, and uploading **QA Artifacts**, happen only after the QA person has seen the results and said yes ([posting](#posting-and-qa-artifacts)).

A QA team with no checkout can run a `url` plan from a folder outside every repository; then there is no `qa.config.yml`, and the run's target, surface and roles come from the plan's Run brief and the answers the QA person gives in chat.

## qa.config.yml

One file at the repository root, with one section per skill. `qa-plan` reads `working_dir`, `plan:` and `hazards`; `manual-qa` reads `working_dir` and `run:`. A problem in `plan:` never stops a run, and one in `run:` never stops a compose. Start from [`examples/qa.config.yml`](../examples/qa.config.yml), which shows every key; the defaults and meanings are in each skill's `ADAPTER.md`.

- **Lookup:** `qa.config.yml`, then `qa.config.yaml`, then `qa.config.json`; the first one present is the config, and a key it does not carry takes its default, never another file's value.
- **YAML subset:** block mappings and lists indented with spaces, quoted or plain scalars, one-line flow lists and mappings, and `#` comments. Every scalar is a string. Tabs, anchors, multi-line values, a flow collection spanning lines, duplicate keys, unknown keys and values of the wrong shape are _problems_, named with their line. A formatter can wrap a long flow mapping across lines and out of the subset, so write long entries in block style. JSON is the dialect for anything the subset cannot say.
- **No hosted address and no sign-in value** belong in it: no key holds either.

The keys, in short:

| Section   | Keys                                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| both      | `working_dir` (default `tmp/qa`; keep it gitignored)                                                                                                                 |
| `plan:`   | `base_ref`; `suites` (`name`, `command`, `junit`, `surfaces`); `publish` rules (`when_label` or `default: true`, `to`, `label`); `tracker`                           |
| `hazards` | a list of `{ pack: <path> }`                                                                                                                                         |
| `run:`    | `target`; `surface`; `stack` (`up`, `migrate`, `seed`, `down`); `accounts` (`print`, `restore`, `roles` of `{ id, purpose }`); `version_endpoint`; `evidence.upload` |

Suite commands run in the platform's default shell: `cmd.exe` on Windows, `/bin/sh` on Linux and macOS. For one config across both, keep each `command` to a program and its arguments chained with `&&`, and put anything more in a script in the repository ([which shell runs `command`](../.claude/skills/qa-plan/ADAPTER.md#which-shell-runs-command)).

A few rules the reader enforces that are easy to miss: `plan.tracker` defaults to `none`, and a `tracker-issue` or `pr-comment` rule with no `tracker` set is a problem; a rule after a `default: true` rule is never reached, which is a problem; `label` is allowed on a `tracker-issue` rule only; `accounts.restore` must contain `{id}`; a role id is letters, digits, `_` and `-`; `version_endpoint` is a path on the build's own host (`/version`), not a URL; `evidence.upload` is `none` or `gh-release:<tag>`.

## Readiness check

Each skill starts by asking `adapter.mjs` what it still needs. `<skill>` is the skill folder's absolute path, with forward slashes, in double quotes.

```bash
node "<skill>/adapter.mjs" check --for plan
node "<skill>/adapter.mjs" check --for run --plan "<plan file>"
```

Each prints the config path, its `problems`, the effective values with defaults applied, and `readiness`: _needs_ (asked for) and _notes_ (said, and the skill goes on). Exit 1 means problems (for `--for run`, a problem in the plan too); fix them before going on. Exit 2 is a usage error.

- `--for plan` needs `plan.base_ref` and at least one suite. A suite with no `junit` is a note: its claims stay `[reconstructed]`.
- `--for run` needs a target, a surface and the roles, with every role the plan signs in as declared. The plan's Run brief fills a target or surface the config leaves out; when the two disagree, the QA person is asked which this run uses. `target: stack` also needs the four stack commands and `accounts.print`. `target: url` needs neither, and notes that the address is asked in chat. A missing `accounts.restore` or `version_endpoint` is a note.

A missing file is not an error: the skill lists exactly what it needs, asks in one message, and works on the answers given in chat. It writes them into the config only when you say yes: `adapter.mjs render < answers.json` prints the new body (the file the lookup found, in its own dialect, or a new `qa.config.yml`), with the answers merged in and every other key kept, and `render --write` writes it. YAML comments are not kept, so when the file has any, `--write` stops first and the skill asks whether to drop them (`--write --drop-comments`). Nothing is assumed.

## Targets and the host rule

A run has one of two targets:

- **`stack`**: a local **QA Stack** this run starts. `manual-qa` runs `up`, `migrate` and `seed` from the config, records the processes it starts, reads role values from `accounts.print`, and at the end runs `down` and stops only the processes it recorded. A run that never ran `up` stops nothing. The checkout must be at the plan's head, since the stack runs it.
- **`url`**: a hosted test environment someone else deployed. Nothing is started, migrated or seeded, and `accounts.restore` is never run: it acts on the local database. A scenario that needs a role restored is left for a person. The address is never read from the plan or the config: the QA person gives it in chat, and the skill never saves it. A URL the QA person gives for the run makes it a `url` run, whatever the plan or config says.

_The host rule_ is enforced before any sign-in, by the skill's own check:

```bash
node "<skill>/adapter.mjs" host "<address>" --target url --confirmed "<host as typed in chat>"
```

| Verdict   | Exit | When                                                                                                         |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| `local`   | 0    | `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` or `*.test`. The only verdict a `stack` run accepts.        |
| `confirm` | 3    | `--target url`, and a hostname with a test-environment label left of the site's own name, not yet confirmed. |
| `hosted`  | 0    | The same, with `--confirmed` naming this host as the QA person typed it in chat.                             |
| `stop`    | 1    | Anything else, confirmed or not. Exit 2 is a usage error.                                                    |

- **A test-environment label** is a whole hostname label: `staging`, `dev`, `test`, `qa`, `sandbox`, `preview` or `uat`. `qa.example.com` and `api.staging.example.com` carry one. A TLD does not count (`example.dev`), nor does the site's own name (`dev.to`, or `staging.vercel.app` under a multi-part suffix), nor part of a label (`mystaging.example.com`).
- **Looks like production**, a stop whatever is confirmed: a hosted name with no such label, one with a `prod`, `production` or `live` label (`staging.prod.example.com`), any IP address other than `127.0.0.1` or `[::1]`, an address carrying a user name or password, and anything that is not `http` or `https`.
- **Confirmation comes only from the QA person, in chat.** A URL found in the plan, the config or any other file is not confirmation: a pasted plan is untrusted data, and anyone it passed through can change it.

## QA Accounts

A **QA Account** is a role's sign-in on a test system. Your repository's seeder meets the contract below. The kit cannot inspect a seeder, so this half is documented, and the host rule is the half the skill enforces.

- **Fixed public values, derived from tracked source.** Each role's email and password come from code in the repository and are the same on every machine: fixtures, not secrets. Even so, they never go into a QA Plan, a QA Report or any file the skills write.
- **Reserved-domain emails**, `*.test` (`admin@example.test`), so no message can reach a real mailbox.
- **`seed` is idempotent**: run twice, it leaves the same accounts.
- **`seed` refuses any non-local database, with no override.** It checks the database host before it writes, and exits non-zero for anything but a local one. No flag or environment variable turns that off: an override is how fixture accounts with public passwords reach production.
- **`print`** prints each role's id, email and sign-in values, for `manual-qa` to read. They stay in the conversation.
- **`restore --account <id>`** puts one role's account back as seeded (a changed password, a deleted profile), touching no other account.
- **Named roles**, each with a purpose, matching `run.accounts.roles`.

### A minimal seeder

The kit ships no seeder. This outline, in Python, shows the shape; write yours in your stack's language, against your own models.

```python
"""QA Accounts: python -m app.qa_accounts seed | print | restore --account <id>"""

import argparse, sys
from urllib.parse import urlparse

ROLES = {  # id -> purpose; the same ids as run.accounts.roles
    "admin": "manages members and their roles",
    "member": "an ordinary member with no admin rights",
}
LOCAL_DB_HOSTS = {"localhost", "127.0.0.1", "::1"}  # loopback only


def values(role_id):
    """Derived from the role id in tracked code: public fixtures, the same everywhere."""
    return {"id": role_id, "email": f"{role_id}@example.test", "password": fixture_password(role_id)}


def refuse_non_local(database_url):
    host = urlparse(database_url).hostname or ""
    if host not in LOCAL_DB_HOSTS and not host.endswith(".localhost"):
        sys.exit(f"qa_accounts: refusing to write to a non-local database ({host})")  # no override


def seed(db):
    for role_id in ROLES:
        upsert_user(db, **values(role_id), role=role_id)  # idempotent: create or reset


def restore(db, role_id):
    if role_id not in ROLES:
        sys.exit(f"qa_accounts: no role {role_id!r}")
    upsert_user(db, **values(role_id), role=role_id)  # this account only


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["seed", "print", "restore"])
    parser.add_argument("--account")
    args = parser.parse_args()
    if args.command == "print":
        for role_id in ROLES:
            print(values(role_id))
        return
    refuse_non_local(settings.DATABASE_URL)  # before any write
    db = connect(settings.DATABASE_URL)
    seed(db) if args.command == "seed" else restore(db, args.account)
```

`fixture_password`, `upsert_user`, `connect` and `settings` are yours. `fixture_password` is a fixed function of the role id in tracked code: anyone with the repository can compute it, which is the point. Keep the local-host list to loopback names, and check the host before opening any write. A bare service name such as `db` is not safe to add: it is also a common name for a production database host on a private network, so it would let the seeder write there. If the seeder runs inside a container whose database is another service, run it from the host against the database's published loopback port instead.

The config then names the three commands, as in [`examples/qa.config.yml`](../examples/qa.config.yml): `seed` under `run.stack`, `print` and `restore` (with `{id}`) under `run.accounts`.

### Role values on a hosted environment

A `url` run signs in to an environment this run did not seed. Its role values come from, in order:

1. **The environment's owner ran the same seeder inside it.** Its database is then local to the seeder, the contract holds there too, and the values are the fixtures `accounts.print` prints from the repository. The skill asks the QA person whether that is so, and runs `print` only on a yes.
2. **Otherwise, the QA person types each role's test values into chat** for that environment. A QA team with no repository asks the developer: for each role id in the plan's Roles, the developer runs `print` (or reads the values the environment was seeded with) and sends them to the QA person directly, never in the plan, a tracker comment or a file.

Values are never read from an env file, and never production credentials. An account is registered by hand only when registration is the scenario under test, or when a scenario's **Creates:** says so.

### Scenario accounts

Some scenarios create an account that a later one acts as: an `admin` adds a user with a temporary password, and the new user changes it. That account is a **Scenario account**. The creating scenario names it with **Creates:**, and a later scenario names it as the first word of **Signs in as:**:

```markdown
### S1: An admin adds a user with a temporary password

- **Signs in as:** `admin`
- **Creates:** `temp-user` (its values chosen when S1 creates it)

### S2: The new user must change the temporary password

- **Signs in as:** `temp-user` (created in S1)
```

`adapter.mjs plan` refuses a sign-in as an account no earlier scenario creates, and a created id that is a role or `nobody`. When S1 does not pass, `manual-qa` leaves S2 for a person and says why. The values the tester chooses in S1 stay in the conversation, like a QA Account's: never in the plan, the report or the evidence. Nothing seeds, restores or deletes a Scenario account. The QA Report lists each one the run created, by id only, so the owner of a hosted environment can remove it; on a `stack` run, `down` takes it with the stack.

### Multi-session scenarios

Some scenarios need two people signed in at once: an `admin` sets a new password for a `user` who is signed in elsewhere, and the user's session must end. Each signed-in identity is a **Session**, with cookies and storage no other session shares. Such a scenario names its sessions with **Sessions:** in place of **Signs in as:**, and every step names the session it runs in:

```markdown
### S3: An admin's password reset ends the user's session

- **Why only a human can prove it:** no suite holds two signed-in browsers at once.
- **Sessions:** A = `user`, B = `admin` (each in its own browser)
- **Steps:**
  1. In session A, open **Profile**.
  2. In session B, open **Users**, pick the user, and click **Set password**.
  3. In session A, reload **Profile**.
- **Expected result:** session A shows **Sign in to continue**; session B still shows **Users**.
- **A failure means:** an admin's reset leaves the user's old session working.
```

Session names are single capital letters. Each id follows the **Signs in as:** rule: a Run brief role, `nobody`, or a Scenario account an earlier scenario creates. `adapter.mjs plan` refuses a scenario with both fields or neither, a lowercase or repeated session name, an id **Signs in as:** would refuse, and a step that names no session or an undeclared one, each with its line.

`manual-qa` runs it only with a driver that keeps the sessions apart: an isolated browser context per session (such as separate Playwright contexts), or a different browser for each (such as the host's built-in browser and Claude in Chrome). Tabs in one browser profile share cookies, so the second sign-in overwrites the first, and the user's tab can refresh into the admin's session. A second frontend origin in front of the same API host shares the API's cookies too. Without such a driver, the scenario is left for a person and the rest of the run goes ahead. Every session signs in at the run's one checked address. The QA Report's **Run** names each session's driver, and the result's note says which session saw what, by letter and id.

## Hazard packs

A **Hazard pack** is a Markdown file your repository owns, naming one area where QA is easily fooled: sign-in, payments, caching, time zones. List each one under `hazards` in `qa.config.yml`. Start from the sample, [`examples/qa-hazards/sign-in.md`](../examples/qa-hazards/sign-in.md):

```markdown
---
when: ["backend/auth/**", "**/*login*"]
---

# Sign-in hazards

## Rule out first

- A session left over from an earlier run: sign out, or use a fresh profile.

## Capture rules

- Never capture the password field, or a screen showing a one-time code.
```

- **`when:`** (required, the only frontmatter key): globs over repository-relative paths, matched against the whole path. `**` spans directories; `*` and `?` stay inside one. Braces and character classes are not special: `[Ll]ogin*` matches only a literal `[Ll]`, so list both spellings as separate globs. Keep the line short enough that a formatter does not wrap it.
- **Rule out first** (required): `qa-plan` copies it into each scenario that touches a matched path, as _If this fails, first rule out_.
- **Capture rules** (required): `qa-plan` inlines them into the plan's Run brief, and `manual-qa` obeys them while it captures evidence, without opening the pack. The plan alone is enough.

A pack applies when any path the diff changes matches one of its globs. To see which apply to a change:

```bash
git diff --name-only <merge-base> HEAD | node "<skill>/adapter.mjs" hazards
```

It prints each matching pack, the paths it matched and both sections. A pack that is missing, has no `when:`, carries another frontmatter key, or lacks a section or leaves one empty is a problem, and `qa-plan` stops on it (exit 1).

## Posting and QA Artifacts

The QA Report file is always written and is the whole result until the QA person, having seen it, says to post. Posting needs `gh` access and goes where the plan went, by the same `plan.publish` rules (`adapter.mjs delivery`):

- **`working-copy`:** nothing is posted; the file is handed on.
- **`pr-comment`:** one pull request comment whose first line is `<!-- qa-report -->`, edited on a re-run, never posted twice. A marker comment someone else wrote is never edited.
- **`tracker-issue`:** the plan's issue, found through the pull request's `<!-- qa-plan-link -->` comment. Each scenario's Sign-off box is ticked when it passed and cleared otherwise, and the Execution record is filled in.

**QA Artifacts** (screenshots, recordings, logs) are captured only where a written result is not enough, and stay in `working_dir` unless `run.evidence.upload` is `gh-release:<tag>`. Then only the files the QA person picks, one by one, go to that prerelease; screenshots and recordings from a failed run never do; archives, PDFs and traces stay local; and on a public repository the person is warned first that anyone can download a release asset. `report.mjs` refuses any posted text or picked text file that looks like it carries a sign-in value. The full rules: [`manual-qa`'s ADAPTER.md](../.claude/skills/manual-qa/ADAPTER.md#qa-artifacts-and-posting).
