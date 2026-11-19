# Security audit First-class flow

This runbook documents the Agent-kit reusable security audit flow. Setup steps: [Getting started](getting-started.md#7-prepare-the-security-audit). Every input and secret: [reference.md](reference.md#security-audit).

## Reusable job

Use:

- `.github/workflows/security-audit-reusable.yml` (job body in Agent-kit)
- Caller example: `examples/security-audit-caller.yml`

The reusable job supports:

- `full` and `pr` modes
- required private delivery to draft GHSA
- optional email notification
- counts-only PR comments in `pr` mode when findings exist
- advisory-token preflight before the agent runs
- credentialed scripts staged outside the workspace and checked by digest
- Read/Grep/Glob confined to the workspace

What the audit agent can and cannot change or run: [Agent limits](plan-implement-review.md#agent-limits).

`pr` mode requires `head_sha`, `base_sha`, `base_ref`, and `pr_number`. The job restores instructions and `.github/agent-runtime/` from the base before the agent starts. `scan_command` runs in `full` mode only. `full` mode audits the commit the run was dispatched on and refuses a `head_sha` or `base_sha`: to audit a pull request, use `pr` mode.

The preflight checks the advisories token is live, then sends an empty body to the create-advisory endpoint. GitHub checks authorization first, so a token that may create advisories gets a validation error (422), which passes, and one that may not gets 403 or 404, which fails the run before the agent starts. Nothing is created.

Publishing retries three times. If it still fails and `notify_email` is on, the job emails the **full report**, with a subject starting `[publish failed]`. The run still fails, because the token needs fixing. Without email, the report is lost and the run must be repeated.

If the agent finishes without writing a report, the job fails with `Empty report`. Before it does, it files a private draft advisory titled `failed run: empty report` whose body is the agent's session transcript and the run link. When `notify_email` is on, it also emails the transcript, with a subject starting `[empty report]`. Both keep the start and the end of a long transcript, since the end shows how the run finished. Close the draft once you have read it. This applies only when the agent step finished and the read-confinement hook was unchanged. If the agent step errors or the hook check fails, nothing the agent wrote is delivered, and the run log is the only record.

Only these two failure emails carry detail that may include findings; the routine notice is counts-only.

Every run that reaches Collect transcript also logs one `Final line:` verdict on whether the agent's last message matched `audit complete: <N> findings`: `matched (<N> findings)`, `(unrecognized)` or `(absent)`. It never shows the message itself.

## Dependabot alert grounding (optional)

In `full` mode the job can hand the agent a summary of open Dependabot alerts (advisory id, package, ecosystem, severity, manifest) so `dependency-advisory` findings are grounded. `GITHUB_TOKEN` has no Dependabot-alerts permission, so this needs the optional `dependabot_alerts_token` secret: a fine-grained PAT with **Dependabot alerts: Read-only**. When it is unset the step logs a skip and the audit continues. The token is never in the agent step's environment.

## Threat pack

The Caller passes two Consumer-owned files:

- `threat_model_path`: assets, trust boundaries, attack paths to walk, out-of-scope areas.
- `findings_ledger_path`: fingerprints of known findings (concept id, status, dates) so repeat runs dedupe. The ledger is committed and public, so it never holds attack paths, evidence, or locations.

Both are restored from the PR base in `pr` mode, so a PR cannot edit the Threat pack that audits it. See this repository's [threat model](../security/threat-model.md) and [ledger](../security/findings-ledger.md) for a worked example.

## Deep mode

`security-audit` has a third mode, `deep`, for a Deep scan. It runs the `full` walk, then builds, runs and probes the repository's own code inside a closed, disposable sandbox, to reproduce each Medium+ finding and to find more along the Threat pack's attack paths. Its procedure is the skill's `DEEP.md`, which `full` and `pr` never read. The reusable job above stays static, with `full` and `pr` only.

- **It runs only in the sandbox the `agent-kit deep-scan` launcher starts.** Invoked from an ordinary Claude Code session on your machine, `deep` builds, runs and probes nothing, and points you to the launcher.
- **It scans the trusted ref**: the whole repository at the default branch, optionally narrowed by path or attack path, never a pull request head.
- **It probes only the Scan recipe's entry points**, inside the sandbox, never a deployed, production or third-party system.
- **Web tools are off.** The agent does not use WebFetch or WebSearch, so no search query shaped by a finding leaves the run. Its grounding is the recipe's `grounding` sources, which `deep-scan` copies in or fetches on your machine before the agent enters (see [What goes into and out of the sandbox](#what-goes-into-and-out-of-the-sandbox)).
- **Only the report leaves the sandbox.** The transcript, shell history, app logs and scratch scripts are destroyed with it.

Each finding gains `Reproduced: yes | no | not attempted`. With `yes`, a prose Observation names the location, the attacker's position, the kind of input in words and the effect seen. With `no` or `not attempted`, a one-line reason. Reproduction never changes severity: the Medium floor holds, a reproduced Low is still dropped, and an unreproduced Medium+ finding is still reported. A deep report also has an `Open questions` section, listing what the agent could not settle, so you can add grounding and run again, and a `Stopped:` header line, written by the launcher, when a limit ended the run. Fields and examples: the skill's `report-format.md`.

A deep report never contains anything runnable: no payload values, encoded strings, exact requests, command sequences, timing tricks, script or step-by-step recipe, in the report or the draft advisory, not even privately ([ADR 0016](adr/0016-security-pocs-are-never-delivered-rather-than-never-produced.md)). You can understand a finding and check a fix from it, but you cannot paste any of it into anything.

Deep findings share concept ids with static runs. An open ledger concept is skipped, with the report's notes saying whether it reproduced. A `rejected` or `accepted-risk` concept comes back only when reproduced, as reopening that decision, and a fixed concept only when reproduced, as a regression. The public findings ledger gains nothing from a deep scan. `security-finding-triage` reads `Reproduced` and the Observation as evidence and stays static.

A **Verification run** re-attempts the Reproduction of known findings on your fix branch, and answers `yes` (the fix does not hold) or `no` (it holds) for each. It reports no new findings, and its report stays on your machine. How to run one: [Verification run](#verification-run).

## Private delivery and public-log rule

- Every successful run must create a draft GHSA with full report details.
- Public PR comments include counts only.
- Logs and artifacts must not include finding bodies.
- The same job applies to public, private, and org repositories.

## Private/org repositories

Use the same reusable job and same required sink (draft GHSA).

If Advisories are disabled in your repository, enable Advisories first. This is Consumer setup, not a separate delivery sink.

## Caller-owned inputs

The Caller owns:

- Threat pack paths (`threat_model_path`, `findings_ledger_path`)
- kill switch
- allowlist policy
- advisories token secret
- optional scanner command (`full` mode only)
- optional email secrets
- optional Dependabot alerts token
- Claude subscription token
- `permissions:` that cover what the reusable job requests (`contents: read`, `pull-requests: write`, `security-events: write`)
- for `pr` mode, the head SHA, base SHA, base ref, and PR number

Triage and response happen after delivery using the shipped skills.

## Scan recipe

A Deep scan needs a **Scan recipe**: one Consumer-owned YAML file, beside the Threat pack and not in it, that says how to build, start and seed your app and what the scan may probe. Agent-kit supplies everything else (the image layering, the sandbox, the network policy, the proxy, the limits and the teardown). The Threat pack is unchanged, so a static-only Consumer never needs a recipe.

- **Where it lives.** `.security/scan-recipe.yml` by default. Pass `agent-kit deep-scan --recipe <path>` (relative to the repository root) to keep it elsewhere, as the Caller's Threat pack paths do.
- **Which copy is read.** The copy committed on the default branch (origin's HEAD, else `main`; name another with `--default-branch <name>`), as your checkout has that branch. Never the working tree, the checked-out branch or uncommitted changes, and never anything from issue or pull request text. Treat it like a Caller workflow: it says what runs.
- **No recipe, no scan.** With no recipe, or an invalid one, `agent-kit deep-scan` refuses, lists every problem with its field, points here, and exits 1. It never falls back to a `full` audit.

```yaml
image: node:22-bookworm # or dockerfile: docker/scan.Dockerfile, never both
setup: # run before the agent enters, with egress limited to registries
  - npm ci
registries: # the setup phase's egress allowlist; [] for none
  - registry.npmjs.org
start: # start the services as processes in the one sandbox
  - npm run start &
ready: # confirm they are up
  - curl --fail http://localhost:3000/health
seed: # optional
  - npm run seed
entry_points: # what the scan may probe, each with a one-line note
  - url: http://localhost:3000/
    note: The web app, signed in or not.
  - command: node bin/cli.js
    note: The CLI, with any arguments.
fixtures: # test users, roles and similar, with fake values only; [] for none
  - user: alice
    password: fake-password-1
    role: admin
grounding: # optional: sources setup fetches before the agent enters
  - https://example.com/framework-security.md
notes: # what stays static-only, so a report never implies it was exercised
  - The GitHub workflows stay static-only.
```

| Field          | Required                                                   | Holds                                                                                               |
| -------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `image`        | one of `image` and `dockerfile`                            | A base image. Agent-kit layers a pinned Claude Code on top.                                         |
| `dockerfile`   | one of `image` and `dockerfile`                            | A Dockerfile's path in the repository. Not a compose file.                                          |
| `setup`        | yes (`[]` for none)                                        | Commands run before the agent enters, without the agent or the model credential.                    |
| `registries`   | yes (`[]` for none)                                        | Hosts the setup phase may reach. The network is cut after setup.                                    |
| `start`        | with `ready`; optional when every entry point is a command | Commands that start the services as processes inside the one sandbox.                               |
| `ready`        | with `start`                                               | Commands that confirm the services are up.                                                          |
| `seed`         | no                                                         | Commands that load test data.                                                                       |
| `entry_points` | yes, at least one                                          | Each one of `url` (http or https), `port` (1 to 65535) or `command`, with a one-line `note`.        |
| `fixtures`     | yes (`[]` for none)                                        | Mappings of test users, roles and similar. Fake values only.                                        |
| `grounding`    | no                                                         | URLs or repository paths `deep-scan` copies in before the agent enters, since it has no web access. |
| `notes`        | yes                                                        | A line or a list of lines: what stays static-only.                                                  |

A command field takes one command or a list of them; `start` and `ready`, when given, are not empty. Lists are block lists, one `- item` per line; only an empty `[]` may be written inline.

The recipe never holds:

- **Limits.** Time, turn and token limits come from `deep-scan`'s options or the deep-scan workflow's inputs (see [Limits](#limits)), so a merged recipe change cannot raise a run's spend. A key such as `limits`, `max_turns`, `tokens` or `setup_timeout` is refused.
- **A compose file, sibling containers or the Docker socket.** Services share the one sandbox and its one boundary. A `compose` or `services` key, a compose file as `dockerfile`, a command that starts a container (`docker`, `podman`), and any mention of `docker.sock` are refused.
- **A real credential.** Values shaped like a GitHub, Anthropic, AWS or Slack token, or a private key, are refused anywhere in the recipe.
- **Anything else.** An unknown key, a key given twice, a top-level line that is not `key: value`, and a line indented under a key that holds a single value are refused.

`agent-kit doctor` reports whether `.security/scan-recipe.yml` is in your working tree and, if so, whether it is valid (a warning when it is not; having none passes). Once the recipe is valid, `agent-kit deep-scan` goes on to the pre-flight checks and the choice of a [sandbox runtime](#sandbox-runtimes).

## Sandbox runtimes

`agent-kit deep-scan` chooses the sandbox runtime itself, or refuses to run. The rule it enforces: **the target never shares a kernel with your host OS or with your other environments** ([ADR 0018](adr/0018-a-deep-scan-runs-locally-by-default.md)). It checks the platform and the backend from the host, through the runtimes' own command-line tools and Docker's list of registered runtimes, and never trusts a check made inside the sandbox, which the target could fake. The checks only read: none of them starts anything.

**Accepted**, in this order of preference (the first one found is used):

1. **Docker Sandboxes** (`sbx`), a microVM per sandbox, on any host where `sbx version` answers.
2. **Kata Containers or Firecracker on Linux**, registered as a Docker runtime (a runtime whose name or path names `kata`, or `kata-fc` or `firecracker`), with `kata-runtime --version` or `firecracker --version` answering. Kata comes first when both are there.
3. **gVisor on Linux** (`runsc`), registered as a Docker runtime, with `runsc --version` answering. It is a user-space kernel, not hardware virtualization, and is accepted on purpose.
4. **Docker Desktop on macOS**, when `docker info` reports `Docker Desktop` on a macOS host.

**Refused**, always:

- **Plain Docker on Linux** (Docker without one of the runtimes above registered), which shares your host's kernel with the target. The refusal says what to install: gVisor, Kata Containers or Firecracker as a Docker runtime, or Docker Sandboxes.
- **Docker Desktop on Windows with the WSL 2 backend.** Its VM shares one Linux kernel and network namespace with your other WSL distros, so the target would share a kernel with them and could reach their network. Use Docker Sandboxes on Windows instead.
- **Anything else**: no runtime found, a Docker daemon that does not answer, Docker on macOS that is not Docker Desktop, Docker Desktop with the Hyper-V backend, Docker Desktop on Linux, and gVisor, Kata or Firecracker on a host that is not Linux.

Every refusal names the accepted runtimes and the CI path, and exits 1. There is **no override**: no flag, setting or variable lets a refused runtime through. On a host without an accepted runtime, use the CI path: the deep-scan reusable workflow runs the scan in a gVisor container on an ephemeral GitHub-hosted runner (see [Deep scan in CI](#deep-scan-in-ci)).

**Pre-flight refusals.** Before it touches any runtime, `deep-scan` also refuses, with exit 1:

- **A GitHub token in its environment.** `GH_TOKEN` or `GITHUB_TOKEN` (in any letter case) set to a value must never reach the sandbox. Unset them for the run, for example `env -u GH_TOKEN -u GITHUB_TOKEN npx @mnaimfaizy/agent-kit deep-scan`. The refusal names the variables, never their values.
- **A `.env` that would be forwarded wholesale.** The sandbox gets a copy of the default branch's whole tree, so a committed `.env` or `.env.<name>` (such as `.env.local` or `config/.env.production`) would go in whole. The refusal lists them, never their contents. Templates (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.default`) are fine, and a `.env` that is only in your working tree is never copied in.

Once a runtime is chosen, `agent-kit deep-scan` runs the sandbox on it: see [What goes into and out of the sandbox](#what-goes-into-and-out-of-the-sandbox).

## What goes into and out of the sandbox

`agent-kit deep-scan` runs the sandbox from image to teardown on the runtime it chose. The agent step is the real Claude Code, behind a key-injecting model proxy on your machine. Your API key never enters the sandbox: see [Credentials](#credentials). In order:

1. **Image.** It pulls the recipe's `image`, or builds its `dockerfile` from the default branch's tree (sent to `docker build` as an archive, never your working tree). Then it layers a pinned Claude Code on top, installed with npm, so the image needs Node.js and npm. The Claude Code auto-updater is off, both by environment and by managed settings in `/etc/claude-code/`, which the repository's own project settings cannot override. A Dockerfile is built by your Docker engine's builder, outside the sandbox runtime, so treat it like the recipe: it is read from the default branch only.
2. **Start.** It starts one sandbox with no mount of any host folder, no host environment variables, no Docker socket and no extra privilege (`no-new-privileges`), under the chosen runtime (`--runtime runsc`, for example).
3. **Copy in.** Into the sandbox go only:
   - an export of the default branch's tip (`git archive`), at `/workspace`: never the working tree, the checked-out branch, uncommitted or untracked files, or a pull request head, and never a mount;
   - the recipe's `grounding`, at `/agent-kit/grounding`: repository paths as committed on the default branch, and URLs fetched by `deep-scan` on your machine, before the agent step.

   Nothing else goes in: no GitHub token, SSH key, cloud config, home folder or `.env`, and no model credential.

4. **Setup.** It runs `setup`, then `start` and `ready`, then `seed`, each command with `sh -c` in `/workspace`, with no agent and no model credential. Egress is limited to `registries`: the sandbox sits on a Docker network with no route out (`--internal`), and its only way out is a proxy that `deep-scan` runs on your machine, which forwards only to the listed hosts (a bare host allows ports 80 and 443; `host:port` or a URL names its port). With `registries: []` the sandbox has no network at all. A failing step ends the run before the agent step, with exit 1, and prints its output (for `start` and `ready`, the services' log too) and any host the proxy refused. That output is your own build output, from before any probing.
5. **Cut the network.** It disconnects the sandbox from the setup network, stops the proxy, and checks from your machine (`docker inspect`), never from inside the sandbox, that no network is left. If one is, the run ends before the agent step.
6. **Open the model route.** The sandbox joins a second `--internal` network, whose only reachable service is the **key-injecting model proxy**, which `deep-scan` runs on your machine on that network's gateway (on `127.0.0.1`, reached as `host.docker.internal`, on Docker Desktop for macOS). It is the scan's only route out. It forwards only the Messages API's `/v1/` paths, and only to `api.anthropic.com`; it refuses any other host, a `CONNECT` tunnel and any other path. It strips the `x-api-key` and `Authorization` headers the sandbox sends and inserts your real key, which lives only in `deep-scan`'s memory. `deep-scan` checks again from your machine that the sandbox is on that network alone; if not, the run ends before the agent step.
7. **Agent step.** It copies in the launcher's brief, to `/agent-kit/in/brief.md`, and runs Claude Code in it, in `/workspace`:
   - with `--bare`, which skips skill and `CLAUDE.md` discovery, so the brief hands it everything: the security-audit skill's `DEEP.md` (the `deep` procedure), with `SKILL.md` and `report-format.md`, the Threat pack (the threat model and findings ledger at the paths your security-audit Caller passes, else `.security/`) and the Scan recipe, all read from the default branch's tip, plus the sandbox's paths: the repository at `/workspace`, each grounding source under `/agent-kit/grounding`, and the report at `/agent-kit/out/report.md`. A run whose default branch has no `DEEP.md` or no Threat pack is refused before any runtime starts;
   - with a non-secret placeholder `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL` pinned to the model proxy by the launcher's own `--settings`, which outrank project settings. Project and local settings are not even loaded (`--setting-sources user`), so a `.claude/settings.json` in your repository cannot point Claude Code anywhere else;
   - with web tools off: WebFetch and WebSearch are not in its tool set (`--tools`), and are disallowed and denied as well. Its tools are Bash, Read, Write, Edit, Glob and Grep, pre-approved, with nothing else asked;
   - within the run's [limits](#limits): the launcher's `--max-turns`, the scan wall clock and the model proxy's token cap.

   Claude Code's own output stays in the sandbox. When the step fails, `deep-scan` prints its exit code and the last lines of its error output, and in every case the model proxy's counts: requests forwarded (by the model API's answer status) and requests refused, never their content. The proxy stops as soon as the agent step ends. In GitHub Actions (`GITHUB_ACTIONS=true`) it prints neither: see [Deep scan in CI](#deep-scan-in-ci).

8. **Copy out.** Exactly one file comes out: that report, refused unless it is a single regular file (no folder, link or second file) of at most 10 MiB. It is written to `report.md` in a new private folder under your temporary folder (or to the new file `--report <path>` names, in a folder that exists), and `deep-scan` prints its path. The transcript, shell history, app logs and scratch files stay in the sandbox and are destroyed with it. Nothing is filed or posted: to file a draft advisory, follow the skill's by-hand rule.
9. **Teardown.** It removes the sandbox, then the model and setup networks and the layered images on every exit path: success, a failed step, and an interrupt (Ctrl+C or `SIGTERM`), which stops the running step first and exits 130 or 143. Each resource carries the label `agent-kit.deep-scan`; if one cannot be removed, `deep-scan` names it and exits 1. The recipe's own base image stays in your image cache.

Those steps are the ones on gVisor, Kata Containers and Firecracker registered as a Docker runtime on Linux, and on Docker Desktop on macOS. **On Docker Sandboxes** (`sbx`) the same lifecycle runs, with these differences:

- **Your global sbx network policy must be deny-all.** `deep-scan` reads it with `sbx policy ls --json` before it starts anything, and refuses, with exit 1, when it is not initialised or not deny-all (any global network allow rule, as `balanced` and `allow-all` have). It never changes your global policy: run `sbx policy init deny-all` yourself. The reason: a per-sandbox rule can only add to the global policy, and a deny always wins over an allow, so on any other policy the setup phase could reach more than `registries`.
- **No build.** The sandbox is created mountless (`sbx create` with no workspace path) from the recipe's `image`, and Claude Code is installed inside it as the first setup step, with only `registry.npmjs.org` reachable for that step. A `dockerfile` recipe is refused, because `sbx` cannot build one.
- **Setup egress** is a per-sandbox `sbx policy allow network` rule for the registries, removed for the cut; `sbx policy ls <sandbox> --json`, read on your machine, then shows no network allow left.
- **The model route** is one more per-sandbox rule, allowing only `host.docker.internal:<port>`, where the model proxy listens on your machine's `127.0.0.1`. `deep-scan` adds no per-sandbox deny rule (a deny would beat that allow), since your deny-all global policy already decides everything else, and checks again with `sbx policy ls` that no other allow is in place.
- **Files** go in through a private folder on your machine (`sbx cp` takes a file, not a stream) and are unpacked inside; the report comes out into a private folder and must be one regular file.
- **Teardown** removes any rule still in place and the sandbox (`sbx rm --force`).

## Credentials

A Deep scan runs on an **Anthropic API key**, on the API-key path: the documented, supported route, which works with Claude Code's `--bare` mode. It needs an [Anthropic Console](https://console.anthropic.com/) account and bills per token.

- **Use a dedicated Console workspace with its own spend limit**, and a key made in that workspace for deep scans only. The workspace's spend limit is the hard ceiling on what a runaway scan can cost, whatever happens inside the sandbox.
- **The key never enters the sandbox.** `deep-scan` reads it once and keeps it only in its own memory, for the model proxy, which swaps it in for the placeholder the sandboxed Claude Code sends. No command `deep-scan` runs (git, the runtime's CLI, `op`) gets it as an argument, an environment variable or a file: every model credential variable (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and the one you name) is removed from their environment.
- **Never put the key on the command line.** `--credential-from` takes where to read it from, never the key itself; anything else is a usage error that never prints the value.

Where the key comes from:

| `--credential-from`           | Reads                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| (none)                        | `ANTHROPIC_API_KEY` from the environment.                                                             |
| `env:<NAME>`                  | Another environment variable. A GitHub token variable (`GH_TOKEN`, `GITHUB_TOKEN`) is refused.        |
| `op://<vault>/<item>/<field>` | 1Password, with `op read` (the 1Password CLI, which only `deep-scan` may run). Sign in to `op` first. |

With 1Password you can also keep the key out of your shell entirely with `op run`, which resolves an `op://` reference held in `ANTHROPIC_API_KEY` for one command:

```sh
ANTHROPIC_API_KEY=op://Private/Anthropic-deep-scan/credential op run -- npx @mnaimfaizy/agent-kit deep-scan
```

`deep-scan` refuses, before any runtime starts, when the variable is unset or empty, when it still holds an `op://` reference (you ran without `op run`), when the key holds whitespace or a control character, or when `op read` fails (with `op`'s own message).

## Limits

Every Deep scan is bounded from outside the sandbox, so nothing the agent does inside can lift a limit. The defaults are starting values, and you can raise or lower each one with a `deep-scan` option. The [Scan recipe](#scan-recipe) never sets a limit: a limit field in it is refused, so a merged recipe change cannot raise your spend.

| Limit            | Default               | Option                | Enforced by                                                                     |
| ---------------- | --------------------- | --------------------- | ------------------------------------------------------------------------------- |
| Setup wall clock | 20 min                | `--setup-minutes <n>` | `deep-scan`, from the image step until the agent step starts                    |
| Scan wall clock  | 60 min                | `--scan-minutes <n>`  | `deep-scan`, over the agent step                                                |
| Turns            | 200                   | `--max-turns <n>`     | `deep-scan`'s own `--max-turns` on the Claude Code command line                 |
| Tokens           | 5,000,000 for the run | `--max-tokens <n>`    | the model proxy on your machine, which counts the `usage` the model API returns |

- A minutes value is a positive number (`90`, `7.5`) of at most 35791 (about 24 days, the longest a timer holds); turns and tokens are positive whole numbers. Anything else is a usage error, exit 2, before anything runs.
- **What the token cap counts:** every kind of token the model API reports in an answer's `usage`: input, output, cache-creation input and cache-read input tokens, each in full. Cache reads are billed at a fraction of the input price, so on a long run the cap counts more than you are billed for, and a run reaches it sooner than its spend alone would. The proxy refuses the request after the one that reaches the cap, and every request after it; the answer that crosses the cap is delivered, so a run can go past the cap by the answers already in flight when it is reached. It also refuses the batch and legacy completion paths (`/v1/messages/batches`, `/v1/complete`), whose spend an answer's `usage` would not show.
- **When a limit fires,** `deep-scan` stops the running step, the same way Ctrl+C does, prints `Stopped: <limit> (…)`, closes the model route and copies out the report the agent has written so far. The report gets a `- **Stopped:** wall clock | turns | tokens` header line after `Finding count`, naming the limit; only `deep-scan` writes that line, and it removes any `Stopped:` line the agent wrote itself. Then it tears the sandbox down, as on every exit path, and exits 3.
- **A stop with no report** (the setup wall clock, which fires before the agent step, or an agent that wrote nothing yet) writes no file and prints only the status naming the limit, `Stopped: <limit> (…). No report came out: nothing was written, filed or posted.`, and exits 3.
- **Turns** are Claude Code's own turn limit: the agent step's script reports it when Claude Code says it reached its limit. An agent could start a second Claude Code from Bash, outside that flag, so the wall clocks and the token cap, which the agent cannot reach, are the hard bounds.

Backstops beyond these limits:

- **On the API-key path**, the Console workspace's spend limit (see [Credentials](#credentials)) is the hard ceiling on what any run can cost, whatever the limits are set to.
- **On the subscription path** (not available yet), there is no Console spend limit, so the proxy's token cap is the only spend lever.
- **In CI**, the deep-scan workflow sets its job's `timeout-minutes` (180) above the sum of the phase limits, and refuses a `setup_minutes` plus `scan_minutes` above 150 before anything runs (see [Deep scan in CI](#deep-scan-in-ci)).

## Running a deep scan

1. **Adopt the audit flow** on the default branch: the security-audit skill (with `DEEP.md`) and the [Threat pack](#threat-pack), as `agent-kit init` sets them up.
2. **Commit a [Scan recipe](#scan-recipe)** on the default branch. Run `agent-kit doctor` to check it.
3. **Install an accepted [sandbox runtime](#sandbox-runtimes).** On Windows, that is Docker Sandboxes, with its global network policy set to deny-all (`sbx policy init deny-all`).
4. **Make the API key available** (see [Credentials](#credentials)), and unset `GH_TOKEN` and `GITHUB_TOKEN` for the run.
5. **Run it** from your checkout:

   ```sh
   npx @mnaimfaizy/agent-kit deep-scan
   ```

   With the key in 1Password: `npx @mnaimfaizy/agent-kit deep-scan --credential-from op://Private/Anthropic-deep-scan/credential`.

6. **Read the report** at the path `deep-scan` prints last (`Report: …/report.md`), in a new private folder under your temporary folder. It is the only thing the scan leaves on your machine. Nothing is filed or posted: to file a draft advisory, follow the skill's by-hand rule.

A good run prints the recipe, the Threat pack and the key's source, the runtime, each setup step `ok`, `Network: cut`, `Model route: only the model proxy…`, the agent step, `Model proxy: forwarded N request(s) to api.anthropic.com (answers: 200 xN)`, the report's path, and `Teardown: removed …`, and exits 0. A model proxy answer of `401` means the key was refused; `refused` lists hosts or paths the agent tried that the proxy turned away, and `counted N of the …-token cap` is the run's token count. A run a [limit](#limits) stopped prints `Stopped: …` and exits 3; to let a scan run longer, raise that limit with its option, for example `--scan-minutes 120`.

To choose the model the agent runs on, pass `--model <id>`, a plain model id such as `claude-opus-5-5` (letters, digits and `. _ : @ / [ ] -`; anything else is a usage error, exit 2). Without it, Claude Code runs on its own default.

## Verification run

A Verification run checks whether your fix holds, before you merge it or release the advisory. It re-attempts the Reproduction of findings you already have, on a ref you name, and answers each with `Reproduced: yes` (the fix does not hold) or `Reproduced: no` (it holds), with a reason. It is confirm-only: no `full` walk, no exploration and no new findings.

```sh
npx @mnaimfaizy/agent-kit deep-scan --verify ~/advisories/findings.md --ref fix/upload-traversal
```

- **`--verify <file>`** is the finding file: Markdown in a deep report's own shape, where each finding is a `###` section with `- **Concept id:**` (kebab-case), `- **Location:**` and `- **Observation:**` lines. The deep report that found them works as it is, once you drop the findings it did not reproduce; other `###` sections (Notes, Open questions) and anything inside a code fence are ignored. Keep the file outside the repository: it names a concept id that is private until release. `deep-scan` refuses, exit 1, before anything runs, a file that is missing, not a regular file, larger than 512 KiB, not UTF-8 text, or has no finding, a finding without a Concept id, Location or Observation, a concept id that is not kebab-case, or the same concept id twice.
- **`--ref <ref>`** is needed with `--verify`, and taken only with it: the local branch, tag or commit to verify on, such as your own fix branch, or a branch from the advisory's private fork whose commits you have reviewed (fetch it into a local branch first). Never run someone else's pull request head from anywhere else, reviewed or not ([ADR 0017](adr/0017-deep-scan-is-a-security-audit-mode-not-its-own-skill.md)). The ref's committed tree is exported, as the default branch's is for a deep scan, never your working tree. A ref that does not resolve to a local commit is refused, exit 1; one that reads as an option or holds a space is a usage error, exit 2.
- **What stays on the default branch:** the Scan recipe, the security-audit skill and the Threat pack are still read there, so a fix branch cannot change how its own fix is checked. The `.env` pre-flight runs on the ref, since that tree is what goes in.
- **What the agent gets:** the Verification-run procedure only (`DEEP.md`'s hard rules, its procedure steps 1, 2 and 6, and its Verification run section), the skill's `report-format.md` for the report's Verification-run variant, the Threat pack, the recipe, and the finding file at `/agent-kit/in/findings.md`. The finding file goes in with the brief, after the setup phase and the network cut, so no `setup` step, which can reach your registries, can read it. A skill whose `DEEP.md` or `report-format.md` lacks those sections is refused before any runtime starts: upgrade it on the default branch.
- **Its limits:** scan wall clock 15 min, 50 turns, and the same 5,000,000-token cap and 20 min setup wall clock as a deep scan. The [limit options](#limits) change them as for any run.
- **Its report** uses the Verification-run variant: Mode `deep (Verification run)`, one entry per given finding, in the order given, with its Location, `Reproduced: yes | no` and a reason. `deep-scan` writes it only to a new private folder under your temporary folder (`--report` is a usage error with `--verify`), prints each finding's answer, and exits 1 when the report misses the variant's Mode line or an answer for a given finding. Nothing is filed or posted: file no advisory, pull request comment or ledger note from it, so nothing public says a fix holds before release.
- **Local only.** `--verify` is refused, exit 1, in GitHub Actions (`GITHUB_ACTIONS=true`), before anything is read or run and without naming the file. It has no CI form, so without an accepted runtime on your machine, your nearest check is the next CI deep scan after the fix reaches the default branch ([ADR 0018](adr/0018-a-deep-scan-runs-locally-by-default.md)).

## Deep scan in CI

The CI path is opt-in: a separate reusable workflow, `deep-scan-reusable.yml`, which calls the same `agent-kit deep-scan` launcher as a local run. Adopting it leaves your static security-audit Caller and `security-audit-reusable.yml`, with its "no Bash" rule, unchanged. Use it when you have no accepted runtime on your own machine, or to scan on a schedule. `--verify` has no CI form ([ADR 0018](adr/0018-a-deep-scan-runs-locally-by-default.md)).

What the workflow does, in one job on an ephemeral GitHub-hosted runner (`ubuntu-latest`):

1. **Checks its inputs** (the model and the limits) and refuses anything but plain values, and a `setup_minutes` plus `scan_minutes` above 150, so the job's `timeout-minutes: 180` stays above the phase limits.
2. **Runs on the default branch only.** The job runs only from a `schedule` or `workflow_dispatch` event, and the gate refuses a run whose ref is not the repository's default branch. It never checks out a pull request head: the checkout takes no ref, and `deep-scan` exports the default branch's tip, not the working tree. The gate also preflights the advisory token, as the static audit does, before any model spend.
3. **Stages the delivery scripts** (`.github/security-audit/publish-draft-advisory.sh` and `notify-email.sh`, the same ones the static audit uses) from the commit object to a folder outside the workspace, and records their SHA-256 digests, before the scan.
4. **Installs gVisor** (`runsc`), a pinned release checked against its SHA-512, and registers it as a Docker runtime. `deep-scan` then chooses it, and the agent and the target run together in the gVisor container. The runner holds only `deep-scan`'s model proxy and the delivery steps.
5. **Installs the CLI** at this tag's version, without the model key in reach and with install scripts off.
6. **Runs `agent-kit deep-scan`** with the inputs as its options and `--report` pointing at a private folder on the runner. The model key is a separate Caller secret, `anthropic_api_key`, in this step's environment alone. The job token and the advisory token are never in it, and `deep-scan` refuses to start if `GH_TOKEN` or `GITHUB_TOKEN` is set. `deep-scan` tears the sandbox down before it exits.
7. **Delivers the report** after teardown: each staged script runs only after its digest check. The report becomes a private draft advisory, and is emailed when the email secrets are set (in full if the draft could not be filed).
8. **Prints a status** with no counts: whether a report came out and was filed, or which limit stopped the run.

**The Public-log rule in CI.** The Actions log of a public repository is world-readable, so nothing from the scan is printed or uploaded. In GitHub Actions (`GITHUB_ACTIONS=true`, which the runner always sets), `deep-scan` withholds everything the scan shaped: Claude Code's error output (it prints only the exit code), the model proxy's refused hosts and paths and its answer counts (it prints `Model proxy: closed`), and why a report could not be copied out. A failed `setup`, `start` or `ready` step still prints its output: that is your own build output, from before any probing. The publisher's metadata lines (finding counts, severity) are discarded, so the log never says how many findings there were. No artifact, cache or job summary is written. On a stop with no report, the only public output is the status naming the limit. To see what the run withheld, run `deep-scan` locally.

**Adopt it:**

1. Have the static flow and a valid [Scan recipe](#scan-recipe) on the default branch (`agent-kit doctor` checks the recipe).
2. Make an API key in a dedicated Console workspace with its own spend limit (see [Credentials](#credentials)), and store it as the repository secret `AGENT_KIT_DEEP_SCAN_ANTHROPIC_API_KEY`. The advisory token and the email secrets are the ones the static audit already uses.
3. Copy [`examples/deep-scan-caller.yml`](../examples/deep-scan-caller.yml) to `.github/workflows/`, pinned to the same tag as your other Callers. It runs weekly and on dispatch, with `permissions: contents: read`.
4. Set the repository variable `CLAUDE_DEEP_SCAN_ENABLED` to `true` to turn it on (the kill switch is on otherwise). `CLAUDE_DEEP_SCAN_MODEL`, else `CLAUDE_MODEL`, chooses the model.

Its inputs are only the kill switch, the model and the [limits](#limits) (`setup_minutes`, `scan_minutes`, `max_turns`, `max_tokens`, with the launcher's defaults); everything about your app comes from the recipe. The full contract is in [reference.md](reference.md#deep-scan).
