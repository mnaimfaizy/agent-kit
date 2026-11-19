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
- **Web tools are off.** The agent does not use WebFetch or WebSearch, so no search query shaped by a finding leaves the run. Its grounding is what the recipe's `setup` fetched.
- **Only the report leaves the sandbox.** The transcript, shell history, app logs and scratch scripts are destroyed with it.

Each finding gains `Reproduced: yes | no | not attempted`. With `yes`, a prose Observation names the location, the attacker's position, the kind of input in words and the effect seen. With `no` or `not attempted`, a one-line reason. Reproduction never changes severity: the Medium floor holds, a reproduced Low is still dropped, and an unreproduced Medium+ finding is still reported. A deep report also has an `Open questions` section, listing what the agent could not settle, so you can add grounding and run again, and a `Stopped:` header line, written by the launcher, when a limit ended the run. Fields and examples: the skill's `report-format.md`.

A deep report never contains anything runnable: no payload values, encoded strings, exact requests, command sequences, timing tricks, script or step-by-step recipe, in the report or the draft advisory, not even privately ([ADR 0016](adr/0016-security-pocs-are-never-delivered-rather-than-never-produced.md)). You can understand a finding and check a fix from it, but you cannot paste any of it into anything.

Deep findings share concept ids with static runs. An open ledger concept is skipped, with the report's notes saying whether it reproduced. A `rejected` or `accepted-risk` concept comes back only when reproduced, as reopening that decision, and a fixed concept only when reproduced, as a regression. The public findings ledger gains nothing from a deep scan. `security-finding-triage` reads `Reproduced` and the Observation as evidence and stays static.

A **Verification run** re-attempts the Reproduction of known findings on your fix branch, and answers `yes` (the fix does not hold) or `no` (it holds) for each. It reports no new findings, and its report stays on your machine.

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

| Field          | Required                                                   | Holds                                                                                        |
| -------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `image`        | one of `image` and `dockerfile`                            | A base image. Agent-kit layers a pinned Claude Code on top.                                  |
| `dockerfile`   | one of `image` and `dockerfile`                            | A Dockerfile's path in the repository. Not a compose file.                                   |
| `setup`        | yes (`[]` for none)                                        | Commands run before the agent enters, without the agent or the model credential.             |
| `registries`   | yes (`[]` for none)                                        | Hosts the setup phase may reach. The network is cut after setup.                             |
| `start`        | with `ready`; optional when every entry point is a command | Commands that start the services as processes inside the one sandbox.                        |
| `ready`        | with `start`                                               | Commands that confirm the services are up.                                                   |
| `seed`         | no                                                         | Commands that load test data.                                                                |
| `entry_points` | yes, at least one                                          | Each one of `url` (http or https), `port` (1 to 65535) or `command`, with a one-line `note`. |
| `fixtures`     | yes (`[]` for none)                                        | Mappings of test users, roles and similar. Fake values only.                                 |
| `grounding`    | no                                                         | URLs or repository paths that `setup` fetches, since the agent has no web access.            |
| `notes`        | yes                                                        | A line or a list of lines: what stays static-only.                                           |

A command field takes one command or a list of them; `start` and `ready`, when given, are not empty. Lists are block lists, one `- item` per line; only an empty `[]` may be written inline.

The recipe never holds:

- **Limits.** Time, turn and token limits come from `deep-scan`'s options or the deep-scan workflow's inputs, so a merged recipe change cannot raise a run's spend. A key such as `limits`, `max_turns`, `tokens` or `setup_timeout` is refused.
- **A compose file, sibling containers or the Docker socket.** Services share the one sandbox and its one boundary. A `compose` or `services` key, a compose file as `dockerfile`, a command that starts a container (`docker`, `podman`), and any mention of `docker.sock` are refused.
- **A real credential.** Values shaped like a GitHub, Anthropic, AWS or Slack token, or a private key, are refused anywhere in the recipe.
- **Anything else.** An unknown key, a key given twice, a top-level line that is not `key: value`, and a line indented under a key that holds a single value are refused.

`agent-kit doctor` reports whether `.security/scan-recipe.yml` is in your working tree and, if so, whether it is valid (a warning when it is not; having none passes). Today `agent-kit deep-scan` stops once the recipe is valid, with exit 0: the runtime, sandbox, proxy and scan stages are not built yet.
