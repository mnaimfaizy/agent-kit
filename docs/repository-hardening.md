# Repository hardening

The implementer acts with the Claude GitHub App token, and an `extra_allowed_tools` entry that runs repository code hands that token to code the agent can change (see [security-model.md](security-model.md#workflow-controls)). The workflows cannot stop that code from pushing with the token. Your repository settings can: protect the default branch, release branches and release tags with rulesets that the App is not on the bypass list of.

Set these up in the Consumer before you grant an `extra_allowed_tools` entry that runs repository code. Each command below is ready to run from a clone of the Consumer with an admin `gh` login: `gh api` fills in `{owner}` and `{repo}` from the current repository. Agent-kit never changes these settings for you.

## Before you start

List the rulesets you already have, so you update one rather than add a second with the same job:

```bash
gh api repos/{owner}/{repo}/rulesets --jq '.[] | "\(.id)  \(.target)  \(.name)"'
```

To change an existing ruleset, send the same body with `gh api -X PUT repos/{owner}/{repo}/rulesets/<id> --input -`; a `PUT` replaces the whole ruleset.

The bypass lists below use the base repository roles: `actor_id` `5` is Admin and `2` is Maintain. A user-owned repository has no Maintain role (its owner is the admin, collaborators get write), so there you can drop the Maintain entry. Never add the Claude GitHub App (an `Integration` actor), a team it acts through, or the Write role.

## 1. Default branch: an `update` rule

A required pull request is not enough. With zero required approvals, the App can open a pull request and merge it itself, because the merge satisfies the `pull_request` rule. Only an `update` rule stops it: it lets no one but the bypass list change the branch, merges included.

```bash
gh api -X POST repos/{owner}/{repo}/rulesets --input - <<'EOF'
{"name":"default branch","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},
  {"type":"update","parameters":{"update_allows_fetch_and_merge":false}},
  {"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false}}],
 "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"},
  {"actor_id":2,"actor_type":"RepositoryRole","bypass_mode":"always"}]}
EOF
```

To also require CI, add a `required_status_checks` rule naming your own check runs. Pin each check to GitHub Actions (`"integration_id":15368`) so another app cannot report a check with the same name:

```json
{
  "type": "required_status_checks",
  "parameters": {
    "strict_required_status_checks_policy": true,
    "do_not_enforce_on_create": false,
    "required_status_checks": [{ "context": "Tests", "integration_id": 15368 }]
  }
}
```

Agent-kit's own `main` ruleset is a working example of this recipe, with its required checks; its command is in [CONTRIBUTING.md](../CONTRIBUTING.md#branch-protection).

### Merge policy

Once the `update` rule exists, only the bypass list can merge, through the bypass. Everyone else, the App included, can open pull requests but not merge them.

- Merge after CI is green. The bypass skips every rule in the ruleset, required status checks included, so GitHub will not hold the merge for you.
- Keep required approvals at zero if one maintainer owns the repository. GitHub never counts a pull request's author as its reviewer, so a required review would block that maintainer's own pull requests. With more maintainers, a required approval adds a second pair of eyes; the `update` rule is what keeps the App out either way.

## 2. Release branches: a `creation` rule

If you cut releases from branches, stop anyone outside the bypass list from creating one. Change the pattern to match your naming; `**/*` matches any depth below `release/`:

```bash
gh api -X POST repos/{owner}/{repo}/rulesets --input - <<'EOF'
{"name":"release branches","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/heads/release/**/*"],"exclude":[]}},
 "rules":[{"type":"creation"},{"type":"deletion"},{"type":"non_fast_forward"},
  {"type":"update","parameters":{"update_allows_fetch_and_merge":false}}],
 "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"},
  {"actor_id":2,"actor_type":"RepositoryRole","bypass_mode":"always"}]}
EOF
```

The `update` and `deletion` rules keep an existing release branch as protected as its creation; drop them if your release branches take ordinary pull requests.

## 3. Release tags: a `v*` tag ruleset

Block creating, moving, deleting and force-updating any `v*` tag:

```bash
gh api -X POST repos/{owner}/{repo}/rulesets --input - <<'EOF'
{"name":"release tags","target":"tag","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},
 "rules":[{"type":"creation"},{"type":"update"},{"type":"deletion"},{"type":"non_fast_forward"}],
 "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"},
  {"actor_id":2,"actor_type":"RepositoryRole","bypass_mode":"always"}]}
EOF
```

If a workflow pushes your release tags, it needs a bypass too. In an organization, add the GitHub Actions app (`{"actor_id":15368,"actor_type":"Integration","bypass_mode":"always"}`); on a personal account that is refused, see below.

## Personal-account repositories: pushing release tags

> **Consumer-side pattern.** This section is about your own release workflow. Agent-kit does not ship or test it; it records a fix that worked in a Consumer.

Check who owns the repository:

```bash
gh api repos/{owner}/{repo} --jq .owner.type
```

On a repository owned by a `User`, the GitHub Actions app cannot be a ruleset bypass actor. Adding it fails with 422:

```text
Actor GitHub Actions integration must be part of the ruleset source or owner organization
```

So once the tag ruleset is on, a release workflow that pushes tags with `GITHUB_TOKEN` is refused. The fix is to push the tag over SSH with a deploy key that has write access, and give the tag ruleset a `DeployKey` bypass.

1. Create the key and store its private half as a secret. Keep the private key out of the repository and delete the local copy afterwards:

   ```bash
   ssh-keygen -t ed25519 -N '' -C release-tags -f release-tags
   gh repo deploy-key add release-tags.pub --allow-write --title release-tags
   gh secret set RELEASE_TAG_DEPLOY_KEY < release-tags
   rm release-tags release-tags.pub
   ```

2. Add the deploy-key bypass to the tag ruleset. `DeployKey` takes a `null` `actor_id` and covers every deploy key with write access, so keep that list to this one key:

   ```bash
   gh api -X PUT repos/{owner}/{repo}/rulesets/<id> --input - <<'EOF'
   {"name":"release tags","target":"tag","enforcement":"active",
    "conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},
    "rules":[{"type":"creation"},{"type":"update"},{"type":"deletion"},{"type":"non_fast_forward"}],
    "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"},
     {"actor_id":null,"actor_type":"DeployKey","bypass_mode":"always"}]}
   EOF
   ```

3. Push the tag with the key in the release workflow. The step trusts GitHub's published host keys rather than whatever answers on port 22:

   ```yaml
   - name: Push release tag
     env:
       DEPLOY_KEY: ${{ secrets.RELEASE_TAG_DEPLOY_KEY }}
       TAG: ${{ steps.version.outputs.tag }}
     run: |
       install -m 700 -d ~/.ssh
       printf '%s\n' "$DEPLOY_KEY" > ~/.ssh/release_tag_key
       chmod 600 ~/.ssh/release_tag_key
       curl -fsSL https://api.github.com/meta | jq -r '.ssh_keys[] | "github.com " + .' > ~/.ssh/known_hosts
       git tag "$TAG"
       GIT_SSH_COMMAND='ssh -i ~/.ssh/release_tag_key -o IdentitiesOnly=yes' \
         git push "git@github.com:${GITHUB_REPOSITORY}.git" "refs/tags/$TAG"
   ```

> **Warning: double builds.** A tag pushed with `GITHUB_TOKEN` does not start workflows, so release workflows often start their tag build explicitly (`gh workflow run`, or a `workflow_dispatch` call) after the push. A deploy-key push does start `on: push: tags` workflows. Remove the explicit `workflow_dispatch` chaining when you switch, or every release builds twice.
