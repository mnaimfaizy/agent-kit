# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Fixed

- `qa-plan` and `manual-qa` no longer drop the comments in a commented `qa.config.yml` without asking when they save your answers. `adapter.mjs render --write` now writes nothing over a YAML config that has comments and exits 3, naming the lines. The skill asks you, and writes with `--write --drop-comments` only if you agree. A preview without `--write`, a JSON config and a new file behave as before.

- `doctor`'s `release-tag-push` check no longer warns on a workflow whose `actions/checkout` step sets `ssh-key:`, since checkout then makes `git push origin` use that deploy key. A commented-out or empty `ssh-key:` still warns. The [hardening guide](docs/repository-hardening.md#personal-account-repositories-pushing-release-tags) now shows the `ssh-key:` checkout route as an alternative to the manual `GIT_SSH_COMMAND` step.

- The QA Plan format ([`ANATOMY.md`](.claude/skills/qa-plan/ANATOMY.md), copied in `qa-plan` and `manual-qa`) now states how the plan checker reads **Target:**, **Surface:** and **Signs in as:**. It drops backticks, reads up to the first space, comma, semicolon, colon or parenthesis, drops `*` and `_` at either end of that word, and strips nothing else. So `` `web`. `` fails, and **Signs in as:** must start with a declared role id or `nobody`. The checker no longer drops `_` inside the word, so a role id such as `team_admin` now matches its **Roles:** entry instead of being read as `teamadmin`.

## [1.0.0-beta.3] - 2026-11-11

Third beta on the `1.0.0` line, classed **Minor** (per [docs/releases.md](docs/releases.md)): two new User-scope Portable skills, `qa-plan` and `manual-qa`, turn a pull request's manual verification into a plan someone else can run and a report of that run, with a [QA](docs/qa.md) guide and config templates. Everything below is additive. No workflow input, secret or permission changed, no existing skill changed, and no Consumer action is required beyond the usual upgrade of the `uses:` pins and Kit-owned paths together.

### Added

- A seventh Portable skill, `qa-plan` (User-scope), run by hand as `/qa-plan` on an open pull request. It writes a **QA Plan**: only the **Residue**, the manual verification a passing CI run would not establish, in a format someone elsewhere can run from the plan alone (the skill's [`ANATOMY.md`](.claude/skills/qa-plan/ANATOMY.md)), with a Run brief and no credentials. Every coverage claim is tagged `[observed]` or `[reconstructed]`. An empty Residue is a valid result: it recommends merging without a plan. The draft is composed in a gitignored working directory, never committed, and delivered only after you confirm: kept as a working copy, or posted to one tracker issue per subject or one pull request comment, by rule, and edited on each revision. Settings go in `qa.config.yml` (or `.yaml` / `.json`) at your repository root (keys: the skill's [`ADAPTER.md`](.claude/skills/qa-plan/ADAPTER.md)); when a setting it needs is missing, it asks, and writes your answers into the file only if you agree. **Hazard packs**, Markdown files you own with `when:` globs, add _Rule out first_ checks to matching scenarios and capture rules to the Run brief. Why QA is two skills (the runner, `manual-qa`, follows): [ADR 0003](docs/adr/0003-qa-is-two-skills-joined-by-a-copied-plan-format.md).

- `qa-plan` observes coverage with `two-point.mjs`: it runs each configured suite at the head and at the merge-base (in a temporary worktree under the working directory, removed afterwards, even when a run fails), compares their JUnit XML test by test, and prints a table. A test that fails at both is an expected red herring; one that passes at the merge-base and fails at the head is a regression, and `qa-plan` stops; one that passes at both, or is new and passes, is covered. Those claims are `[observed]`. A suite with no JUnit, or a merge-base that will not build, is compared by exit code only, its claims are `[reconstructed]`, and the output says which suites degraded and why.

