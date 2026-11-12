# Cutting releases

Maintainers cut Agent-kit Releases from the **default branch** only. There is no release-branch workflow, no attached binaries, and no skills zip.

Each tag is a **whole-kit snapshot**: reusable workflows, shipped skills, docs, and the Copilot archive at that commit. Consumers pin `uses: …@<tag>` and copy skills from the same tag.

## Before you cut

- CI is green on `main` (tests, lint, actionlint, links).
- The examples pin the tag you are about to cut (`uses: …@<tag>`). The contract tests require a SemVer tag there, so bump them in the release-prep PR.
- `cli/package.json`'s `version` is the tag without its `v` (see [Publishing the CLI to npm](#publishing-the-cli-to-npm)).
- The root `README.md` follows that version: the Quickstart tags name the new tag, and on a stage change the **Status** line names the new stage (for a stable release, drop the pre-release status and keep the broken-tags warning as its own sentence). `scripts/readme-freshness-contract.test.py` fails until it does, so do this in the release-prep PR.
- `CHANGELOG.md` has a section for the tag, and `release-notes/<tag>.md` exists when you want a Release body (required for beta, rc, stable).
- The release-prep PR is merged to `main` with the Admin bypass: the `main branch` ruleset lets only the Admin role update `main`. Wait for green CI on the PR first, because the bypass skips the required checks too. See [Branch protection](../CONTRIBUTING.md#branch-protection).

## Cut a release

The steps below use `<tag>`, e.g. `v1.0.0-beta.4`. The first cut on this line was `v1.0.0-alpha.1`.

1. Ensure `main` (or your default branch) is clean, up to date (`git pull`), and includes every path in `scripts/release-snapshot-manifest.txt`.
2. Verify the snapshot:

   ```bash
   uv run python scripts/verify_release_snapshot.py
   ```

3. Move `[Unreleased]` items in `CHANGELOG.md` into a new section if you want alpha notes (optional for alpha).
4. Dry-run the cut:

   ```bash
   bash scripts/cut-release.sh --tag <tag>
   ```

5. Either create and push the tag yourself (then create the Release in the GitHub UI):

   ```bash
   bash scripts/cut-release.sh --tag <tag> --apply
   git push origin <tag>
   ```

6. Or do it in one step — `--publish` pushes the tag, then creates the GitHub Release on it (still no assets):

   ```bash
   bash scripts/cut-release.sh --tag <tag> --apply --publish --notes-file release-notes/<tag>.md
   ```

   `--notes-file` is optional for alpha and required for beta, rc, and stable.

## Publishing the CLI to npm

Each pushed `v*` tag also publishes `cli/` as `@mnaimfaizy/agent-kit` through [publish-cli.yml](../.github/workflows/publish-cli.yml), with npm trusted publishing: the job's OIDC token is exchanged for a short-lived publish credential, and `npm publish --provenance --access public` links the package to the run. The repository stores no npm token. It publishes only a tag whose commit is on `main`. The package version must equal the tag without its `v`: `cut-release.sh` refuses to tag otherwise, and the workflow checks again before it publishes. So in the release-prep PR, set `cli/package.json`'s `version` to the tag you are about to cut, for example `1.0.0-beta.4` for `v1.0.0-beta.4`. Every Release-line tag is published as `latest`, because the line only moves forward.

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

Pass a notes file when cutting beta, rc, or stable tags:

```bash
bash scripts/cut-release.sh --tag v1.0.0-beta.4 --apply --publish --notes-file release-notes/v1.0.0-beta.4.md
```

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
