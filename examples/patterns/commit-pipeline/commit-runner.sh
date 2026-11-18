#!/usr/bin/env bash
# Pattern guide skeleton: docs/patterns/commit-pipeline.md in Agent-kit.
#
# The only way an agent commits. It refuses an empty index and secret-looking
# paths, runs `git commit` with every hook, and ends each failure with a
# trailer that names a reason and the next command to run.
#
# Copy it into your repository, fill in each TODO(adopt), and delete the
# Pattern guide line above. Usage:
#
#   <runner command> --message-file <path>
#
# There is deliberately no flag that skips hooks. Do not add one.

set -uo pipefail

# TODO(adopt): how a person or agent invokes this script, for the hints below.
RUNNER="<runner command>"

# Each pattern below must match only a line your hook prints when that check
# FAILS. Hook managers print a line for every hook, passed ones included, so a
# bare tool name matches on every commit and labels the wrong check. Match the
# failure line itself, for example 'formatter-name\.+Failed'.

# TODO(adopt): a pattern for your formatter hook's failure line, and the
# command that fixes it.
FORMAT_PATTERN='<formatter failure line, e.g. formatter-name\.+Failed>'
FORMAT_HINT='<your format command>'

# TODO(adopt): a pattern for your linter hook's failure line, and the command
# to rerun it. To name a scope in the trailer, also set a pattern whose first
# capture group is the project or package name.
LINT_PATTERN='<linter failure line, e.g. linter-name\.+Failed>'
LINT_SCOPE_PATTERN=''
LINT_HINT='<your lint command>'

# TODO(adopt): a pattern that identifies your hook manager's output.
HOOK_PATTERN='<hook manager name>|pre-commit'

trailer() {
  # trailer <reason> <hint> [scope] [paths]
  {
    printf -- '---\n'
    printf 'commit-runner: failed\n'
    printf 'reason: %s\n' "$1"
    [ -n "${3:-}" ] && printf 'scope: %s\n' "$3"
    [ -n "${4:-}" ] && printf 'paths: %s\n' "$4"
    printf 'hint: %s\n' "$2"
    printf -- '---\n'
  } >&2
}

fail() {
  # fail <message> <reason> <hint> [scope] [paths]
  printf '%s\n' "$1" >&2
  trailer "$2" "$3" "${4:-}" "${5:-}"
  exit 1
}

# A secret-looking path, judged by its file name only. This is a backstop for
# an accidental stage, not a secret scanner.
# TODO(adopt): match your repository's own secret files and allowed examples.
is_secret_path() {
  local base="${1##*/}"
  case "$base" in
    .env.example | .env.sample | .env.template) return 1 ;;
    .env | .env.*) return 0 ;;
    credentials.json) return 0 ;;
    *.pem | *.p12 | *.pfx | *.keystore | *.key) return 0 ;;
    id_rsa | id_dsa | id_ecdsa | id_ed25519) return 0 ;;
  esac
  return 1
}

message_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --message-file)
      message_file="${2:-}"
      shift 2 || shift
      ;;
    -h | --help)
      printf 'Usage: %s --message-file <path>\n' "$RUNNER"
      exit 0
      ;;
    *)
      fail "Unknown argument: $1" unknown "$RUNNER --message-file <path>"
      ;;
  esac
done

[ -n "$message_file" ] || fail "A message file is required." unknown "$RUNNER --message-file <path>"
[ -r "$message_file" ] || fail "Cannot read $message_file." unknown "Write the message to a file, then pass its path."
grep -q '[^[:space:]]' "$message_file" || fail "The commit message is empty." unknown "Draft the message again."

if git diff --cached --quiet; then
  fail "Nothing is staged." empty-index "Stage the intended paths by name (never git add .), then run $RUNNER again."
fi

blocked=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if is_secret_path "$path"; then
    blocked="${blocked:+$blocked, }$path"
  fi
done < <(git diff --cached --name-only --diff-filter=ACMR)

if [ -n "$blocked" ]; then
  fail "Refusing to commit secret-looking paths: $blocked" secret \
    "git restore --staged <path> for each path, then run $RUNNER again." "" "$blocked"
fi

output_file="$(mktemp)"
trap 'rm -f "$output_file"' EXIT

# The hooks run here. Their output reaches the terminal and is kept for the
# classifier below.
git commit --file "$message_file" 2>&1 | tee "$output_file"
status="${PIPESTATUS[0]}"

if [ "$status" -eq 0 ]; then
  exit 0
fi

if grep -Eqi "$LINT_PATTERN" "$output_file"; then
  scope=""
  if [ -n "$LINT_SCOPE_PATTERN" ]; then
    scope="$(sed -nE "s/.*${LINT_SCOPE_PATTERN}.*/\\1/p" "$output_file" | sort -u | paste -sd, -)"
  fi
  trailer lint "$LINT_HINT" "$scope"
elif grep -Eqi "$FORMAT_PATTERN" "$output_file"; then
  trailer format "$FORMAT_HINT"
elif grep -Eqi "$HOOK_PATTERN" "$output_file"; then
  trailer hook "Read the hook output above, fix that check, then run $RUNNER again."
else
  trailer unknown "Read the git output above, fix the cause, then run $RUNNER again."
fi
# TODO(adopt): add an elif per reason you add, such as `message` for a
# commit-msg hook, before the `hook` branch.

exit "$status"
