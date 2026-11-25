# Creating the Consumer's factory GitHub App

Research for [Creating the Consumer's factory GitHub App](https://github.com/mnaimfaizy/agent-kit/issues/495), on the map [Wayfinder: Agentic Software Factory](https://github.com/mnaimfaizy/agent-kit/issues/480). On the Workflow engine, only the build Stage's publish job holds a token from a Consumer-owned GitHub App, so the Consumer's CI runs on factory pull requests without approval ([ADR 0037](../adr/0037-the-workflow-dispatcher-is-one-queued-sweep-over-the-tracker.md), from [#489](https://github.com/mnaimfaizy/agent-kit/issues/489)). This note says how a Consumer creates that App, what it may hold, where its key lives, and how a job turns the key into a token.

- **Read on:** 2026-11-25. Docs pages carry no publish date, so each fact is dated by the read.
- **Sources:** primary only.
  - GitHub Docs: [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps?apiVersion=2022-11-28), [REST: Apps](https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28) (create from a manifest; create an installation access token), [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [Managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps), [Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app), [Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets), [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
  - The [`actions/create-github-app-token` README](https://github.com/actions/create-github-app-token/blob/main/README.md) (v3 in its examples).
  - This repository: [GitHub facts the factory depends on](https://github.com/mnaimfaizy/agent-kit/issues/483) (events from tokens, rulesets), [ADR 0035](../adr/0035-a-stage-check-is-a-commit-status-the-gate-checks-by-creator.md) (Stage checks are commit statuses checked by creator), [ADR 0037](../adr/0037-the-workflow-dispatcher-is-one-queued-sweep-over-the-tracker.md), [ADR 0039](../adr/0039-the-orchestrate-engine-is-a-trusted-host-its-agents-reach-github-through-a-snapshot-and-an-outbox.md) (the Orchestrate engine's one-repo PAT).
- **UNCONFIRMED** marks anything no primary source states. Every one is listed again at the end.

## 1. The manifest flow

### 1.1 What GitHub documents

The flow has three steps ([manifest page](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)):

1. "You redirect people to GitHub to register a new GitHub App." This is a `POST` with a form field `manifest` holding the manifest as a JSON string, to `https://github.com/settings/apps/new` for an App owned by a personal account, or to `https://github.com/organizations/ORGANIZATION/settings/apps/new` for one owned by an organization. An optional `state` ("an unguessable random string", against CSRF) comes back on the redirect.
2. "GitHub redirects people back to your site." The person sees GitHub's page with the preset settings, can edit the name, and clicks **Create GitHub App**. GitHub then redirects to the manifest's `redirect_url` with a temporary `code` query parameter.
3. "You exchange the temporary code to retrieve the app configuration": `POST /app-manifests/{code}/conversions`. The response is the App object (`id`, `slug`, `client_id`, `owner`, …) plus `client_secret`, `webhook_secret` and `pem`, the private key ([REST: Apps](https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28#create-a-github-app-from-a-manifest)).

All three steps must finish within one hour. The manifest's settable fields are `name`, `url` (required), `hook_attributes` (`url`, `active`), `redirect_url`, `callback_urls`, `setup_url`, `description`, `public`, `default_events`, `default_permissions`, `request_oauth_on_install`, `setup_on_update`.

The flow **registers** the App; it does not install it. The page says the registrant "can install" the App afterwards, which is a separate step on GitHub's site ([Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)). There the person picks **Only select repositories** and the one repository. An App registered with "Only on this account" (`public: false`) can be installed only on the account that registered it.

Webhooks can be off: deselecting **Active** removes the need for a webhook URL ([Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)). The factory's App needs none: its token is minted from the key, and the Dispatcher wakes on Actions events (ADR 0037). An account can register up to 100 Apps.

### 1.2 User-owned and organization repositories

Both work; only the `POST` URL differs. For an organization, the person must be an organization owner, or have been granted permission to manage the organization's Apps ([Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)). Who may then install it on the organization is not stated on the install page: **UNCONFIRMED** (1); the expected answer is an organization owner.

### 1.3 What needs a person in a browser

- **Being signed in to GitHub.** The registration page is github.com's own, under the person's session. No API registers an App.
- **Submitting the manifest.** The docs describe a link or button that "sends a `POST` request", in an HTML form. The CLI cannot make that request for the person; a browser submits it.
- **Clicking Create GitHub App** (and optionally editing the name).
- **Installing the App** on the one repository: a second page, a second click, the repository choice.
- **On an organization**, holding the owner (or App manager) role.

What `agent-kit init --factory` can do itself:

- Build the manifest (name, `public: false`, webhook inactive, the permissions in §2, `redirect_url`).
- Serve a local page whose form auto-submits the manifest to the right URL, and open it in the browser. Whether GitHub accepts a `http://localhost:<port>` `redirect_url` is not stated: **UNCONFIRMED** (2). If it is refused, the fallback is a `redirect_url` page that shows the `code` for the person to paste into the CLI.
- Check `state`, then exchange the `code` within the hour. Whether the conversion call needs authentication is not stated; the page's example sends no `Authorization` header but says headers are omitted for brevity: **UNCONFIRMED** (3).
- Store the key and client ID (§3), then open the install page and wait for the installation to appear. The install URL `https://github.com/apps/<slug>/installations/new` is not on the page read: **UNCONFIRMED** (4).
- Throw away `client_secret` and `webhook_secret`: the factory uses neither.

The `pem` is shown once. GitHub keeps only the public half ([Managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)), so the CLI must write it to the secret in the same run and should never write it to disk. A lost key is replaced by generating a new one in the App's settings (up to 25 per App; rotate by adding the new one before deleting the old).

## 2. Minimum permissions

What the publish job does, and the App permission each GitHub endpoint needs ([Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps?apiVersion=2022-11-28)):

| Action | Endpoint | App permission |
|---|---|---|
| Push the task branch | `POST`/`PATCH /repos/{o}/{r}/git/refs`, `PUT …/contents/{path}` (and git over HTTPS) | **Contents: write** (Workflows: write as well when the change touches `.github/workflows`) |
| Open, retitle, re-describe the PR | `POST /repos/{o}/{r}/pulls`, `PATCH …/pulls/{n}` | **Pull requests: write** |
| Write a commit status | `POST /repos/{o}/{r}/statuses/{sha}` | Commit statuses: write |
| Comment on the PR or issue | `POST /repos/{o}/{r}/issues/{n}/comments` | Issues: write or Pull requests: write (listed under both) |
| Read the repository | all of the above | Metadata: read |

The App needs only **Contents: write**, **Pull requests: write** and Metadata: read. The other two rows stay on `GITHUB_TOKEN`:

- **Commit statuses.** ADR 0035 says the merge gate accepts a Stage check only from the engine's one fixed identity, and ADR 0037 says the Stage checks' writers keep `GITHUB_TOKEN`. A job can hold both tokens. Writing statuses with the App would add a second creator the gate has to trust. And a status written with `GITHUB_TOKEN` starts no workflow, which is what the factory wants anyway ([#483](https://github.com/mnaimfaizy/agent-kit/issues/483)).
- **Comments** need no workflow to start, so `GITHUB_TOKEN` (`issues` / `pull-requests: write`) does them.

The only reason for the App is that its push and its pull request start the Consumer's CI ([#483](https://github.com/mnaimfaizy/agent-kit/issues/483)). So it holds just the permissions those two writes need.

**What exceeds what the Factory should hold:**

- **Contents: write is repository-wide.** It allows a push to any branch, the default branch included, and a pull-request merge (`PUT …/pulls/{n}/merge` needs only Contents: write). The App permission model has no per-branch scope. The bound comes from a ruleset on the default branch that the App is not on the bypass list of (a ruleset has no default bypass, [#483](https://github.com/mnaimfaizy/agent-kit/issues/483)), plus the publish job's own check of Allowed paths (ADR 0005). `init --factory` should check the ruleset exists, or warn.
- **Workflows: write should be left off.** With it, a factory branch could change a workflow, and a `pull_request` run from a branch in the same repository gets the repository's secrets, the App key included. Without it, GitHub refuses a push that touches `.github/workflows` ([Choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) says to request Workflows for that). The refusal for a git push over HTTPS is not on the pages read: **UNCONFIRMED** (5). A task that needs a workflow change goes to a human.
- **Nothing organization-level**, no Administration, Actions, Checks, Secrets, Environments or Members. Checks are not needed: Stage checks are commit statuses (ADR 0035).

If the App's permissions grow later, each installation owner must approve the new set, and until then the installation keeps the old one ([Choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)). So a later version of agent-kit that needs more cannot widen the App silently.

## 3. Where the key lives

### 3.1 Workflow engine

The README stores the App's client ID in a repository **variable** (`APP_CLIENT_ID`) and the key in a repository **secret** (`APP_PRIVATE_KEY`). The private-keys page advises against hard-coding the key and prefers a signing-only key vault over environment variables. It does not mention Actions secrets. Secret scopes are repository, environment and organization ([Using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)). Secrets are not passed to workflows triggered from forks.

Recommended: an **environment secret**, not a repository secret, where the plan allows it. "Secrets stored in an environment are only available to workflow jobs that reference the environment", and the environment's deployment branches rule ("Selected branches and tags" or "Protected branches only") limits which refs may use it ([Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)). One environment, say `factory-publish`, limited to the default branch and referenced only by the publish job, keeps the key away from every other job. That includes jobs running from factory branches. Plan limits: environment secrets and deployment-branch rules work on public repositories on every plan, and on private ones only on Pro, Team or Enterprise. On a private repository on Free, the key falls back to a repository secret, which any workflow in the repository can read. That makes leaving Workflows: write off (§2) the main guard.

Org-level secrets are not needed: the App is installed on one repository.

`init --factory` writes both after the code exchange, with `gh variable set` and `gh secret set` (`--env` for the environment). Creating secrets needs collaborator status on a personal repository and write access on an organization repository; environment secrets need admin, or ownership of a personal repository ([Using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)).

### 3.2 Orchestrate engine

It does not need the App. It holds a fine-grained PAT for one repository (`contents`, `issues`, `pull-requests`, `statuses` write; ADR 0039). A push or pull request made with a PAT does start workflows ([#483](https://github.com/mnaimfaizy/agent-kit/issues/483)), so CI runs without approval, which is the App's only job on the Workflow engine. Its Stage checks are written with the same PAT, so the gate's one identity is the user (ADR 0035). Giving this engine the App as well would put a second long-lived key, the PEM, on the user's machine next to the PAT, for no event the PAT does not already start. So in v1 `init --factory` creates the App only when the Workflow engine is chosen.

## 4. Minting the token in a job

`actions/create-github-app-token@v3` ([README](https://github.com/actions/create-github-app-token/blob/main/README.md)):

```yaml
publish:
  environment: factory-publish
  permissions: { contents: read, pull-requests: write, statuses: write, issues: write }  # GITHUB_TOKEN
  steps:
    - id: app
      uses: actions/create-github-app-token@v3   # pin to a SHA in the shipped workflow
      with:
        client-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
        private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
        permission-contents: write
        permission-pull-requests: write
    # push and open/update the PR with steps.app.outputs.token;
    # write the Stage check and comments with GITHUB_TOKEN
```

- **Inputs.** `client-id` (required; the older `app-id` is still accepted) and `private-key`. `owner` and `repositories` scope it; with neither set, **the token covers only the current repository**. `permission-<name>` narrows the permissions (by default the token inherits all of the installation's). A permission the installation lacks is an error.
- **Outputs.** `token`, `installation-id`, `app-slug`. The token is masked in logs.
- **Lifetime.** "An installation access token expires after 1 hour." The REST endpoint says the same: "Installation tokens expire one hour from the time you create them" ([REST: Apps](https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28#create-an-installation-access-token-for-an-app)). The action also revokes it in its `post` step when the job ends (unless `skip-token-revoke`), so it cannot be passed to another job. The publish job should mint it right before the push, and must finish within the hour. No refresh is documented; a new token is minted instead.
- **Scope.** Underneath is `POST /app/installations/{id}/access_tokens`, signed with a JWT made from the key. Its `repositories` / `repository_ids` (up to 500) and `permissions` narrow the token. It "cannot be granted access to repositories that the installation was not granted access to" nor "permissions that the app was not granted". So the token is bounded three times: by the App's permissions, by the installation's one repository, and by the job's `permission-*` inputs.
- **Commit identity.** The README gives `<app-slug>[bot]` and `<user-id>+<app-slug>[bot]@users.noreply.github.com`, the user id read from `https://api.github.com/users/<app-slug>%5Bbot%5D`. The publish job sets these before committing.

## 5. Answers

1. **Manifest flow.** Yes, for both a user-owned and an organization repository; only the `POST` URL differs, and an organization needs its owner (or an App manager). The CLI builds the manifest, opens a local auto-submitting form, catches the `code` and exchanges it within the hour for the App id, client ID and key. A person must be signed in, submit the form in a browser, click Create GitHub App, then install the App on the one repository (a second step the flow does not do).
2. **Minimum permissions.** The App needs only Contents: write and Pull requests: write (plus Metadata: read). Commit statuses and comments stay on `GITHUB_TOKEN` in the same job, which keeps one status creator for the gate. Contents: write exceeds what the Factory should hold: it reaches the default branch and can merge. A ruleset with no App bypass bounds it. Workflows: write is left off, so a factory branch cannot change workflows.
3. **Where the key lives.** On the Workflow engine, in an environment secret (`factory-publish`, default branch only, used only by the publish job), with the client ID as a variable. That falls back to a repository secret on a private repository on Free. The Orchestrate engine needs no App: its one-repo PAT already starts CI.
4. **Minting.** `actions/create-github-app-token@v3` with `client-id` and `private-key`. The token lasts one hour, is revoked when the job ends, and defaults to the current repository only; `permission-*` inputs narrow it further.

## UNCONFIRMED

1. Who may install an organization-owned App on the organization's repositories (the install page names no role).
2. Whether the manifest's `redirect_url` may be `http://localhost:<port>`, which the CLI's code catch relies on.
3. Whether `POST /app-manifests/{code}/conversions` needs an `Authorization` header.
4. The install URL `https://github.com/apps/<slug>/installations/new` (not on the pages read).
5. That a git push over HTTPS touching `.github/workflows` is refused for an App token without Workflows: write. The docs list Workflows as an extra permission on the contents and refs endpoints and tell Apps to request it for workflow files, but do not describe the git-protocol refusal.
6. Whether "Issues: write" alone, or "Pull requests: write" alone, is enough for a comment on a pull request (the permissions page lists the endpoint under both without saying). It is moot for the App, since `GITHUB_TOKEN` writes comments.
