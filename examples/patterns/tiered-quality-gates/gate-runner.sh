#!/usr/bin/env bash
# Pattern guide skeleton: docs/patterns/tiered-quality-gates.md in Agent-kit.
#
# The Runner of the Builder -> Reviewer -> Runner chain, and the one gate every
# tier shares. It sorts the changed paths by file type, runs the focused
# deterministic checks for each type, and for `full` the wider check as well.
# It ends with a verdict block an agent can parse. A check that checked
# nothing is NOT RUN, never PASS.
#
# Copy it into your repository, fill in each TODO(adopt), and delete the
# Pattern guide line above. Usage:
#
#   <runner command> mechanical|standard|full <path>...

set -uo pipefail

# TODO(adopt): the focused check for each file type. Each one receives the
# changed paths of that type as arguments. Leave one empty to report NOT RUN.
COMPONENT_CHECK="<lint and type check for components, given paths>"
TEST_CHECK="<run only the given test files>"
DOCS_CHECK="<format check for docs, given paths>"
# TODO(adopt): the wider check `full` adds, run once with no paths.
FULL_CHECK="<the whole type check and test suite>"
# TODO(adopt): what your tools print when they exit 0 having checked nothing
# (no matching test files, zero files linted). A check whose output matches is
# NOT RUN, not PASS. Keep it narrow, so a real pass never matches.
NOTHING_CHECKED='No test files found|0 files? (checked|linted)|No files matching'

tier="${1:-}"
shift || true
case "$tier" in
  mechanical | standard | full) ;;
  *)
    printf 'gate-runner: the first argument must be mechanical, standard or full\n' >&2
    exit 2
    ;;
esac
[ $# -gt 0 ] || {
  printf 'gate-runner: give the changed paths after the tier\n' >&2
  exit 2
}

components=()
tests=()
docs=()
unmatched=()
for path in "$@"; do
  case "$path" in
    # TODO(adopt): your paths for each file type. Tests first, so a test file
    # under a component directory is checked as a test.
    *.test.* | *.spec.*) tests+=("$path") ;;
    "<component directory>"/*) components+=("$path") ;;
    *.md | *.yml | *.yaml | *.json) docs+=("$path") ;;
    *) unmatched+=("$path") ;;
  esac
done

ran=()
not_run=()
failed=false

# run_check <label> <command> [path]... ; a label of `full` runs with no paths.
run_check() {
  local label="$1" command="$2"
  shift 2
  [ $# -gt 0 ] || [ "$label" = full ] || return 0
  if [ -z "$command" ] || [[ "$command" == "<"* ]]; then
    not_run+=("$label: no command is set for these paths")
    return 0
  fi
  local status=0 output
  # shellcheck disable=SC2086 # the command is a word list on purpose
  output="$($command "$@" 2>&1)" || status=$?
  [ -z "$output" ] || printf '%s\n' "$output"
  if [ "$status" -eq 0 ] && printf '%s' "$output" | grep -Eq "$NOTHING_CHECKED"; then
    not_run+=("$label: $command exited 0 but checked nothing")
    return 0
  fi
  ran+=("$command${*:+ $*} -> $status")
  [ "$status" -eq 0 ] || failed=true
}

run_check components "$COMPONENT_CHECK" "${components[@]+"${components[@]}"}"
run_check tests "$TEST_CHECK" "${tests[@]+"${tests[@]}"}"
run_check docs "$DOCS_CHECK" "${docs[@]+"${docs[@]}"}"
[ "$tier" != full ] || run_check full "$FULL_CHECK"
for path in "${unmatched[@]+"${unmatched[@]}"}"; do
  not_run+=("$path: no file type matched")
done

if $failed; then
  verdict=FAIL
elif [ ${#not_run[@]} -gt 0 ] || [ ${#ran[@]} -eq 0 ]; then
  verdict="NOT RUN"
else
  verdict=PASS
fi

printf -- '---\ngate-runner: %s\ntier: %s\n' "$verdict" "$tier"
for line in "${ran[@]+"${ran[@]}"}"; do printf 'ran: %s\n' "$line"; done
for line in "${not_run[@]+"${not_run[@]}"}"; do printf 'not-run: %s\n' "$line"; done
printf -- '---\n'

[ "$verdict" = PASS ]
