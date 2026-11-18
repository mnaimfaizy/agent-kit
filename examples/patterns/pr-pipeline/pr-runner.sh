#!/usr/bin/env bash
# Pattern guide skeleton: docs/patterns/pr-pipeline.md in Agent-kit.
#
# The only way an agent pushes a branch and opens or updates its pull request.
# Before anything is pushed it checks the drafter's merge base against its own,
# the body's Merge risk line, and each label against one allowlist. It assigns
# the pull request to the authenticated user and requests only the reviewers
# it is given.
#
# Copy it into your repository, fill in each TODO(adopt), and delete the
# Pattern guide line above. It uses the GitHub CLI; swap the gh calls for your
# forge's. Usage:
#
#   <runner command> --title <text> --body-file <path> --merge-base <sha>
#                    [--label <name>]... [--reviewer <login>]... [--draft]
#                    [--force-with-lease] [--base <branch>]

set -euo pipefail

# TODO(adopt): how a person or agent invokes this script, for the messages.
RUNNER="<runner command>"
# TODO(adopt): your base branch, used when the remote names no default.
DEFAULT_BASE="main"
# TODO(adopt): one label per line; comments start with #.
LABEL_ALLOWLIST="<path to your label allowlist>"
# The Merge risk line the drafter writes. Keep it equal to the drafter's rule.
RISK_LINE='^\*\*Reversible:\*\* (yes|no)( — .+)?$'

fail() {
  printf 'pr-runner: %s\n' "$1" >&2
  exit 1
}

title=""
body_file=""
merge_base=""
base=""
draft=false
lease=false
labels=()
reviewers=()

while [ $# -gt 0 ]; do
  case "$1" in
    --title) title="${2:-}"; shift 2 ;;
    --body-file) body_file="${2:-}"; shift 2 ;;
    --merge-base) merge_base="${2:-}"; shift 2 ;;
    --base) base="${2:-}"; shift 2 ;;
    --label) labels+=("${2:-}"); shift 2 ;;
    --reviewer) reviewers+=("${2:-}"); shift 2 ;;
    --draft) draft=true; shift ;;
    --force-with-lease) lease=true; shift ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ -n "$title" ] || fail "--title is required."
[ -r "$body_file" ] || fail "--body-file is required and must be readable."
[ -n "$merge_base" ] || fail "--merge-base is required: pass the MERGE-BASE: SHA from the draft. A draft without one was not read from the branch."

gh auth status >/dev/null 2>&1 || fail "gh is not authenticated. Run gh auth login, then $RUNNER again."

branch="$(git branch --show-current)"
[ -n "$branch" ] || fail "not on a branch."
if [ -z "$base" ]; then
  base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  base="${base#origin/}"
  base="${base:-$DEFAULT_BASE}"
fi
[ "$branch" != "$base" ] || fail "refusing to open a pull request from the base branch '$base'."

# 1. Proof of inspection: the drafter's merge base must match this branch's.
computed="$(git merge-base "origin/$base" HEAD 2>/dev/null || git merge-base "$base" HEAD 2>/dev/null || true)"
[ -n "$computed" ] || fail "cannot compute the merge base with '$base'. Fetch it with history, then $RUNNER again."
supplied="$(printf '%s' "$merge_base" | tr '[:upper:]' '[:lower:]')"
[[ "$supplied" =~ ^[0-9a-f]{7,40}$ ]] || fail "--merge-base '$merge_base' is not a commit SHA of 7 to 40 hex characters."
[[ "$computed" == "$supplied"* ]] ||
  fail "--merge-base $supplied does not match this branch's merge base $computed. The draft describes another branch, or was written without inspecting it. Draft again."

[ -n "$(git rev-list "$computed..HEAD")" ] || fail "no commits between '$base' and '$branch'."

# 2. The Merge risk line must be readable.
grep -Eq "$RISK_LINE" "$body_file" ||
  fail "the body has no readable '**Reversible:** yes|no' line. Send the draft back to the drafter with this message."
# TODO(adopt): also check any other line your automation reads from the body.

# 3. Labels: only names on the allowlist.
if [ "${#labels[@]}" -gt 0 ]; then
  [ -r "$LABEL_ALLOWLIST" ] || fail "cannot read the label allowlist $LABEL_ALLOWLIST."
  for label in "${labels[@]}"; do
    grep -v '^#' "$LABEL_ALLOWLIST" | grep -Fxq -- "$label" ||
      fail "'$label' is not on the label allowlist $LABEL_ALLOWLIST."
  done
fi

# 4. Push. A diverged remote is refused unless the caller asks for a lease,
# which is pinned to the remote commit observed here. Compare with the remote
# branch of the same name, not @{u}: a branch made from origin/<base> tracks
# the base branch, which would look like a divergence and pin the lease to
# the wrong ref.
upstream="origin/$branch"
remote_ref="refs/remotes/$upstream"
git fetch --quiet origin "$branch" 2>/dev/null || true
if git rev-parse --verify --quiet "$remote_ref" >/dev/null; then
  read -r behind ahead < <(git rev-list --left-right --count "$remote_ref...HEAD")
  if [ "$behind" -gt 0 ] && [ "$ahead" -gt 0 ]; then
    [ "$lease" = true ] ||
      fail "$upstream has commits this branch does not. After a rebase, run $RUNNER again with --force-with-lease. Never force-push."
    remote_sha="$(git rev-parse "$remote_ref")"
    # TODO(adopt): refuse here when the remote holds a commit with no
    # equivalent on this branch (git cherry, plus author and subject), which
    # is someone else's work rather than a rebased copy of yours.
    git push --force-with-lease="$branch:$remote_sha" origin "HEAD:$branch"
  elif [ "$behind" -gt 0 ]; then
    fail "$upstream is ahead of this branch. Pull or rebase first."
  elif [ "$ahead" -gt 0 ]; then
    git push origin "HEAD:$branch"
  fi
else
  git push --set-upstream origin "HEAD:$branch"
fi

# 5. Create, or reuse the open pull request for this branch.
reviewer_args=()
for reviewer in "${reviewers[@]+"${reviewers[@]}"}"; do
  reviewer_args+=(--reviewer "$reviewer")
done
label_args=()
for label in "${labels[@]+"${labels[@]}"}"; do
  label_args+=(--label "$label")
done

existing="$(gh pr list --head "$branch" --base "$base" --state open --json url --jq '.[0].url // empty')"
if [ -n "$existing" ]; then
  # TODO(adopt): to sync labels, remove allowlisted labels the draft no
  # longer chose; leave labels outside the allowlist alone.
  edit_args=(--title "$title" --body-file "$body_file" --add-assignee @me)
  for label in "${labels[@]+"${labels[@]}"}"; do
    edit_args+=(--add-label "$label")
  done
  for reviewer in "${reviewers[@]+"${reviewers[@]}"}"; do
    edit_args+=(--add-reviewer "$reviewer")
  done
  gh pr edit "$existing" "${edit_args[@]}"
  printf '%s\n' "$existing"
  exit 0
fi

create_args=(--base "$base" --head "$branch" --title "$title" --body-file "$body_file" --assignee @me)
[ "$draft" = true ] && create_args+=(--draft)
gh pr create "${create_args[@]}" "${label_args[@]+"${label_args[@]}"}" "${reviewer_args[@]+"${reviewer_args[@]}"}"