- An eighth Portable skill, `manual-qa` (User-scope), run by hand as `/manual-qa` on a QA Plan. It never composes: with no plan it stops and names `qa-plan`. It checks the plan against the shared format first, and refuses one that carries a credential. It then runs each scenario as written against a local **QA Stack** (your repository's `up`, `migrate`, `seed` and `down` commands, with teardown stopping only what the run started) and records PASS, FAIL or _left for a person_; it never marks a _left for a person_ scenario passed. Before running, it checks the build against the plan's head with `gh`, or your version endpoint, and otherwise marks the report **build not verified against plan**. It signs in only to a local development host (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.test`), only as a role the config declares, with the values your seeder prints. The result is a **QA Report** file with an evidence folder in the gitignored working directory, always written whether or not you post it. Settings go in the `run:` section of the same `qa.config.yml`; its keys, and the **QA Account** and **QA Stack** contracts your seeder and stack commands meet, are in the skill's [`ADAPTER.md`](.claude/skills/manual-qa/ADAPTER.md).

- `manual-qa` runs against a hosted test environment someone else deployed (`target: url`, or a URL the QA person gives for the run): it starts and seeds nothing. Before any sign-in, `adapter.mjs host --target url` enforces the host rule: a local development host passes, a hostname with a test-environment label in its subdomain (`staging`, `dev`, `test`, `qa`, `sandbox`, `preview`, `uat`, as in `qa.example.com`; a TLD such as `.dev` does not count) passes only once the QA person names or confirms it in chat, and anything that looks like production stops the run. A URL found only in the plan or a file is not confirmation. Role values come from your seeder's `accounts.print` when the environment's owner ran the same seeder there; otherwise the QA person types test values into chat. Never from an env file, never production credentials. See the skill's [`ADAPTER.md`](.claude/skills/manual-qa/ADAPTER.md#the-host-rule).

- `manual-qa` can post its QA Report to GitHub, only with `gh` access and only after you have seen the results and said yes. It goes where the plan went: one pull request comment starting `<!-- qa-report -->`, edited on each re-run and never duplicated, or, for a plan on a tracker issue, ticks on that issue's Sign-off checklist for each scenario that passed and its Execution record filled in, with links to uploaded evidence. **QA Artifacts** stay in the working directory unless `run.evidence.upload` is `gh-release:<tag>`: then only the files you pick, one by one, go to that prerelease (created when missing), screenshots and recordings from a failed run are never uploaded, and on a public repository you are warned first that only QA Account data may appear. The rules are in the skill's [`ADAPTER.md`](.claude/skills/manual-qa/ADAPTER.md#qa-artifacts-and-posting).

- A [QA](docs/qa.md) guide walks the two QA skills end to end: the developer → remote QA team handoff, the readiness check, the `stack` and `url` targets and the host rule, the QA Account contract with a minimal seeder outline, Hazard packs, and posting. Two templates to copy: [`examples/qa.config.yml`](examples/qa.config.yml), showing every key of both sections, and a sample Hazard pack, [`examples/qa-hazards/sign-in.md`](examples/qa-hazards/sign-in.md). A contract test reads both through the skills' own `adapter.mjs`.

### Changed

- [Install individual skills](docs/install-skills.md) now warns that `npx skills` replaces, without asking, a skill you already have with the same name (other skill collections ship a `code-review`, for example), and shows how to check first with `npx skills list -g`.

## [1.0.0-beta.2] - 2026-11-10

Second beta on the `1.0.0` line, classed **Minor** (per [docs/releases.md](docs/releases.md)): Portable skills can now be installed one at a time with `npx skills`, each skill declares its scope, and `doctor` reports a linked Kit-owned path. Everything below is additive or a fix. No workflow input, secret or permission changed, and no Consumer action is required beyond the usual upgrade of the `uses:` pins and Kit-owned paths together.

### Added

- **Install individual skills.** People who want one Portable skill without adopting the kit (Skill installers) can install it from a release tag with `npx skills add mnaimfaizy/agent-kit#<tag> --skill <name>`. [Install individual skills](docs/install-skills.md) has the command for each skill, says which ones work from your own skills directory (`-g`) and which need a repository, and says that upgrading means re-running the command with the new tag. Installs without a tag are not supported. If you adopt the kit, don't use it: see the note in [Adopt](docs/adopt.md).
- **Each Portable skill declares its scope** in its `SKILL.md` frontmatter as `metadata.agent-kit-scope`: `user` (works from your own skills directory in any repository) or `repo` (needs supporting files in the repository). `security-audit` is `repo`; the other five are `user`. [Releases](docs/releases.md) now says that a skill moving from User-scope to Repo-scope, or needing a new supporting file, is a Major change, and the reverse is Minor.
- Contract tests that keep this honest:
  - a skills-list gate fails when a skill folder is added or removed without every list following (`kit-owned-paths.txt`, the [Adopt](docs/adopt.md) copy list, the README _What ships_ row, the scope table on the install page, and each skill's own scope), and names each list out of step;
  - every User-scope skill is checked to import and link nothing outside its own folder, and to work when copied alone outside any repository;
  - `security-audit` must keep its Threat pack stop as its first step.

- A sixth Portable skill, `instruction-drift-audit`, run by hand as `/instruction-drift-audit ecosystem[@horizon] …`. It writes one **Upstream Brief**: a dated, cited report comparing your repository's agent instructions (`AGENTS.md`, `CLAUDE.md`, skills, …) to the official documentation for the version each named Ecosystem actually has installed (its Baseline), optionally looking ahead to a Horizon. Every finding needs a verbatim upstream quote; a validator shipped in the skill checks each report, including local citations against the commit it records, before the brief is rendered, and the committed report is the next run's ledger. It proposes one human-decision issue and applies nothing. Its scripts need Node 22 or later and import only Node built-ins; installed versions are read from `node_modules` (npm, pnpm, Yarn node-modules linker). Host settings go in an optional `instruction-drift-audit.config.yml` (or `.yaml` / `.json`) at your repository root; see the skill's [`ADAPTER.md`](.claude/skills/instruction-drift-audit/ADAPTER.md), which also lists the gate (`check-reports.mjs`) and dependency-hook (`suggest-run.mjs`) commands to wire. It began as a skill named `upstream-brief`: that name's `upstream-brief.config.*` adapter is still read when no `instruction-drift-audit.config.*` exists, and its CLI flags, report JSON and adapter keys are unchanged. The skill's own suites run in CI.

### Changed

- `security-audit` now starts by finding the Threat pack: in CI, the threat model and findings ledger the reusable workflow puts in its brief; by hand, the files your security-audit Caller names, or `.security/`. Without a Threat pack it stops before doing any work and says it is a Repo-scope skill that needs one. The automated audit flow is unaffected: the workflow already refuses to run without both files. The skill's delivery rule now says the reusable workflow files the draft security advisory in CI, and that you file it yourself when you run the audit by hand.
- `security-response` now says it requires `security-finding-triage` installed alongside it, since its `triage` mode runs that skill. `security-finding-triage` says where a Consumer's findings ledger is.
- `instruction-drift-audit` now works from your own skills directory as well as from inside the repository. In its commands, `<skill>` is now the skill folder's absolute path, quoted and written with forward slashes, instead of a path relative to the repository root. Step 8's delta snippet imports `ledger.mjs` from that path. Its CI gate and dependency hook still need the skill installed in the repository, as its [`ADAPTER.md`](.claude/skills/instruction-drift-audit/ADAPTER.md) says.

### Fixed

- `agent-kit doctor` now reports a Kit-owned path that is a symbolic link or, on Windows, a junction, which is what installing a Kit-owned skill with `npx skills` leaves. Before, a junction passed as matching, and a symlink stopped the whole Kit-owned paths check with git's raw `pathspec … is beyond a symbolic link` error. A link anywhere inside a Kit-owned folder counts too. Now the check fails that path in its own words and still compares the others. At a skill path it names `npx skills` as the likely cause: remove the link and `.agents/skills/<name>/`, then run the `upgrade --tag <tag> --force` command doctor prints.
- In `instruction-drift-audit`'s own portability suite, the check that its copied folder passes its own suites could never fail: the nested `node --test` inherited `NODE_TEST_CONTEXT` and exited 0 even when its tests failed. Nested runs no longer inherit it.
- `init`, `upgrade` and `doctor` could fail with `ENOTEMPTY` while removing the temporary repository they fetch tags into. `git fetch` starts a `git maintenance run --auto` that newer git versions detach, and that process could still be writing in the repository when the CLI removed it. The CLI now runs git with background maintenance off (`maintenance.auto=false`, `gc.auto=0`) for that repository, and retries the removal briefly.

## [1.0.0-beta.1] - 2026-11-09

First beta on the `1.0.0` line. The CLI now covers adoption end to end (`init`, `upgrade`, `doctor`), and the plan, implement, review and audit flows run in a Consumer repository that is not this one. No workflow inputs, secrets or permissions changed, and no Consumer action is required: upgrade the `uses:` pins and the Kit-owned paths together, as always (from this tag's CLI, `upgrade --tag v1.0.0-beta.1` does both).

### Added

- `npx @mnaimfaizy/agent-kit upgrade --tag <vY>` ([#72](https://github.com/mnaimfaizy/agent-kit/issues/72)) moves a Consumer from the tag its pins name to vY: it replaces each Kit-owned path vY lists (delete, then copy), deletes paths only the old tag listed, rewrites only the `@<tag>` of the Agent-kit `uses:` pins, prints the `examples/` diff between the two tags for you to apply to your Callers by hand, and then runs the `doctor --ci` file and pin checks. It works out every change and checks every refusal before writing anything: it refuses pins that disagree, an old or new tag without `kit-owned-paths.txt`, uncommitted changes in a path it would replace (unless `--force`), symbolic links in or above a Kit-owned path, and a tag file that is a link, a submodule, or a name two platforms would treat differently. After a Dependabot pin bump, `--from <vX>` names the tag being left, so paths only vX listed are deleted too. It asks before writing (`--yes` skips the question and is required without a terminal), writes only local files, and commits nothing; where `core.fileMode` is off (Windows), it stages each copied file with the tag's mode (adding or removing the executable bit), and `doctor` now takes a file's mode from the index there, as git does. `doctor`'s fix command for stale Kit-owned paths now names a CLI version that has `upgrade`. See [Getting started → Upgrading](docs/getting-started.md#upgrading).
- `npx @mnaimfaizy/agent-kit init --tag <vX>` ([#72](https://github.com/mnaimfaizy/agent-kit/issues/72)) adopts Agent-kit in a Consumer. It copies the Kit-owned paths and writes a Caller per flow: `pipeline` from `examples/plan-implement-review-caller.yml` to `.github/workflows/agent-pipeline.yml`, and `audit` from `examples/security-audit-caller.yml` to `.github/workflows/security-audit.yml`. It fills in the Allowlist logins, the tag, the default branch, `verify_commands` and a `setup_commands` preset, and refuses a tag whose example lacks the expected placeholders. It writes the Threat pack skeleton to `.security/` (or `--threat-pack-dir`, which also updates the audit Caller's paths) and `.github/dependabot.yml` when there is none. It prints the secrets, labels, Claude GitHub App, rulesets and Kill switch steps as `gh` commands. Every answer is a flag or a question; `--yes` asks nothing. It refuses to overwrite an existing Caller or Kit-owned path without `--force` (which lists the uncommitted changes it would discard), never overwrites an existing Threat pack file, and leaves Kit-owned paths that already match the tag alone, so a second flow can be added later. See [Getting started](docs/getting-started.md#adopt-with-the-cli).
- Threat pack skeletons in `examples/threat-pack/` (`threat-model.md`, `findings-ledger.md`), shaped after what the `security-audit` and `security-finding-triage` skills read and write. Copy them by hand or let `init` do it; the copies are yours.

### Changed

- The example Callers are named `agent-pipeline` and `security-audit` (their `name:` lines), matching the files `init` writes. A contract test holds each example to the placeholders `init` fills in.
- `doctor` and the new commands now print invisible and bidirectional formatting characters (zero-width characters, LRM/RLM, embeddings, overrides, isolates and the byte-order mark) as `\uXXXX`, as they already did for control characters, so a file name or message cannot read differently from what it is.

### Fixed

- A scheduled audit could fail with "Empty report" when the agent started a background subagent and ended its turn waiting for it, which ends a headless run ([#92](https://github.com/mnaimfaizy/agent-kit/issues/92)). The plan, implement and audit steps now set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, as review already did, so subagents and commands run only in the foreground. All four agents also deny `ScheduleWakeup`, `CronCreate`, `RemoteTrigger` and `SendMessage`, which need no permission, and `Workflow`, `Monitor` and `PushNotification`, which start background work or reach outside the run; no run uses any of them. The planner and the auditor also deny `Agent`, and the audit prompt says to finish in one turn. Review still runs its axes as parallel foreground subagents. One side effect for the implementer: a Bash command that reaches its timeout (2 minutes unless the agent sets a longer one, up to 10) now stops instead of carrying on in the background, so a test command granted through `extra_allowed_tools` that runs longer than that fails in the agent's session. The verify step after the agent is unaffected. No inputs, secrets or permissions changed.
- When an implement run failed before the agent started, for example because `setup_commands` failed, the "Check git configuration after the agent" step blamed the agent with "The agent run left git configuration or hooks outside the allowlist" and a `MODULE_NOT_FOUND` error ([#83](https://github.com/mnaimfaizy/agent-kit/issues/83)). The check now runs only when the hooks were staged. It still runs after a failed agent step: the agent can only start after staging succeeds, so any run in which the agent started is still checked.
- The plan, implement, review and audit runs no longer fail when GitHub's release CDN returns 5xx on the Bun download ([#86](https://github.com/mnaimfaizy/agent-kit/issues/86)). Each reusable workflow now installs the Bun version the pinned `claude-code-action` expects (1.3.14) before the action runs. It downloads from the npm registry first and falls back to the GitHub release through `api.github.com`, retrying each source for a few minutes. Either download must match a pinned SHA-256 before it is extracted. The path is passed to the action as `path_to_bun_executable`, so the action skips its own install. If neither source works, the job fails with "Bun install failed" instead of a later `bun: command not found`. No inputs, secrets or permissions changed.

## [1.0.0-alpha.12] - 2026-11-08

First release of the `@mnaimfaizy/agent-kit` npm CLI. No workflow inputs, secrets or permissions changed, and no Consumer action is required: upgrade the `uses:` pins and the Kit-owned paths together, as always.

### Added

- The `@mnaimfaizy/agent-kit` npm CLI, from `cli/`, with its first command, `doctor`: a read-only check of a Consumer against the tag its Callers pin. It fails when the Kit-owned paths differ from that tag (by git tree hash), the `uses:` pins disagree, a required secret or variable is missing (required versus optional taken from the reusable workflow's `secrets:` block at the tag), a Trigger label is missing, or the Claude GitHub App is not installed on an organization repository. It warns on an unset optional secret, a missing `update` or `creation` rule, no `v*` tag ruleset, a ruleset a GitHub App or the Write role can bypass, or a personal-account repository whose workflow pushes tags with `GITHUB_TOKEN`. Checks it cannot run are reported as skipped, never passed; `--strict` turns warnings into failures. `doctor --ci` checks only files and pins, needs no GitHub login, and is the recommended guard on pin-bump pull requests; see [Getting started](docs/getting-started.md#check-the-setup-with-doctor). The package has no runtime dependencies and reads kit files from the git tag, never bundles them. Tags before `v1.0.0-alpha.11` have no `kit-owned-paths.txt` and are refused. `init` and `upgrade` follow in a later release. `doctor` runs git without hooks or configured filter commands, prints fix commands only for names that pass a strict allowlist, and escapes control characters in everything it prints.
- Every Release tag publishes the CLI to npm with trusted publishing and provenance, behind a protected `npm` environment, with no stored token (`.github/workflows/publish-cli.yml`). The package version equals the tag; `cut-release.sh` refuses a tag that does not match. The first version is a one-time manual publish by the maintainer; see [Cutting releases](docs/cutting-releases.md#publishing-the-cli-to-npm).

## [1.0.0-alpha.11] - 2026-11-08

Adoption release from the [#67](https://github.com/mnaimfaizy/agent-kit/issues/67) feedback. No workflow inputs, secrets or permissions changed. **Consumer action recommended**: re-copy the Kit-owned paths with the new loop.

### Added

- A fifth Portable skill, `explainer`, for **Explainer Pages**: self-contained HTML diagrams, walkthroughs, and reference pages that let a named reader answer one question about a system. It writes a brief first (audience and one question; facts cited to source with a repo-wide collision check, or stated assumptions from an interview), then hands it to a builder that follows the skill's `BUILD.md` conventions (no network at load, three-state theme, no SVG `<title>` tooltip, reduced motion, measured rather than claimed visual review). Optional drift-proofing in `ANCHORS.md` embeds a manifest and citation anchors for a Consumer's own checker. Per-repository settings go in `docs/agents/explainer.md`; copy [`examples/explainer-config.md`](examples/explainer-config.md). Not used by any First-class flow.
- A new page, [docs/repository-hardening.md](docs/repository-hardening.md), with ready-to-run `gh api` commands for the rulesets the Claude GitHub App cannot bypass: an `update` rule on the default branch (a required pull request with zero approvals does not stop the App merging its own), a `creation` rule for release branches, and a `v*` tag ruleset. It also records a Consumer-side pattern for personal-account repositories, where the GitHub Actions app cannot bypass a ruleset: push release tags with a write deploy key and a `DeployKey` bypass. `getting-started.md` and `security-model.md` link to it.
- `setup_commands` presets under `examples/setup-presets/`: `python.sh`, `node.sh`, `mixed.sh` (Python and Node.js), and `redis-service.sh` (a Redis container via `docker run`). They pick versions from the runner tool cache and `$GITHUB_PATH`, with no download. Copy one into your Caller's `setup_commands` block; the copy is yours. Getting started now explains that `setup_commands` is a plain shell step (no `uses:` actions inside it), and warns against copying CI test env into `verify_commands`: a password variable such as `DATABASE_PASSWORD`, even with a throwaway test value, sets off secret scanners.
- `kit-owned-paths.txt` at the repository root lists each **Kit-owned path**, one folder per line: the five portable skill folders in `.claude/skills/`, `.github/agent-runtime/`, `.github/agent-pipeline/`, and `.github/security-audit/`. It ships in every tag from `v1.0.0-alpha.11`; `docs/adopt.md`, the README quickstart, and the future `@mnaimfaizy/agent-kit` CLI read it, and a contract test keeps them in step.
- Getting started has a "Decisions you'll make" checklist: vocabulary clashes, a `branch_prefix` expression over the issue's labels, where the Threat pack lives, how much `verify_commands` covers, merge policy, and `trusted_spec_authors`.

### Changed

- The README quickstart and Getting started step 3 now loop over `kit-owned-paths.txt`: each Kit-owned path is deleted, then copied fresh from the tag. Before, `cp -R` over the old copy left behind files the kit had removed. Your own skills in `.claude/skills/` are never touched. Tags up to `v1.0.0-alpha.10` have no manifest; copy the paths listed in `docs/adopt.md` for those.

## [1.0.0-alpha.10] - 2026-11-07

Security release for [GHSA-h5h6-4v46-73f9](https://github.com/mnaimfaizy/agent-kit/security/advisories/GHSA-h5h6-4v46-73f9). **Consumer action required** — see the first item.

### Consumer action

- **Required:** re-copy `.github/agent-runtime/` from this tag. Implement checks before the agent starts that the staged Bash guard refuses a commit that reads a file.

### Security

- The implementer's Bash guard now judges every command, not only pushes. claude-code-action grants `git add`, `git commit`, and `git rm` by command prefix, which allows any arguments. The guard refuses the git options that read a file (`-F`/`--file`, `-t`/`--template`, `--pathspec-from-file`, and their abbreviations), git's global options, an environment assignment before git, and shell expansion or input redirection (`$`, backticks, `<`) outside single quotes. Before this, the implementer could put a runner file or a secret from its environment into a commit message or an error it could copy into its pull request.

## [1.0.0-alpha.9] - 2026-11-07

Security release for [GHSA-hg89-9pp4-v549](https://github.com/mnaimfaizy/agent-kit/security/advisories/GHSA-hg89-9pp4-v549). **Consumer action required** — see the first item.

### Consumer action

- **Required:** re-copy `.github/agent-runtime/` from this tag. Implement stages two new files from it, `confine-writes-to-worktree.mjs` and `check-git-config.mjs`, and fails before the agent starts if either is missing or if `implementer.settings.json` does not run the write hook with `|| exit 2`.

### Added

- Review takes an optional Caller input, `trusted_spec_authors` (a JSON array of logins, empty by default). When the linked issue has no Verified plan, the Spec axis uses the latest issue comment that starts with `<!-- agent-kit-brief -->` and is written by a listed login. A Verified plan still wins, the brief stays inside the untrusted-spec fence, and the log records only which source was used.
- Implement takes two optional Caller inputs for the implementer's branch name: `branch_prefix` (default `claude/`) and `branch_name_template` (default empty, the action's own naming). A check before the agent fails the run if a name would be one the action rejects, if a template leaves out `{{entityNumber}}`, or if the prefix is longer than 24 characters (the action's default naming, which it also falls back to when a template's name already exists, cuts names at 50 characters). Callers that set neither get the same branches as before.

### Changed

- The glossary is renamed from `CONTEXT.md` to `GLOSSARY.md`. Update any links to the old name.

### Fixed

- The security audit no longer creates an empty report file before the agent runs. Claude Code's Write tool refuses to overwrite a file the session has not read, so a run could report success and leave the report empty.
- An empty audit report no longer discards the agent's session transcript. Before the job fails, it files a private draft advisory marked as a failed run with the transcript, and emails it when `notify_email` is on. The public log still says only `Empty report`.
- Every audit run's log now includes a `Final line:` verdict on whether the agent's last message matched `audit complete: <N> findings`, without showing the message.
- The email notifier passes the message body to Python as a private file instead of an environment variable, which failed on Linux for bodies over 128 KiB.

### Security

- The read-confinement hook judges every expansion of a Glob pattern's brace groups. Before this, a brace group could hide an absolute, climbing, or `.git` alternative, and Glob listed file names outside the workspace (contents stayed confined). A pattern whose braces cannot be expanded is refused.
- No agent that holds Write can change Claude Code's project settings mid-session. Plan and audit are denied edits to `.claude/` and `.mcp.json`; the implementer is denied `.claude/settings.json`, `.claude/settings.local.json`, and `.mcp.json`, by rule and by its write hook. Before this, an agent could add a permission rule that the running session picked up, widening its own tools.
- The implementer can no longer write git's configuration or hooks. A new staged hook keeps its file-writing tools in the working tree and out of `.git`, with symlinks resolved, and `Edit(./.git/**)` is denied. Before and after the agent, and in the push guard before it runs git, a check fails the run if `.git/config` holds a key outside a short allowlist or `.git/hooks` holds anything but samples. The push guard and the git steps after the agent also run with fsmonitor and hooks turned off. Before this, the implementer could write a git setting that names a command, which git then ran with the Claude GitHub App token in its environment.
- Implement closes the implementer's pull request, with a comment, and fails the run if the PR was opened ready for review. The draft state was only a prompt instruction; a new `keep-draft` job with no checkout enforces it, even when verify fails. It closes rather than converts because the job token cannot convert a PR the Claude GitHub App opened to draft. Hardening only; the App cannot approve or merge.
- The post-agent check that fails implement on workflow edits also covers `.github/actions/`, matching the pre-push guard. Hardening only; the guard already refused those pushes.

## [1.0.0-alpha.8] - 2026-09-26

Security release for [GHSA-529g-7fww-6rr7](https://github.com/mnaimfaizy/agent-kit/security/advisories/GHSA-529g-7fww-6rr7). **Consumer action required** — see the first item.

### Consumer action

- **Required:** re-copy `.github/agent-runtime/` from this tag. The staged settings must run each hook with `|| exit 2`, and the plan, implement, review, and audit jobs fail with a message if they do not.

### Security

- Review and PR-mode audit rewrite the checkout with content-changing git attributes pinned off before restoring the runtime from the pull request base, so a pull request's `.gitattributes` cannot re-encode the read-confinement hook into a file that does not run.
- Every job proves the staged read-confinement hook (and the implementer's push guard) refuses a probe call before the agent starts, and the hooks are registered with `|| exit 2`, so a hook that cannot run blocks the call instead of allowing it.
- The diffs precomputed for review and PR-mode audit use `--text --no-ext-diff --no-textconv`, so a pull request's attributes cannot hide a change as binary.

## [1.0.0-alpha.7] - 2026-09-25

Security release for [GHSA-6c8q-c2xg-w3fh](https://github.com/mnaimfaizy/agent-kit/security/advisories/GHSA-6c8q-c2xg-w3fh). **Consumer action required** — see the first item.

### Consumer action

- **Required:** re-copy `.github/agent-runtime/` from this tag. Implement loads the new `implementer.settings.json` and push guard, and fails with a message if they are missing.
- **Recommended:** before granting `extra_allowed_tools` that run repository code, protect your default branch and release tags with rulesets the Claude GitHub App cannot bypass.

### Security

- The implementer can no longer push changes under `.github/workflows/` or `.github/actions/`. It is denied edits there, and a staged pre-push hook refuses any push whose branch touches those paths, before the push. Previously the only check ran after the agent had pushed and opened its draft PR, and a same-repository PR runs its own workflow files with repository secrets.
- The read-confinement hook judges Glob's pattern as well as its path, so an absolute or climbing pattern can no longer list file names outside the workspace.
- Plan and security audit deny `Bash` outright. Leaving it off `--allowedTools` did not withhold it: Claude Code auto-approves read-only commands inside the workspace. Hardening only; the auto-approved commands reach nothing the agents' Read, Glob, and Grep tools could not.

### Added

- Per-flow model variables: the example and dogfood Callers read `CLAUDE_MODEL_PLAN`, `CLAUDE_MODEL_IMPLEMENT`, `CLAUDE_MODEL_REVIEW`, or `CLAUDE_MODEL_AUDIT` first, then the shared `CLAUDE_MODEL`, then `claude-opus-5`. Existing Callers keep working; re-copy the examples to use the new variables.

### Changed

- The security audit's token preflight no longer needs a draft advisory to exist. It probes the create-advisory endpoint with an empty body, which passes only for a token allowed to create advisories and never creates one. The one-draft seeding step is gone from setup.
- Publishing the draft advisory retries three times. If it still fails and `notify_email` is on, the full report is emailed with a `[publish failed]` subject instead of being lost; the run still fails.
- The example Caller's placeholder `verify_commands` start with `set -e`, so a failing command fails the verify job.

### Docs

- Getting started and the security model now say to protect the default branch and release tags with rulesets before granting `extra_allowed_tools` that run repository code, and that permission rules and hooks in a committed `.claude/settings.json` apply to the CI agents.

## [1.0.0-alpha.6] - 2026-09-24

Security release for [GHSA-pwx3-m47m-qfm5](https://github.com/mnaimfaizy/agent-kit/security/advisories/GHSA-pwx3-m47m-qfm5) and [GHSA-8787-cwm5-fvcj](https://github.com/mnaimfaizy/agent-kit/security/advisories/GHSA-8787-cwm5-fvcj): hardens read confinement, the agents' tool grants, and which job runs agent-authored code. **Consumer action required** — see the first items.

### Consumer action

- **Required:** re-copy `.github/agent-runtime/` and `.github/agent-pipeline/` from this tag. Plan, implement, review, and audit run the read-confinement hook from a read-only copy under `$RUNNER_TEMP` and fail with a message if `read-confinement.settings.json` still runs it from the workspace. `open-draft-pr.sh` takes the head branch as a third argument.
- **May be required:** implement runs `setup_commands` twice — before the agent, and again in the new `verify` job before `verify_commands` — so they should install the toolchain and be safe to repeat. `verify_commands` run with `bash -c`, not a login shell; move any profile-based setup into `setup_commands`.
- **May be required:** security audit `full` mode refuses a `head_sha` or `base_sha` and audits the commit it was dispatched on. Use `mode: pr` for pull requests.
- **May be required:** the implement job starts GitHub's MCP server container, so its runner needs Docker (GitHub-hosted `ubuntu-latest` has it). An SMTP host whose certificate the runner does not trust now fails the best-effort email step instead of receiving credentials.

### Security

- The read-confinement hook judges a path with symlinks resolved, runs from a read-only staged copy checked by digest after each agent, refuses `.git` for Read, Grep, and Glob, and now also covers the implementer.
- No agent is granted `git diff` / `git log` / `git show`, `gh pr comment`, or `gh pr create`; all are denied outright. The reviewer reads a precomputed diff; the implementer opens its draft PR with `mcp__github__create_pull_request`.
- Implement runs `verify_commands`, which execute agent-authored code, in a separate `verify` job with `contents: read` and no `id-token`, on the agent's pushed branch. Only the implement job holds write and OIDC credentials, and after the agent it runs only checks. The draft-PR fallback and label cleanup run in their own jobs without `id-token`, from the trusted commit.
- Security audit `full` mode no longer checks out a Caller-named head.
- The audit email notifier verifies the SMTP server's certificate and hostname, and runs Python isolated (`python3 -I`) from `$RUNNER_TEMP` so workspace files cannot shadow the standard library.

### Changed

- The review and audit briefs fence the PR's changed-file names as untrusted data.
- The advisory publisher writes the report body to a private `mktemp` file under `$RUNNER_TEMP` and removes it on exit.
- Caller input descriptions and `docs/security-model.md` state that `verify_commands`, `setup_commands`, `scan_command`, and code-running `extra_allowed_tools` entries are code the job runs, must never be built from issue or PR text, and that code-running extra grants act with the Claude App token.

### Fixed

- Implement's draft-PR fallback detects an existing PR with `gh pr list --head` and no longer posts a bogus "could not open draft PR" comment beside the agent's PR.

## [1.0.0-alpha.5] - 2026-09-24

Maintenance release: only this repository's own `CODEOWNERS` contract test changed. Nothing Consumer-facing changed (reusable workflows, runtime files, skills, and Caller inputs are the same as in alpha.4).

### Changed

- `scripts/codeowners-contract.test.py` fails on a CODEOWNERS rule without a leading `/`, and its path failure message names the missing anchor as a cause.
- `scripts/codeowners-contract.test.py` gives the same result for wildcard patterns on every supported Python version: a trailing-slash wildcard must match a directory, and the invalid-pattern handler is tested on every version.

## [1.0.0-alpha.4] - 2026-09-24

Adds Opus 5.5 support and fixes found by the first dogfood runs. No required Caller changes.

### Added

- Example Callers pass `model: ${{ vars.CLAUDE_MODEL || 'claude-opus-5' }}`, so the model is set with a repository variable instead of an edit to the Caller.
- `scripts/codeowners-contract.test.py`: CI now fails when a `.github/CODEOWNERS` rule points at a path that no longer exists, or names an owner that is not a valid `@handle` / `@org/team`.

### Changed

- `anthropics/claude-code-action` bumped from the 2026-08-11 pin (Claude Code 2.1.228) to v1.0.233, which is needed for `claude-opus-5-5`.

### Fixed

- Implement removes its `implementer-brief.md` scratch file before the Caller's `verify_commands`, so whole-tree lint/format checks no longer fail on it.
- Implementer PRs (agent-opened and fallback) include `Closes #<issue>`, so review finds the Verified plan and runs its Spec axis.

## [1.0.0-alpha.3] - 2026-09-24

First usable pre-release. `v1.0.0-alpha.1` and `v1.0.0-alpha.2` are **broken**: GitHub rejects their reusable workflows ("Invalid workflow file"), so no Caller pinned to them can run. Upgrade to this tag.

### Fixed

- Reusable workflows no longer declare a `github_token` secret (a reserved name that made every file invalid). They use `github.token`, limited by the Caller's `permissions:`.
- Security audit no longer requests the invalid `vulnerability-alerts` permission.
- Implement passes `verify_commands` through `env:` instead of splicing it into a single-quoted shell string, so commands containing quotes work.
- `scripts/cut-release.sh --publish` pushes the annotated tag before creating the GitHub Release.

### Changed

- **Callers:** remove `github_token:` from every `secrets:` block, and remove `vulnerability-alerts: read` from the audit Caller's `permissions:`.
- Dependabot alert grounding in `full` mode now needs the optional `dependabot_alerts_token` secret (fine-grained PAT, Dependabot alerts: read); without it the step is skipped.
- `actions/checkout` is pinned by commit SHA.
- Examples pin `@v1.0.0-alpha.3` and read their Kill switch from the `CLAUDE_PIPELINE_ENABLED` / `CLAUDE_SECURITY_AUDIT_ENABLED` repository variables.

### Added

- `docs/getting-started.md`, generated `docs/reference.md`, `CONTRIBUTING.md`, `CONTEXT.md` glossary.
- CI (tests, ruff, prettier, shellcheck, actionlint, link checks), pre-commit, Dependabot.
- Workflow-validity contract tests for what GitHub rejects at load time but actionlint misses.
- Dogfood Callers that run this repository's own flows (off by default) and an Agent-kit Threat pack.

## [1.0.0-alpha.2] - 2026-09-24 [BROKEN — use 1.0.0-alpha.3]

### Changed

- Plan, implement, review, and security-audit reusable workflows now run Claude Code with the controls landed on the Issuebridge reference Consumer: SHA-pinned action, job-token GitHub auth for every job except the implementer, `persist-credentials: false`, a PreToolUse hook that confines Read/Grep/Glob to the workspace, reviewed tool allowlists, staged credentialed audit scripts, and an advisory-token preflight before the audit agent runs.
- Review is a pull-request job (`pr_number`, `head_sha`, `base_sha`, `base_ref`). Callers pass `claude_code_oauth_token`. The audit Caller also passes `github_token`.

## [1.0.0-alpha.1] - 2026-08-19 [BROKEN — use 1.0.0-alpha.3]

### Added

- Public Agent-kit identity (README, MIT, SECURITY.md).
- Four portable skills: `code-review`, `security-audit`, `security-finding-triage`, `security-response`.
- Security-audit reusable workflow and Caller example.
- Plan-implement-review reusable workflows and Caller example.
- Adopt, Releases, security-model, and flow documentation.
- Copilot inert archive and restore path.
- Companion library pointer (Matt Pocock's skills) and Issuebridge reference Consumer checklist.
- Maintainer cut tooling: whole-kit snapshot manifest, verification script, and `cut-release.sh`.
- First public whole-kit snapshot (workflows, skills, docs, Copilot archive).

Beta, rc, and stable cuts **require** a `CHANGELOG.md` section and a GitHub Release body. See `docs/cutting-releases.md`.
