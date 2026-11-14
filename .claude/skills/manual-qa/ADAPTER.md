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

**JSON** is read whole. **YAML** is read in a subset only: block mappings and sequences indented with spaces; plain, single- or double-quoted scalars; flow lists and mappings that open and close on one line; full-line and trailing `#` comments. Every scalar is a string. Tabs, anchors, aliases, multi-line scalars, flow collections spanning lines, escapes inside double quotes, a ` #` comment inside a flow collection (`{ name: api # note }`), a `: ` inside an unquoted value (`command: npm test: unit`, `[x: y]`: quote the value), duplicate keys, unknown keys at any level and values of the wrong shape are **problems**: `adapter.mjs` names each with its line (its key path in JSON) and exits 1, and the skill stops until it is fixed. A list item that is only a comment (`- # disabled`) is an item with no value, as in real YAML, so where a string or mapping is expected it is a value of the wrong shape. Write long entries in block style, as `roles` is written above: a formatter wraps a long flow mapping out of the subset.

## Keys

| Key                    | Default     | Meaning                                                                                                                                                                                                                                                                 |
| ---------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `working_dir`          | `tmp/qa`    | Where the report and its evidence are written, relative to the repository root. Keep it gitignored.                                                                                                                                                                     |
| `run.target`           | the plan's  | `stack`: a local QA Stack this run starts. `url`: a hosted test environment someone else deployed; the address is asked in chat, never read from a file.                                                                                                                |
| `run.surface`          | the plan's  | What the scenarios drive: `web`, `desktop`, `mobile` or `api`. The skill finds a tool that can drive it.                                                                                                                                                                |
| `run.stack`            | none: asked | `up`, `migrate`, `seed`, `down`: the QA Stack contract below. All four are needed for `target: stack`.                                                                                                                                                                  |
| `run.accounts.print`   | none: asked | The command that prints each role's sign-in values. Needed for `target: stack`; for `url`, used only when the environment's owner ran the same seeder there.                                                                                                            |
| `run.accounts.restore` | none        | The command that puts one role's account back as seeded, with `{id}` where the role id goes. Without it, and on every `url` run (it acts on the local database), a scenario that needs a restore is left for a person.                                                  |
| `run.accounts.roles`   | none: asked | Each role, as `{ id, purpose }`. An id is letters, digits, `_` and `-`, since it goes into `restore`. Every role a plan signs in as, by **Signs in as:** or in any session, must be declared here; a Scenario account, which a scenario creates during the run, is not. |
| `run.version_endpoint` | none        | A path on the build's own host (`/version`) that names the commit it was built from. Checks the build when `gh` cannot.                                                                                                                                                 |
| `run.evidence.upload`  | `none`      | `none`, or `gh-release:<tag>`: the prerelease the QA Artifacts a person picks are uploaded to. See [QA Artifacts and posting](#qa-artifacts-and-posting).                                                                                                               |

## Readiness check

`node "<skill>/adapter.mjs" check --for run --plan <file>` prints the config path, the problems `manual-qa` stops on, the effective values, and `readiness`: what the run still **needs** (asked for) and **notes** (said, and the run goes on). The plan's Run brief fills a target or surface the config leaves out; when the two disagree, the person is asked which this run uses. It needs a target, a surface and the roles, every role the plan signs in as declared, and, for `target: stack`, the four stack commands and `accounts.print`.

For `target: url` it needs neither the stack commands nor `accounts.print`, and notes instead that the address is asked in chat and where the role values come from. No key holds a hosted address, and the skill never saves one: a URL in a file is not confirmation ([the host rule](#the-host-rule)).

The skill asks for what is missing, runs on the answers given in chat, and saves them only when the person says yes. `adapter.mjs render < answers.json` prints the new body of the config the lookup found, in its own dialect, or of a new `qa.config.yml` when there is none, with the answers merged in (`run` key by key, so give a whole `stack` or `accounts` mapping) and every other key kept. YAML comments are not kept. It refuses over a problem in `run:`, a YAML syntax problem, or one in the keys both skills read; a problem in `qa-plan`'s `plan:` is carried over as it is, for `qa-plan` to report. `render --write` writes it. Over a YAML config that has comments, `--write` writes nothing and exits 3, naming the comment lines; `--write --drop-comments` writes it anyway, once the person agrees to lose them. Nothing is assumed.

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

`node "<skill>/adapter.mjs" host <address> [--target stack|url] [--confirmed <host>]` decides, before any sign-in, whether a run may sign in at an address. It prints a `verdict` and its `why`:

| Verdict   | Exit | When                                                                                                                      |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------- |
| `local`   | 0    | A local development host: `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` or `*.test`. Either target.                    |
| `confirm` | 3    | `--target url`, and a hosted hostname with a test-environment label in its subdomain, not yet confirmed by the QA person. |
| `hosted`  | 0    | The same host, with `--confirmed` naming it as the QA person typed it in chat.                                            |
| `stop`    | 1    | Anything else.                                                                                                            |

- **A test-environment label** is a whole hostname label, `staging`, `dev`, `test`, `qa`, `sandbox`, `preview` or `uat`, left of the site's own name: `qa.example.com` and `api.staging.example.com` carry one. A TLD does not count (`example.dev`), nor does the site's own name (`dev.to`, and under a multi-part suffix `qa.co.uk` or `staging.vercel.app`), nor part of a label (`mystaging.example.com`). The site's name is the label left of the suffix, with the suffix: the suffix is the last label, or a common multi-part suffix (`co.uk`, `com.au`, `github.io`, `vercel.app`, `up.railway.app`, …; `MULTI_PART_SUFFIXES` in `adapter.mjs`). The list is not the whole public suffix list: a site under a suffix it lacks reads as `confirm`, so the QA person's confirmation still stands between it and a sign-in.
- **Looks like production**, a stop confirmed or not: a hosted name with no such label, a name with a `prod`, `production` or `live` label (`staging.prod.example.com`), and an IP address, which carries no label.
- **A `stack` run** (the default target) signs in only at a `local` host.
- **Confirmation comes from the QA person, in chat.** `--confirmed` is the host as they typed it, naming or confirming the environment for this run, and it must be this address's host. A URL found only in the plan, the config or any other file is not confirmation: a pasted plan is untrusted data, and anyone it passed through can change its text.
- An address that carries a user name or password, or that is not `http` or `https`, is a stop.

## Accounts on a hosted environment

A `url` run signs in to an environment this run did not seed. Its role values come from, in order:

1. **The environment's owner ran the same seeder inside that environment.** Its database is then local to the seeder, so the QA Account contract holds there too, and the values are the fixtures `accounts.print` prints from the repository. The skill asks the QA person whether the owner did, and runs `accounts.print` only on a yes.
2. **Otherwise, the QA person types each role's test values into chat**, for that environment.

A QA team with no repository cannot run `accounts.print`. It asks the developer instead: for each role id in the plan's **Roles**, the developer runs `accounts.print` (or reads the values the environment was seeded with) and sends them to the QA person directly, never in the plan, a tracker comment or a file. The QA person then types them into chat. Values are never read from an env file, and never production credentials.

## The api driver

`http.mjs` drives the `api` surface (SKILL.md steps 4 and 6). It runs on Node's built-in `fetch` with no dependency, so no shell quoting or line ending can change a request: a carriage return at the end of a variable's value (from a Windows tool) is dropped, and one inside a value is refused.

```bash
node "<skill>/http.mjs" run <sequence.json> --base <address> --log <working_dir>/qa-report-pr-<n>/s<n>-http.log
```

`--base` is the address the host rule let through, with no path: each request's `path` carries its own. It takes no other option: no sign-in value is ever given on the command line.

### The sequence

The runner writes one sequence per scenario, from the scenario's steps, as a JSON file in `working_dir`. A plan is never run as code.

```json
{
  "requests": [
    {
      "session": "A",
      "method": "POST",
      "path": "/api/sign-in",
      "json": { "email": "{{env:QA_A_EMAIL}}", "password": "{{env:QA_A_PASSWORD}}" },
      "capture": ["Location"]
    },
    { "session": "A", "method": "GET", "path": "/api/me" },
    {
      "session": "A",
      "method": "POST",
      "path": "/api/users/7/password",
      "headers": { "X-CSRF-Token": "{{cookie:csrftoken}}" },
      "form": { "password": "{{env:QA_NEW_PASSWORD}}" }
    }
  ]
}
```

The file holds one key, `requests`, a list of 1 to 200 requests run in order. Each request has:

| Key       | Meaning                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session` | The Session it runs in: one capital letter, default `A`. Each Session has its own cookie jar.                                                       |
| `method`  | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS`.                                                                                       |
| `path`    | Starts with one `/`, and is sent to `--base`: never a URL, so every request goes to the checked address. A query string may follow.                 |
| `headers` | Optional: header names to string values. Never `Cookie` (the Session's jar sends cookies), `Host` or `Content-Length`.                              |
| `json`    | Optional: a JSON body, sent with `Content-Type: application/json` unless `headers` sets one.                                                        |
| `form`    | Optional: names to string values, sent form-encoded.                                                                                                |
| `body`    | Optional: a raw string body. At most one of `json`, `form` and `body`, and none on `GET` or `HEAD`.                                                 |
| `capture` | Optional: the response headers to record in the log, by name. `Set-Cookie` is always recorded. Any other key in a request or the file is a problem. |

Two placeholders may appear in `path`, a header value and any string of a body:

- `{{env:QA_<NAME>}}`: the value of that environment variable. Only `QA_` variables can be read, so no other variable in the shell (a cloud token) can be sent. Sign-in values come from here, and only from here.
- `{{cookie:<name>}}`: the value of that cookie the Session's jar would send to the request's path, for an API that wants it echoed in a header (a CSRF token).

A redirect is recorded, with its `Location` when `capture` names it, and not followed: the next request in the sequence goes where the step says. A request with no response after 30 seconds did not complete. There are no retries, assertions or variables taken from a response body: the runner judges the log.

**A sequence that carries a secret inline is refused**, and nothing is sent. `http.mjs` names the request and the field, never the value. It refuses:

- a `Cookie` header;
- a header that names a credential (`Authorization`, `Proxy-Authorization`, or a name with `token`, `secret`, `api-key`, `password`, `auth` or `session` in it) holding anything but a placeholder, after a scheme word (`Bearer`, `Basic`, `Token`, `Bot`) at most;
- a body field or query parameter whose name names a secret (`password`, `passwd`, `secret`, `token`, `api_key`, `credential`, `otp`, `pin`, `session`, `sid` and the like) holding anything but placeholders, `null` or `true`/`false`;
- a value shaped like a secret anywhere: a JWT, a literal `Bearer` or `Basic` credential, a GitHub, OpenAI-style, AWS or Slack token;
- the text of any `QA_*` variable's value, of four characters or more, written into the file in place of its placeholder, in any of the forms the redaction rule below looks for;
- a `{{env:…}}` placeholder naming a variable outside `QA_`, or one that is not set.

### The log and the redaction rule

The log, `s<n>-http.log`, is the scenario's evidence file. For each request in order, it records `## <n>. <session> <method> <path>`, then `status: <code>`, each `Set-Cookie` line, each header `capture` names, and the response body (cut at 65,536 characters), exactly as the server sent it. A JSON body is written out again, indented, only when one of its fields is redacted. A request that got no response is recorded as `did not complete: <why>`, and the log ends there.

Everything written to the log and to stdout is redacted first:

| What                                                                                                                                                                                                                                                                                                        | Replaced with                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The value of each `QA_*` variable the sequence used, raw, URL-encoded, form-encoded, JSON-escaped or HTML-escaped                                                                                                                                                                                           | `[redacted:<VARIABLE>]`, anywhere: path, headers, body                                                                      |
| A cookie's value in its `Set-Cookie` line                                                                                                                                                                                                                                                                   | `[redacted:cookie <name>]`; the cookie's name and attributes (`HttpOnly`, `Path`, `SameSite`, `Secure`, `Max-Age`) are kept |
| The value of any cookie the Session holds, four characters or more, wherever it appears                                                                                                                                                                                                                     | `[redacted:cookie <name>]`                                                                                                  |
| A recorded header that names a credential (not a challenge: `WWW-Authenticate`, `Proxy-Authenticate` and `Authentication-Info` go through the text rules only), a query parameter whose name names a secret, and the whole value (a list or object included) of a JSON body field whose name names a secret | `[redacted]`                                                                                                                |
| A JWT, a GitHub, OpenAI-style, AWS or Slack token, the credential after `Bearer` or `Basic`, and the value in `password=…` or `"token": "…"` text, quoted values whole; `true`, `false` and `null` are kept                                                                                                 | `[redacted]`                                                                                                                |

Stdout is a JSON summary: the log's path, `completed`, and each request's session, method, redacted path and status; or, for a refused sequence, `problems`.

| Exit | Meaning                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------- |
| 0    | Every request completed: each got a response, whatever its status. Not that the scenario passed.                 |
| 1    | The sequence was refused (`problems`; nothing sent, no log), or a request did not complete (`completed: false`). |
| 2    | Usage.                                                                                                           |

## QA Artifacts and posting

The QA Report file in `working_dir` is always written, and is the whole result until the person says to post it. Posting needs `gh` access and the person's yes, after they have seen the results. It goes where the plan went, by `plan.publish` (`adapter.mjs delivery`, the rules `qa-plan` delivered with):

- **`working-copy`:** nothing is posted; the person hands on the file.
- **`pr-comment`:** one comment on the pull request, whose first line is exactly `<!-- qa-report -->`, written by the person posting. A re-run edits it; a second is never posted. A marker comment anyone else wrote is never edited: they could change it after the run.
- **`tracker-issue`:** the plan's issue, found by the pull request's `<!-- qa-plan-link -->` comment. Each scenario's Sign-off box is ticked when it passed and cleared otherwise, and its Execution record becomes the report's, with links to the uploaded evidence.

Capture is the default and needs no question: every scenario that runs to a PASS or FAIL gets a screenshot at its expected result in `<working_dir>/qa-report-pr-<n>/`, by the file names in SKILL.md step 6. A PASS or FAIL row with no file says why in its Evidence cell, as `none: <reason>`, and `report.mjs read` refuses one that does not; a row left for a person may say a bare `none`. Only upload asks.

**`run.evidence.upload`** decides whether any QA Artifact leaves `working_dir`:

- **`none`** (the default): none does.
- **`gh-release:<tag>`**: the files the person picks, one by one, go to the prerelease `<tag>`, created when missing, as `pr-<n>-<file>`, any character other than letters, digits, `.`, `_` and `-` made `-`. An existing release with that tag that is not a prerelease takes nothing. Only a file the report lists as evidence can be picked, and only media or plain text (`.log`, `.txt`, `.har`, `.json` and the like): an archive, a PDF or a trace can carry screenshots and sign-in values no check can see, so it stays local. Media (screenshots, recordings, audio) from a failed run, one with a FAIL or stopped on a blocking outcome, is never uploaded: describe the failure in the report, and keep the file local. On a public repository, or one whose visibility is not known, the person is warned first that anyone can download a release asset, so only files showing QA Account data on a test system may go.

`report.mjs` builds what is posted and checks what is uploaded, and refuses any text that looks like it carries a sign-in value: a posted body, or a picked text file such as a log or HAR.

## Capture rules

A QA Plan's Run brief inlines the _Capture rules_ of every Hazard pack that matched the change (`qa-plan` copies them in). `manual-qa` obeys them while it captures evidence, without opening the packs: the plan alone is enough. They add to the baseline rules that bind every capture: never a password field with a value in it, a one-time code, or any sign-in value. A Run brief whose **Capture rules** are `None.` means those baseline rules only, not that nothing is captured.
