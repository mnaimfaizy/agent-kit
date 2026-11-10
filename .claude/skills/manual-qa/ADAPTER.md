# QA config and contracts

The repository's facts live in one file at its root, `qa.config.yml`; the skill body names no host. One file serves two skills: `manual-qa` reads `working_dir` and `run:`, and `qa-plan` reads `working_dir`, `plan:` and `hazards`. Each ignores the other's section: a problem in `plan:` never stops a run, and one in `run:` never stops a compose. Both read it through the same reader, `adapter.mjs`, which `qa-plan` owns and `manual-qa` carries a byte-identical copy of.

```yaml
working_dir: tmp/qa # gitignored; reports and their evidence are written here
run:
  target: stack
  surface: web
  stack:
    up: "docker compose up -d"
    migrate: "npm run migrate"
    seed: "npm run seed:qa"
    down: "docker compose down"
  accounts:
    print: "npm run seed:qa -- --print"
    restore: "npm run seed:qa -- --restore --account {id}"
    roles:
      - id: admin
        purpose: "manages members"
      - id: member
        purpose: "an ordinary member"
  version_endpoint: /version
  evidence: { upload: none }
```

## Lookup order and dialects

The first file present is the config: `qa.config.yml`, then `qa.config.yaml`, then `qa.config.json`. A key it does not carry takes its default, never another file's value.

**JSON** is read whole. **YAML** is read in a subset only: block mappings and sequences indented with spaces; plain, single- or double-quoted scalars; flow lists and mappings that open and close on one line; full-line and trailing `#` comments. Every scalar is a string. Tabs, anchors, aliases, multi-line scalars, flow collections spanning lines, escapes inside double quotes, duplicate keys, unknown keys at any level and values of the wrong shape are **problems**: `adapter.mjs` names each with its line (its key path in JSON) and exits 1, and the skill stops until it is fixed. Write long entries in block style, as `roles` is written above: a formatter wraps a long flow mapping out of the subset.

## Keys

| Key                    | Default     | Meaning                                                                                                                                                        |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `working_dir`          | `tmp/qa`    | Where the report and its evidence are written, relative to the repository root. Keep it gitignored.                                                            |
| `run.target`           | the plan's  | `stack`: a local QA Stack this run starts. `url`: a hosted test environment someone else deployed (this copy of the skill stops on it).                        |
| `run.surface`          | the plan's  | What the scenarios drive: `web`, `desktop`, `mobile` or `api`. The skill finds a tool that can drive it.                                                       |
| `run.stack`            | none: asked | `up`, `migrate`, `seed`, `down`: the QA Stack contract below. All four are needed for `target: stack`.                                                         |
| `run.accounts.print`   | none: asked | The command that prints each role's sign-in values. Needed for `target: stack`.                                                                                |
| `run.accounts.restore` | none        | The command that puts one role's account back as seeded, with `{id}` where the role id goes. Without it, a scenario that needs a restore is left for a person. |
| `run.accounts.roles`   | none: asked | Each role, as `{ id, purpose }`. An id is letters, digits, `_` and `-`, since it goes into `restore`. Every role a plan signs in as must be declared here.     |
| `run.version_endpoint` | none        | A path on the build's own host (`/version`) that names the commit it was built from. Checks the build when `gh` cannot.                                        |
| `run.evidence.upload`  | `none`      | `none`, or `gh-release:<tag>`. This copy of the skill uploads nothing, whatever it says.                                                                       |

## Readiness check

`node "<skill>/adapter.mjs" check --for run --plan <file>` prints the config path, the problems `manual-qa` stops on, the effective values, and `readiness`: what the run still **needs** (asked for) and **notes** (said, and the run goes on). The plan's Run brief fills a target or surface the config leaves out; when the two disagree, the person is asked which this run uses. It needs a target, a surface and the roles, every role the plan signs in as declared, and, for `target: stack`, the four stack commands and `accounts.print`.

The skill asks for what is missing, runs on the answers given in chat, and saves them only when the person says yes. `adapter.mjs render < answers.json` prints the new body of the config the lookup found, in its own dialect, or of a new `qa.config.yml` when there is none, with the answers merged in (`run` key by key, so give a whole `stack` or `accounts` mapping) and every other key kept. YAML comments are not kept. It refuses over a problem in `run:`, a YAML syntax problem, or one in the keys both skills read; a problem in `qa-plan`'s `plan:` is carried over as it is, for `qa-plan` to report. `render --write` writes it. Nothing is assumed.

## The QA Stack contract

The repository provides four commands, run from its root:

- **`up`** starts the application and everything it needs, locally. It may return at once (containers started in the background) or keep running; the skill records the processes it starts.
- **`migrate`** brings the database schema up to date.
- **`seed`** creates the QA Accounts (below).
- **`down`** stops what `up` started, and nothing else: no volume, container or process the developer had running before.

## The QA Account contract

A **QA Account** is a role's sign-in on a test system. The repository's seeder meets these requirements; the kit cannot inspect a seeder, so they are a documented contract, and the host rule below is the half the skill enforces.

- **Fixed public values, from tracked source.** Each role's email and password are derived from code in the repository, the same on every machine: fixtures, not secrets. Even so, they never go into a QA Plan or a QA Report.
- **Reserved-domain emails**, `*.test` (`admin@example.test`), so no message can reach a real mailbox.
- **`seed` is idempotent**: run twice, it leaves the same accounts.
- **`seed` refuses any non-local database, with no override.** It checks the database host before writing and exits non-zero for anything but a local one. No flag or variable turns that off: an override is how fixture accounts with public passwords reach production.
- **`print`** prints each role's id, email and sign-in values, for the skill to read.
- **`restore --account <id>`** puts one role's account back as seeded (a changed password, a deleted profile), touching no other account.
- **Named roles**, each with a purpose, matching `run.accounts.roles`.

## The host rule

`node "<skill>/adapter.mjs" host <address>` decides whether a run may sign in at an address. A `stack` run signs in only to a local development host: `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` or `*.test`. Anything else is a stop (exit 1), as is an address that carries a user name or password.

## Capture rules

A QA Plan's Run brief inlines the _Capture rules_ of every Hazard pack that matched the change (`qa-plan` copies them in). `manual-qa` obeys them while it captures evidence, without opening the packs: the plan alone is enough.
