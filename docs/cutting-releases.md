# Cutting releases

Maintainers cut Agent-kit Releases from the **default branch** only. There is no release-branch workflow, no attached binaries, and no skills zip.

Each tag is a **whole-kit snapshot**: reusable workflows, shipped skills, docs, and the Copilot archive at that commit. Consumers pin `uses: …@<tag>` and copy skills from the same tag.

## Before you cut

- Your git identity uses your GitHub noreply address (`<id>+<login>@users.noreply.github.com`). With email privacy on, GitHub refuses to push a tag or commit that carries a private address (GH007), and a tag's tagger address is whatever `git var GIT_COMMITTER_IDENT` prints. Set it once per clone:

  ```bash
  git config user.email "$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')"
  ```

  Environment variables beat git config: if `GIT_COMMITTER_EMAIL` (or `EMAIL`) is set in your shell, unset it. Both scripts check the address before they commit or tag. They print the domain of a wrong address, never the address itself.

- `gh` is installed and signed in (`gh auth login`). The cut reads CI's result on the commit through it.
- You hold the Admin role. The `release tags` ruleset lets only the Admin role create, update or delete `refs/tags/v*`, and the `main branch` ruleset lets only the Admin bypass merge to `main`. See [Branch protection](../CONTRIBUTING.md#branch-protection).

## Cut a release

A cut is two steps: **prepare** writes the release-prep pull request on a branch, and **cut** tags `main` once that pull request is merged. The steps below use `<tag>`, e.g. `v1.0.0-beta.5`. The first cut on this line was `v1.0.0-alpha.1`.

### 1. Prepare: the release-prep pull request

Fill in `CHANGELOG.md`'s `[Unreleased]` section first. Then, with a clean working tree on any branch:

```bash
bash scripts/prepare-release.sh --tag <tag>
```

It refuses a tag that already exists, locally or on `origin`, and a tag that does not come after the latest tag on `origin` (see [Stage order](#stage-order)). Otherwise it:

1. creates `chore/release-<tag>` from an up-to-date `origin/main`;
2. bumps every pin of the previous tag to `<tag>`. The previous tag is `cli/package.json`'s version, or the latest tag on `origin` if the package already names `<tag>`; `--from <tag>` overrides it. It finds the pins by searching the tracked files, so `cli/package.json`, `cli/README.md`, the example Callers, the README Quickstart and the docs all move. It leaves history and fixtures alone: `CHANGELOG.md`, `release-notes/`, `docs/adr/`, `scripts/` (this tooling and the contract tests), every `*.test.py` and `*.test.mjs`, the [Broken releases](releases.md#broken-releases) table, and any line that calls a tag broken. On a stage change it moves the README **Status** line to the new stage; for a stable release it tells you to edit that line by hand;
3. moves `[Unreleased]` into `## [X.Y.Z-stage.N] - YYYY-MM-DD` and leaves `[Unreleased]` empty. It refuses an empty `[Unreleased]` before it writes anything;
4. writes `release-notes/<tag>.md` from [`scripts/release-notes-template.md`](../scripts/release-notes-template.md) for beta, rc and stable, unless the file exists. It never overwrites notes;
5. runs the snapshot check (`scripts/release-snapshot-manifest.txt`).

It pushes nothing, and prints the commit, push and `gh pr create` commands instead. Replace every `TODO(release-notes)` line in the notes, add the bump class to the CHANGELOG section if you want one, and review `git diff`. Then commit and open the pull request yourself, or re-run with a flag: `--commit`, `--push` (commit and push) or `--open-pr` (commit, push and open the pull request). None of them commits notes that still have a `TODO(release-notes)` line, and they commit only tracked changes and the notes file, never another untracked file. Re-running on `chore/release-<tag>` is safe: steps already done are left as they are.

Merge the pull request with the Admin bypass once its CI is green: the bypass skips the required checks too.

### 2. Cut: tag `main` and push the tag

```bash
git switch main && git pull --ff-only
bash scripts/cut-release.sh --tag <tag>                      # dry run: every check, writes nothing
bash scripts/cut-release.sh --tag <tag> --apply --publish    # create the tag and push it
```

Before it tags, the cut checks that:

- you are on `main`, the working tree is clean, and `HEAD` equals `origin/main` after a fetch;
- CI on that commit is green: the `Tests`, `Lint and format` and `Internal links` checks, read with `gh`;
- the tag is not on `origin`, and it comes after the latest tag there;
- `cli/package.json`'s version at `HEAD` is the tag without its `v`;
- for beta, rc and stable, `CHANGELOG.md` has the tag's section, and `release-notes/<tag>.md` is committed with no `TODO(release-notes)` line left;
- the address git will tag with is a `@users.noreply.github.com` address. Pass `--allow-private-email` only if your account allows pushes with another.

`--apply` creates the annotated tag locally; `--publish` (with `--apply`) pushes it. The push starts [publish-cli.yml](../.github/workflows/publish-cli.yml). Its **Create the GitHub Release** job creates the Release from `release-notes/<tag>.md` on the tag, as a pre-release for alpha, beta and rc. Then its **Publish to npm** job waits for your approval (see below). The cut no longer creates the Release itself. `--notes-file` is still accepted, but it must name `release-notes/<tag>.md`, since that is the file the workflow reads.

### When a cut fails part-way

Re-run the same command. Each run finishes what is left, or says exactly what is left:

| State                                                      | What the re-run does                                                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local tag from an earlier `--apply`, never pushed          | Reuses it if it is annotated, points at `HEAD` and has a noreply tagger, then pushes it.                                                                                               |
| Local tag on another commit, lightweight, or a wrong email | Stops and prints the fix: `git tag -d <tag>` and re-run, or re-run with `--replace-local-tag`. It deletes an unpushed local tag only with that flag.                                   |
| Push refused                                               | The tag stays local, so the re-run is safe. A GH007 refusal prints the email fix; a ruleset refusal means the push needs the Admin role.                                               |
| Tag on `origin`                                            | Final: it never moves, deletes or re-pushes it. It reports the GitHub Release and the `Publish CLI` run: waiting for approval, still running, or failed with a `gh run rerun` command. |

If the Release job fails (missing notes, say), the npm publish does not run either. Fix the cause and re-run the failed jobs. The job does nothing when the Release already exists, so a Release you created by hand is kept.

## Publishing the CLI to npm

Each pushed `v*` tag also publishes `cli/` as `@mnaimfaizy/agent-kit` through [publish-cli.yml](../.github/workflows/publish-cli.yml), with npm trusted publishing: the job's OIDC token is exchanged for a short-lived publish credential, and `npm publish --provenance --access public` links the package to the run. The repository stores no npm token. It publishes only a tag whose commit is on `main`. The package version must equal the tag without its `v`: `cut-release.sh` refuses to tag otherwise, and the workflow checks again before it publishes. `prepare-release.sh` sets `cli/package.json`'s `version` to the tag you are about to cut, for example `1.0.0-beta.5` for `v1.0.0-beta.5`. Every Release-line tag is published as `latest`, because the line only moves forward.

### One-time setup

npm can only attach a trusted publisher to a package that already exists, on the website and with `npm trust` alike. So the first version is published by hand, without provenance (ADR [0001](adr/0001-distribute-the-cli-via-npm.md)). The maintainer does this once; no agent or workflow does it. Checked against GitHub's and npm's docs on 2026-11-08.

#### 1. The `npm` environment (before the first tag that carries `cli/`)

Create it **before** you push `v1.0.0-alpha.12`. A workflow that names a missing environment creates it with no protection, and the tag's publish run would start at once.

1. Open **Settings → Environments → New environment**, name it `npm` (it must match `environment: npm` in `publish-cli.yml`), and click **Configure environment**.
2. Under deployment protection rules:
   - Tick **Required reviewers** and add yourself.
   - Leave **Prevent self-review** unticked. You push the tag and you are the only reviewer, so with it ticked nobody could approve.
   - Leave **Wait timer** off.
   - Untick **Allow administrators to bypass configured protection rules**, so a publish can't skip review.
   - Click **Save protection rules**.
3. Under **Deployment branches and tags**:
   - Choose **Selected branches and tags**.
   - Click **Add deployment branch or tag rule**, set **Ref type** to **Tag**, enter `v*`, and click **Add rule**.
4. Add no environment secrets or variables. The job publishes through OIDC, with no token.

Required reviewers are available on a free personal account because this repository is public. Check the result:

```bash
gh api repos/mnaimfaizy/agent-kit/environments/npm --jq '{rules: [.protection_rules[].type], admin_bypass: .can_admins_bypass, policy: .deployment_branch_policy}'
```

```bash
gh api repos/mnaimfaizy/agent-kit/environments/npm/deployment-branch-policies --jq '.branch_policies[] | {name, type}'
```

#### 2. The first publish (`v1.0.0-alpha.12`, done 2026-11-08)

1. Cut the tag as usual. Its `Publish CLI` run waits on the `npm` environment; leave it waiting.
2. Publish from a clean checkout of the tag with your own interactive npm login. No access token is created:
   - `npm login` signs in through the browser with your account's two-factor authentication.
   - `--access public` is required, because scoped packages default to private.
   - `--provenance=false` is required here. `cli/package.json` sets `publishConfig.provenance: true` for the workflow, and outside CI npm stops with `EUSAGE` "Automatic provenance generation not supported for provider: null".
   - `npm logout` revokes the login token straight after.

   ```bash
   git switch --detach v1.0.0-alpha.12
   cd cli
   npm login
   npm publish --access public --tag latest --provenance=false
   npm logout
   ```

   **Run `npm publish` in a real console** (PowerShell, cmd or Windows Terminal; on macOS or Linux, any terminal), not in Git Bash's mintty window. npm only waits for browser two-factor authentication when stdin and stdout are both terminals. Under mintty they are pipes, so npm prints an `EOTP` error with an authentication link and exits at once, and the link is then useless, because nothing is waiting for the approval. In Git Bash, prefix the command with `winpty npm.cmd` instead of `npm`.

   With a passkey or security key (no six-digit codes), npm prints `Authenticate your account at: …`. Press Enter to open it, approve in the browser, then return to the terminal and the publish completes. With an authenticator app, pass `--otp=<code>` instead.

   **Fallback:** `npm stage publish --access public --tag latest --provenance=false` needs no two-factor authentication to stage. You then click **Approve** under **Staged Packages** on npmjs.com, or run `npm stage approve <stage-id>`. For a package that doesn't exist yet, npm first publishes a public `0.0.0-stage` placeholder that stays in the version list, so prefer the console route.

3. The registry can take a few minutes to list a new package ("Your package is being processed"). Check it with `npm view @mnaimfaizy/agent-kit@<version> version`.
4. In the waiting run, click **Review deployments**, then **Reject**: the version is already published.

#### 3. The trusted publisher (within 2 days before the next tag)

A newly created trusted publisher must complete a successful publish within **2 days**, or you delete it and create it again. So add it shortly before you cut the next tag (`v1.0.0-beta.1`), not right after the first publish.

- **On npmjs.com:**
  1. Go to **Packages → `@mnaimfaizy/agent-kit` → Settings → Trusted publishing → GitHub Actions**.
  2. Fill in organization or user `mnaimfaizy`, repository `agent-kit`, workflow filename `publish-cli.yml` and environment name `npm`.
  3. Under **Allowed actions**, tick **`npm publish`**. Trusted publishers created after 2026-09-03 allow only `npm stage publish` by default, and `publish-cli.yml` runs a plain `npm publish`.
- **Or from the CLI**, with npm 11.15 or later and two-factor authentication on your account:

  ```bash
  npm trust github @mnaimfaizy/agent-kit --file publish-cli.yml --repo mnaimfaizy/agent-kit --env npm --allow-publish
  ```

Then, under the package's **Publishing access**, choose **Require two-factor authentication and disallow tokens** and click **Update Package Settings**. This doesn't affect OIDC publishing, and it means no token can ever publish the package.

From that tag on, cut the tag, click **Review deployments → Approve and deploy** on its `Publish CLI` run, and the job publishes with `--provenance`. Check it:

```bash
npm view @mnaimfaizy/agent-kit@<version> dist.attestations
```

## Release notes and changelog shape

User-facing notes summarize contract-impacting changes — not a raw commit dump.

| Stage      | GitHub Release body | `CHANGELOG.md` section |
| ---------- | ------------------- | ---------------------- |
| **alpha**  | Optional            | Optional               |
| **beta**   | Required            | Required               |
| **rc**     | Required            | Required               |
| **stable** | Required            | Required               |

### Alpha (notes optional)

```markdown
## [1.0.0-alpha.1] - YYYY-MM-DD

### Added

- First public Agent-kit snapshot: security-audit and plan-implement-review flows, four portable skills, Adopt/Releases docs, Copilot inert archive.
```

### Beta / rc / stable (notes required)

```markdown
## [1.0.0-beta.1] - YYYY-MM-DD

### Added

- …

### Changed

- …

### Fixed

- …
```

The GitHub Release body is `release-notes/<tag>.md` on the tag. `prepare-release.sh` writes it from the template for beta, rc and stable. An alpha without a notes file gets the body `Pre-release <tag>`.

## A tag turned out broken

Never move, delete, or re-push a tag: Consumers may already pin it. Instead:

1. Fix on `main` and cut the next tag.
2. Add the broken tag to the table in [Releases → Broken releases](releases.md#broken-releases) and say so in the CHANGELOG.
3. Edit the broken tag's GitHub Release body to point at the fix (`gh release edit <tag> --notes-file …`).

## Stage order

On a given target `X.Y.Z`: **alpha → beta → rc → stable**. Do not move backward. Counters reset per stage (`-alpha.1`, `-alpha.2`, … then `-beta.1`, …).

## What is not part of a cut

- No release branch
- No floating `v1` or `v1.0` tags
- No binaries or skills zip attached to the GitHub Release (the npm package holds CLI code only)
- No Marketplace listing

See [Releases](releases.md) for SemVer bump rules and Consumer contract policy.
