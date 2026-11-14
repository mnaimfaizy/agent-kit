"""Contract test: the Review response reusable workflow keeps the agent away from every write credential.

The design is ADR 0005's (docs/adr/0005-review-responder-holds-no-write-credential.md),
three jobs kept whole:

- `gate` reads the pull request live and refuses what a round must never run on.
  It runs no repository code at all.
- `respond` builds pull request code, so it holds nothing worth taking: a
  read-only job token and no OIDC grant. Everything trusted (the script, the
  skill, the hooks) is read from the trusted commit's objects, and the Work list
  and brief exist before any pull request code runs.
- `publish` runs on a fresh runner with only trusted code checked out, and is
  the only job that can write the repository or start a workflow run.

Auto mode (the Handoff) adds a `handoff` job to the review workflow: when the
Caller's mode is exactly `auto` and the review left findings, it dispatches the
Consumer's Review response Caller on the default branch. The response gate
accepts a dispatched run only from `github-actions[bot]`, on the default
branch, in `auto` mode, and for at most two rounds per pull request. A response
round never starts a review.

The script itself is covered by review-response-contract.test.mjs.
"""

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
RESPONSE = WORKFLOWS / "agent-review-response-reusable.yml"
REVIEW = WORKFLOWS / "agent-review-reusable.yml"
SCRIPT = ".github/agent-review-response/review-response.mjs"
STAGED_SCRIPT = "$RUNNER_TEMP/review-response/review-response.mjs"
CLAUDE_ACTION_SHA = "8cf3482550831fb35a4fc3fbf7ca139cf8028b4c"
AGENT_STEP = "Run review responder (Claude Code)"
PUSH_STEP = "Validate and push the round's commits"

# The responder's whole tool grant. Each entry was reviewed: no `gh`, nothing
# that pushes, no git command whose options write a file (diff, log, show), and
# the only build command is the Caller's verify commands, staged by the kit.
REVIEWED_TOOLS = {
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "Write",
    "MultiEdit",
    "Bash(git status:*)",
    "Bash(git add:*)",
    "Bash(git commit:*)",
    "Bash(git rev-parse HEAD)",
}
VERIFY_RULE = "Bash(bash $RUNNER_TEMP/review-response/verify.sh)"
MUST_DENY = {
    "Read(./.git/**)",
    "Edit(./.git/**)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(git push:*)",
    "Bash(gh:*)",
    "WebFetch",
    "WebSearch",
    "Agent",
}


def load(path: Path) -> dict:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if True in data:
        data["on"] = data.pop(True)
    return data


def workflow() -> dict:
    return load(RESPONSE)


def jobs() -> dict:
    return workflow()["jobs"]


def step(job: dict, name: str) -> dict:
    found = [s for s in job["steps"] if s.get("name") == name]
    assert len(found) == 1, f"expected one step named {name!r}"
    return found[0]


def step_index(job: dict, name: str) -> int:
    return job["steps"].index(step(job, name))


def run_steps(data: dict) -> list[tuple[str, dict]]:
    return [(job_name, s) for job_name, job in data["jobs"].items() for s in job.get("steps", []) if "run" in s]


def code(text: str) -> str:
    """A run block without its comment lines."""
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def test_the_caller_contract() -> None:
    contract = workflow()["on"]["workflow_call"]
    assert set(contract["inputs"]) == {
        "kill_switch",
        "allowlist_actors",
        "trigger_label",
        "pr_number",
        "reviewer_logins",
        "extra_protected_paths",
        "setup_commands",
        "verify_commands",
        "ci_workflow",
        "response_mode",
        "model",
    }
    assert contract["inputs"]["pr_number"]["required"] is True
    assert contract["inputs"]["trigger_label"]["default"] == "agent:address-review"
    assert contract["inputs"]["kill_switch"]["type"] == "boolean"
    # Manual unless the Caller passes exactly `auto`.
    assert contract["inputs"]["response_mode"]["default"] == ""
    for name in ("allowlist_actors", "reviewer_logins"):
        assert contract["inputs"][name]["default"] == "[]"
    # GitHub access is the job token throughout: the only secret is the
    # subscription token.
    assert set(contract["secrets"]) == {"claude_code_oauth_token"}
    assert set(workflow()["on"]) == {"workflow_call"}


def test_three_jobs_each_naming_their_permissions() -> None:
    assert list(jobs()) == ["gate", "respond", "publish"]
    for name, job in jobs().items():
        assert isinstance(job.get("permissions"), dict), f"{name}: name the permissions the job holds"
        assert job.get("if", "").find("inputs.kill_switch") != -1, f"{name}: honour the Kill switch"


def test_no_id_token_anywhere_in_the_flow() -> None:
    # With an OIDC grant, any build script in `respond` could exchange it for a
    # token that writes the repository.
    data = workflow()
    for block in [data["permissions"]] + [job["permissions"] for job in data["jobs"].values()]:
        assert "id-token" not in block
    assert "id-token" not in code(RESPONSE.read_text(encoding="utf-8"))


def test_respond_is_read_only() -> None:
    assert jobs()["respond"]["permissions"] == {"contents": "read", "pull-requests": "read"}


def test_write_permissions_only_in_publish() -> None:
    publish, gate = jobs()["publish"], jobs()["gate"]
    assert publish["permissions"] == {"contents": "write", "pull-requests": "write", "actions": "write"}
    # The gate consumes the Trigger label and says why it refused; beyond
    # reading, it holds no other grant, checks nothing out and runs no
    # repository code.
    assert gate["permissions"] == {"contents": "read", "pull-requests": "write"}
    assert not any("uses" in s for s in gate["steps"])
    assert "node " not in "\n".join(s.get("run", "") for s in gate["steps"])
    for name, job in jobs().items():
        if name != "publish":
            for scope in ("contents", "actions"):
                assert job["permissions"].get(scope) != "write", f"{name}: {scope}: write belongs to publish"


def test_the_gate_refuses_before_it_proceeds() -> None:
    gate = code(step(jobs()["gate"], "Gate")["run"])
    proceed = gate.index('echo "proceed=true"')
    needles = [
        '"" | *[!0-9]*)',  # the PR number is digits
        "index($actor) != null",  # the Allowlist
        'gh api "repos/$GITHUB_REPOSITORY/pulls/$PR"',  # the PR, live
        '"$(field .state)" != "open"',
        '"$(field .head.repo.full_name)" != "$GITHUB_REPOSITORY"',  # forks
        '"$(field .base.ref)" != "$DEFAULT_BRANCH"',  # default branch only
        '"dependabot[bot]|"* | *"|dependabot/"*)',  # Dependabot
    ]
    for needle in needles:
        at = gate.find(needle)
        assert at != -1 and at < proceed, f"the gate must check {needle!r} before it proceeds"
    # The default branch and the trusted commit are read live, not from the
    # event payload.
    assert 'gh api "repos/$GITHUB_REPOSITORY" --jq .default_branch' in gate
    assert 'gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$DEFAULT_BRANCH" --jq .object.sha' in gate
    for output in ("head_sha", "trusted_sha", "head_ref"):
        assert f'echo "{output}=' in gate, f"the gate records {output}"
    consume = step(jobs()["gate"], "Consume trigger label")
    # A dispatched round has no label of its own to consume; one a person
    # applied meanwhile is left for its own run.
    assert consume["if"] == "always() && github.event_name != 'workflow_dispatch'"
    assert '--remove-label "$LABEL"' in consume["run"]


def test_the_trusted_runtime_is_read_from_the_trusted_commit() -> None:
    respond = jobs()["respond"]
    stage = code(step(respond, "Stage the trusted runtime outside the workspace")["run"])
    # From the commit object, never the checked-out pull request tree.
    assert f'git cat-file blob "$TRUSTED_SHA:{SCRIPT}"' in stage
    assert 'git cat-file blob "$TRUSTED_SHA:.claude/skills/address-pr-review/SKILL.md"' in stage
    assert 'git cat-file blob "$TRUSTED_SHA:.github/agent-runtime/$FILE"' in stage
    assert not re.search(r"\bcp\b", stage)
    assert '"$(git rev-parse HEAD)" != "$HEAD_SHA"' in stage
    # Never the pull request's own brief or response file.
    assert 'rm -f "$GITHUB_WORKSPACE/review-response-brief.md" "$GITHUB_WORKSPACE/review-response.json"' in stage
    extract = code(step(respond, "Extract the work list")["run"])
    assert f'SCRIPT="{STAGED_SCRIPT}"' in extract
    assert "node .github/" not in extract
    # check-protected reads exactly `git diff --name-status -z` output.
    assert 'git diff --name-status -z "$TRUSTED_SHA...HEAD" > "$DIFF"' in extract
    assert 'node "$SCRIPT" check-protected < "$DIFF"' in extract
    assert extract.index("check-protected") < extract.index('node "$SCRIPT" extract')
    assert extract.index('node "$SCRIPT" extract') < extract.index('node "$SCRIPT" brief')


def test_trusted_steps_run_before_any_pull_request_code() -> None:
    respond = jobs()["respond"]
    order = [
        step_index(respond, name)
        for name in (
            "Stage the trusted runtime outside the workspace",
            "Extract the work list",
            "Stage read-confinement hook outside the workspace",
            "Install the subprocess sandbox",
            "Run caller-owned setup commands",
            "Check git configuration after setup",
            AGENT_STEP,
            "Verify read-confinement hook unchanged",
            "Collect the round",
        )
    ]
    assert order == sorted(order), "trusted steps must come before the Caller's setup runs pull request code"
    # The only steps before the Caller's setup are the checkout and kit steps.
    first = step_index(respond, "Run caller-owned setup commands")
    uses = [s["uses"].split("@")[0] for s in respond["steps"][:first] if "uses" in s]
    assert uses == ["actions/checkout"]


def test_the_sandbox_and_install_rules_are_fixed_by_the_kit() -> None:
    respond = jobs()["respond"]
    env = respond["env"]
    assert env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] == "1"
    # npm ci, npm install and pnpm all read this: `npm ci` becomes
    # `npm ci --ignore-scripts`, whatever the Caller's setup writes.
    assert env["npm_config_ignore_scripts"] == "true"
    assert env["YARN_ENABLE_SCRIPTS"] == "false"
    sandbox = code(step(respond, "Install the subprocess sandbox")["run"])
    assert "sudo apt-get install -y --no-install-recommends bubblewrap socat" in sandbox
    assert "command -v bwrap" in sandbox
    setup = step(respond, "Run caller-owned setup commands")
    assert setup["env"] == {"SETUP": "${{ inputs.setup_commands }}"}
    # The first failing command stops setup, as in the step shell itself.
    assert setup["run"].strip() == 'bash --noprofile --norc -eo pipefail -c "$SETUP"'
    # Setup ran pull request code: the git config and the staged hooks are
    # checked again before the action runs git with the subscription token.
    recheck = code(step(respond, "Check git configuration after setup")["run"])
    # With the node resolved before setup could change PATH.
    assert '"$NODE_BIN" "$STAGED/check-git-config.mjs" "$GITHUB_WORKSPACE/.git"' in recheck
    assert (
        step(respond, "Check git configuration after setup")["env"]["NODE_BIN"] == "${{ steps.confine.outputs.node }}"
    )
    # Setup can also steer later steps through $GITHUB_ENV and $GITHUB_PATH.
    for needle in ("GIT_[A-Z0-9_]*", "LD_[A-Z0-9_]*", "NODE_OPTIONS", "BASH_ENV"):
        assert needle in recheck, f"refuse {needle} left by setup"
    assert '"$(command -v git)" != "$GIT_BIN"' in recheck
    assert '"$GITHUB_WORKSPACE" | "$GITHUB_WORKSPACE"/*' in recheck
    agent_env = step(respond, AGENT_STEP)["env"]
    assert agent_env["GIT_CONFIG_COUNT"] == "0"
    assert agent_env["GIT_CONFIG_PARAMETERS"] == ""
    assert agent_env["LD_PRELOAD"] == ""
    assert '"$ACTUAL" != "$HOOK_SHA256"' in recheck
    assert step_index(respond, "Check git configuration after setup") == step_index(respond, AGENT_STEP) - 3


def test_the_agent_holds_no_write_credential_and_no_gh() -> None:
    respond = jobs()["respond"]
    agent = step(respond, AGENT_STEP)
    assert agent["uses"] == f"anthropics/claude-code-action@{CLAUDE_ACTION_SHA}"
    params = agent["with"]
    # The job token, which here can only read. Without it the action would
    # exchange OIDC for the Claude App token.
    assert params["github_token"] == "${{ github.token }}"
    assert params["claude_code_oauth_token"] == "${{ secrets.claude_code_oauth_token }}"
    assert "track_progress" not in params
    assert params["settings"] == "${{ runner.temp }}/read-confinement/implementer.settings.json"
    text = RESPONSE.read_text(encoding="utf-8")
    assert text.count("secrets.claude_code_oauth_token") == 1, "only the agent step gets the subscription token"
    args = params["claude_args"]
    assert '--allowedTools "${{ steps.tools.outputs.allowed }}"' in args
    denied = set(args.split('--disallowedTools "')[1].split('"')[0].split(","))
    assert denied >= MUST_DENY, f"deny {sorted(MUST_DENY - denied)}"

    tools = code(step(respond, "Resolve the agent's tools")["run"])
    granted = re.search(r"^DEFAULT='([^']*)'$", tools, re.MULTILINE)
    assert granted, "the default grant is one literal"
    assert set(granted.group(1).split(",")) == REVIEWED_TOOLS
    # The verify rule is added only when the Caller set verify commands, and
    # only as that exact command: the staged script, run whole.
    assert f'"{VERIFY_RULE}"' in tools
    assert tools.count("Bash(") == len([t for t in REVIEWED_TOOLS if t.startswith("Bash(")]) + 1


def test_nothing_after_the_agent_talks_to_github() -> None:
    respond = jobs()["respond"]
    after = respond["steps"][step_index(respond, AGENT_STEP) + 1 :]
    for s in after:
        block = yaml.safe_dump(s)
        assert not re.search(r"GH_TOKEN|GITHUB_TOKEN|secrets\.|github\.token", block), s["name"]
        assert not re.search(r"\bgh\s", s.get("run", "")), s["name"]
        assert "review-response.mjs" not in s.get("run", ""), s["name"]


def test_the_round_leaves_as_size_capped_data() -> None:
    respond = jobs()["respond"]
    collect = step(respond, "Collect the round")
    assert collect["if"] == "always() && steps.intact.outcome == 'success'"
    run = code(collect["run"])
    assert 'git bundle create "$BUNDLE" "$HEAD_SHA..HEAD"' in run
    assert '[ "$(wc -c < "$BUNDLE")" -le 500000 ]' in run
    # A bundle dropped for size is reported on the pull request, not only logged.
    assert 'echo "bundle_status=too-large" >> "$GITHUB_OUTPUT"' in run
    push = code(step(jobs()["publish"], PUSH_STEP)["run"])
    assert push.index('"$BUNDLE_STATUS" = "too-large"') < push.index('[ -z "$BUNDLE" ]')
    assert '[ -L "$FILE" ]' in run and '[ "$(wc -c < "$FILE")" -gt 150000 ]' in run
    # git in the agent's checkout runs no hook or fsmonitor it may have set.
    assert collect["env"]["GIT_CONFIG_KEY_0"] == "core.fsmonitor"
    assert collect["env"]["GIT_CONFIG_KEY_1"] == "core.hooksPath"
    assert respond["outputs"] == {
        "state": "${{ steps.extract.outputs.state }}",
        "bundle": "${{ steps.collect.outputs.bundle }}",
        "bundle_status": "${{ steps.collect.outputs.bundle_status }}",
        "response": "${{ steps.collect.outputs.response }}",
    }


def test_publish_runs_trusted_code_on_a_fresh_runner() -> None:
    publish = jobs()["publish"]
    assert publish["needs"] == ["gate", "respond"]
    assert [s["uses"].split("@")[0] for s in publish["steps"] if "uses" in s] == ["actions/checkout"]
    checkout = publish["steps"][0]
    assert checkout["with"]["ref"] == "${{ needs.gate.outputs.trusted_sha }}"
    body = "\n".join(code(s.get("run", "")) for s in publish["steps"])
    # No pull request commit is ever checked out here, and no build runs.
    assert not re.search(r"git (?:checkout|switch|merge|reset|am|apply)\b", body)
    assert not re.search(r"\b(?:npm|npx|bun|uv|pip) ", body)
    assert f"node {SCRIPT} publish" in body or 'node "$SCRIPT" publish' in body
    assert STAGED_SCRIPT not in body
    # The agent's output arrives as data, in the environment.
    assert step(publish, PUSH_STEP)["env"]["BUNDLE"] == "${{ needs.respond.outputs.bundle }}"
    reply = step(publish, "Reply on findings and resolve the fixed ones")
    assert reply["env"]["RESPONSE"] == "${{ needs.respond.outputs.response }}"
    assert reply["if"] == "always() && steps.state.outputs.publish == 'true'"


def test_the_push_checks_then_pushes_once_without_force() -> None:
    push = code(step(jobs()["publish"], PUSH_STEP)["run"])
    order = [
        push.find(needle)
        for needle in (
            '[ "${#BUNDLE}" -gt 700000 ]',
            "grep -q '[^A-Za-z0-9+/=]'",
            'with_token fetch --quiet --no-tags --depth=1 origin "refs/heads/$HEAD_REF"',
            '"$(git rev-parse FETCH_HEAD)" != "$START_HEAD"',
            'node "$SCRIPT" receive-round',
            'with_token push --quiet origin "$TIP:refs/heads/$HEAD_REF"',
            'echo "tip=$TIP"',
        )
    ]
    assert -1 not in order and order == sorted(order), "size, unmoved branch and validation all come before the push"
    assert f"SCRIPT={SCRIPT}" in push
    assert push.count(" push ") == 1
    assert not re.search(r"push[^\n]*(?:--force|\s-f\b|\s\+|\"\+)", push)
    # The token reaches git through the environment of single commands only.
    assert 'GIT_CONFIG_KEY_0="http.$GITHUB_SERVER_URL/.extraheader"' in push
    assert not re.search(r"git config|remote set-url|x-access-token:[^%]*@", push)


def test_ci_is_started_only_for_the_pushed_commit() -> None:
    publish = jobs()["publish"]
    ci = step(publish, "Start CI for the pushed commit")
    assert ci["if"] == "steps.push.outputs.tip != ''"
    assert ci["env"]["CI_WORKFLOW"] == "${{ inputs.ci_workflow }}"
    assert 'release-ci --sha "$TIP" --workflow "$CI_WORKFLOW"' in ci["run"]
    assert "/approve" not in RESPONSE.read_text(encoding="utf-8")


def test_no_expression_is_interpolated_into_a_run_block() -> None:
    # Everything a Caller, a pull request author or the agent can influence
    # reaches a script through the environment.
    for job_name, s in run_steps(workflow()):
        assert "${{" not in s["run"], f"{job_name}/{s.get('name')}: pass the value through env"


def test_checkouts_never_persist_credentials() -> None:
    for job_name, job in jobs().items():
        for s in job["steps"]:
            if s.get("uses", "").startswith("actions/checkout@"):
                assert s["with"]["persist-credentials"] is False, job_name


def test_review_and_response_share_one_group_per_pull_request() -> None:
    expected = {"group": "agent-kit-pr-${{ inputs.pr_number }}", "cancel-in-progress": False}
    for path in (RESPONSE, REVIEW):
        assert load(path).get("concurrency") == expected, f"{path.name}: share the per-PR concurrency group"


# ---- Auto mode: the Handoff -------------------------------------------------

HANDOFF_STEP = "Hand off to the Review response"
BOT = "github-actions[bot]"


def review_workflow() -> dict:
    return load(REVIEW)


def script_text() -> str:
    return (ROOT / SCRIPT).read_text(encoding="utf-8")


def summary_marker() -> str:
    found = re.search(r'^export const SUMMARY_MARKER = "([^"]+)";$', script_text(), re.MULTILINE)
    assert found, "the script exports its summary marker"
    return found.group(1)


def max_auto_rounds() -> int:
    found = re.search(r"^export const MAX_AUTO_ROUNDS = (\d+);$", script_text(), re.MULTILINE)
    assert found, "the script exports its round cap"
    return int(found.group(1))


def gate_code() -> str:
    return code(step(jobs()["gate"], "Gate")["run"])


def dispatch_branch(gate: str) -> str:
    """The gate's workflow_dispatch block: from its test to the matching fi."""
    start = gate.index('if [ "$EVENT" = "workflow_dispatch" ]; then')
    return gate[start : gate.index("\nfi\n", start)]


def test_the_round_cap_is_two() -> None:
    assert max_auto_rounds() == 2
    assert summary_marker() == "<!-- agent-review-response -->"


def test_the_review_caller_contract_gains_the_auto_mode_inputs() -> None:
    inputs = review_workflow()["on"]["workflow_call"]["inputs"]
    for name in ("response_mode", "response_workflow", "response_allowlist_actors"):
        assert inputs[name]["default"] == "", name
        assert inputs[name]["required"] is False, name
        assert inputs[name]["type"] == "string", name
    assert inputs["response_reviewer_logins"]["default"] == "[]"
    assert inputs["response_reviewer_logins"]["required"] is False
    # What a Caller must grant: the review's own, plus the handoff's dispatch.
    assert review_workflow()["permissions"] == {
        "contents": "read",
        "issues": "read",
        "pull-requests": "write",
        "actions": "write",
    }


def test_actions_write_is_held_by_the_handoff_job_only() -> None:
    review_jobs = review_workflow()["jobs"]
    assert list(review_jobs) == ["review", "handoff"]
    # The reviewer reads pull request code: it never holds actions: write.
    assert review_jobs["review"]["permissions"] == {"contents": "read", "issues": "read", "pull-requests": "write"}
    assert review_jobs["handoff"]["permissions"] == {
        "contents": "read",
        "pull-requests": "write",
        "actions": "write",
    }
    for name, job in review_jobs.items():
        assert "id-token" not in job["permissions"], name
    # In the response workflow, actions: write stays with publish, which starts
    # only the held CI run.
    holders = [name for name, job in jobs().items() if job["permissions"].get("actions") == "write"]
    assert holders == ["publish"]


def test_handoff_runs_only_in_auto_mode_after_a_review_that_ran() -> None:
    review_jobs = review_workflow()["jobs"]
    handoff = review_jobs["handoff"]
    assert handoff["needs"] == "review"
    condition = handoff["if"]
    # Exactly `auto`: unset, `manual`, `Auto` or anything else stays manual.
    assert "inputs.response_mode == 'auto'" in condition
    assert "!inputs.kill_switch" in condition
    assert "needs.review.result == 'success'" in condition
    assert "needs.review.outputs.proceed == 'true'" in condition
    assert "always()" not in condition
    assert review_jobs["review"]["outputs"] == {"proceed": "${{ steps.gate.outputs.proceed }}"}


def test_handoff_runs_only_trusted_code_and_dispatches_on_the_default_branch() -> None:
    handoff = review_workflow()["jobs"]["handoff"]
    checkouts = [s for s in handoff["steps"] if "uses" in s]
    assert [s["uses"].split("@")[0] for s in checkouts] == ["actions/checkout"]
    checkout = checkouts[0]
    # The default branch's tip, read live: never the pull request's code.
    assert checkout["with"]["ref"] == "${{ steps.trusted.outputs.trusted_sha }}"
    assert checkout["with"]["persist-credentials"] is False
    trusted = code(step(handoff, "Read the default branch")["run"])
    assert 'gh api "repos/$GITHUB_REPOSITORY" --jq .default_branch' in trusted
    assert 'gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$DEFAULT_BRANCH" --jq .object.sha' in trusted
    for needle in (
        '"$(field .state)" != "open"',
        '"$(field .head.repo.full_name)" != "$GITHUB_REPOSITORY"',
        '"$(field .base.ref)" != "$DEFAULT_BRANCH"',
        '"dependabot[bot]|"* | *"|dependabot/"*)',
    ):
        assert needle in trusted, f"the handoff checks {needle!r}"

    handoff_step = step(handoff, HANDOFF_STEP)
    run = code(handoff_step["run"])
    # The trusted script decides; the workflow only acts on its answer.
    assert f'DECISION="$(node {SCRIPT} handoff --pr "$PR")"' in run
    for decision in ("dispatch)", "capped)", "none)"):
        assert decision in run
    # One dispatch, of the Caller's Review response workflow, on the default
    # branch, with the pull request as its one input.
    assert run.count("/dispatches") == 1
    assert '"repos/$GITHUB_REPOSITORY/actions/workflows/${RESPONSE_WORKFLOW##*/}/dispatches"' in run
    assert '-f ref="$DEFAULT_BRANCH"' in run
    assert '-f "inputs[pr_number]=$PR"' in run
    assert "gh workflow run" not in run
    # The Caller file is checked before it is used.
    check = code(step(handoff, "Read the default branch")["run"])
    assert r"^\.github/workflows/[A-Za-z0-9_-][A-Za-z0-9._-]*\.ya?ml$" in check
    env = handoff_step["env"]
    assert env["RESPONSE_WORKFLOW"] == "${{ inputs.response_workflow }}"
    assert env["DEFAULT_BRANCH"] == "${{ steps.trusted.outputs.default_branch }}"
    assert "steps.trusted.outputs.proceed == 'true'" in handoff_step["if"]


def test_handoff_counts_the_findings_the_round_will_see() -> None:
    handoff_step = step(review_workflow()["jobs"]["handoff"], HANDOFF_STEP)
    env = handoff_step["env"]
    # The response Caller's lists, with the review's Allowlist as fallback.
    assert env["RESPONSE_ALLOWLIST"] == "${{ inputs.response_allowlist_actors }}"
    assert env["RESPONSE_REVIEWERS"] == "${{ inputs.response_reviewer_logins }}"
    assert env["REVIEW_ALLOWLIST"] == "${{ inputs.allowlist_actors }}"
    run = code(handoff_step["run"])
    assert 'ALLOWLIST="$(logins "${RESPONSE_ALLOWLIST:-${REVIEW_ALLOWLIST:-[]}}")"' in run
    assert 'REVIEWER_LOGINS="$(logins "${RESPONSE_REVIEWERS:-[]}")"' in run
    assert "export ALLOWLIST REVIEWER_LOGINS" in run
    # Validated as the response gate validates them.
    gate_logins = re.search(r"logins\(\) \{.*?\n\}", gate_code(), re.DOTALL)
    assert gate_logins and gate_logins.group(0) in run
    assert run.index("export ALLOWLIST REVIEWER_LOGINS") < run.index("handoff --pr")


def test_a_refused_dispatch_is_reported_without_failing_the_review() -> None:
    run = code(step(review_workflow()["jobs"]["handoff"], HANDOFF_STEP)["run"])
    branch = run[run.index("dispatch)") : run.index("capped)")]
    # The one dispatch is the condition of the block that reports a refusal.
    found = re.search(r"if ! gh api -X POST .*?\n\s*fi\n", branch, re.DOTALL)
    assert found, "a refused dispatch is caught"
    refused = found.group(0)
    assert "/dispatches" in refused
    assert "::error title=Review response handoff failed::" in refused
    assert 'gh pr comment "$PR"' in refused and "response_workflow" in refused
    # Reported, and the review run stays green.
    assert re.search(r"exit 0\n\s*fi\n$", refused)


def test_the_cap_is_reported_once_per_pull_request() -> None:
    run = code(step(review_workflow()["jobs"]["handoff"], HANDOFF_STEP)["run"])
    branch = run[run.index("capped)") : run.index("none)")]
    marker = "<!-- agent-review-handoff capped -->"
    # Checked by author and marker before the one comment that carries it.
    check = f'select(.user.login == "{BOT}" and (.body | startswith("{marker}")))'
    assert check in branch
    assert branch.index(check) < branch.index('if [ "$POSTED" -eq 0 ]; then') < branch.index("gh pr comment")
    assert branch.count("gh pr comment") == 1
    assert f'"{marker}"' in branch.split("gh pr comment")[0]
    # Never counted as a Response round.
    assert not marker.startswith(summary_marker())


def test_no_expression_is_interpolated_into_a_review_run_block() -> None:
    for job_name, s in run_steps(review_workflow()):
        assert "${{" not in s["run"], f"{job_name}/{s.get('name')}: pass the value through env"


def test_a_dispatch_is_accepted_only_from_the_bot_in_auto_mode() -> None:
    env = step(jobs()["gate"], "Gate")["env"]
    assert env["EVENT"] == "${{ github.event_name }}"
    assert env["ACTOR"] == "${{ github.actor }}"
    # A person re-running a dispatched run is its triggering actor.
    assert env["TRIGGERING_ACTOR"] == "${{ github.triggering_actor }}"
    assert env["MODE"] == "${{ inputs.response_mode }}"
    gate = gate_code()
    branch = dispatch_branch(gate)
    assert f'"$ACTOR" != "{BOT}"' in branch
    assert f'"$TRIGGERING_ACTOR" != "{BOT}"' in branch
    assert '"$MODE" != "auto"' in branch
    # A person is told to use the label.
    assert "apply the" in branch and "label" in branch
    assert gate.index(branch) < gate.index('echo "proceed=true"')


def test_a_dispatch_off_the_default_branch_is_refused() -> None:
    gate = gate_code()
    needle = '[ "$GITHUB_REF" != "refs/heads/$DEFAULT_BRANCH" ]'
    at = gate.find(needle)
    assert at != -1, "a dispatched run is held to the default branch"
    # Checked once the default branch is read live, and before proceeding.
    assert gate.index('gh api "repos/$GITHUB_REPOSITORY" --jq .default_branch') < at < gate.index('echo "proceed=true"')
    assert 'if [ "$DISPATCHED" = true ]; then' in gate[:at]


def test_a_dispatched_round_stops_at_the_cap() -> None:
    gate = gate_code()
    marker = summary_marker()
    # Counted as the script counts them: the bot's comments that start with
    # the summary marker, since anyone can write the marker in a comment.
    assert f'select(.user.login == "{BOT}" and (.body | startswith("{marker}")))' in gate
    assert f'[ "$ROUNDS" -ge {max_auto_rounds()} ]' in gate
    assert gate.index('[ "$ROUNDS" -ge') < gate.index('echo "proceed=true"')


def test_the_allowlist_still_gates_the_label_path() -> None:
    gate = gate_code()
    # The bot is on no Caller's Allowlist: only the dispatch path skips the
    # actor check, and guidance still comes only from the Allowlist.
    assert 'if [ -n "$GUIDANCE" ] && [ "$DISPATCHED" = false ]; then' in gate
    assert 'echo "allowlist=$GUIDANCE"' in gate


def test_a_response_round_never_starts_a_review() -> None:
    text = code(RESPONSE.read_text(encoding="utf-8"))
    # No dispatch, no new label (one applied with the job token starts no run
    # anyway), no review requested: the only workflow run a round starts is
    # the held CI run of the Caller's ci_workflow, for the commit it pushed.
    for needle in ("/dispatches", "workflow run", "--add-label", "/labels", "requested_reviewers", "agent:review"):
        assert needle not in text, f"the response workflow must not contain {needle!r}"
    starts = [s for _, s in run_steps(workflow()) if "release-ci" in s["run"]]
    assert [s["name"] for s in starts] == ["Start CI for the pushed commit"]
    # The script approves only a held `pull_request` run of that workflow.
    assert 'run.event === "pull_request"' in script_text()
    assert 'run.conclusion === "action_required"' in script_text()


if __name__ == "__main__":
    test_the_caller_contract()
    test_three_jobs_each_naming_their_permissions()
    test_no_id_token_anywhere_in_the_flow()
    test_respond_is_read_only()
    test_write_permissions_only_in_publish()
    test_the_gate_refuses_before_it_proceeds()
    test_the_trusted_runtime_is_read_from_the_trusted_commit()
    test_trusted_steps_run_before_any_pull_request_code()
    test_the_sandbox_and_install_rules_are_fixed_by_the_kit()
    test_the_agent_holds_no_write_credential_and_no_gh()
    test_nothing_after_the_agent_talks_to_github()
    test_the_round_leaves_as_size_capped_data()
    test_publish_runs_trusted_code_on_a_fresh_runner()
    test_the_push_checks_then_pushes_once_without_force()
    test_ci_is_started_only_for_the_pushed_commit()
    test_no_expression_is_interpolated_into_a_run_block()
    test_checkouts_never_persist_credentials()
    test_review_and_response_share_one_group_per_pull_request()
    test_the_round_cap_is_two()
    test_the_review_caller_contract_gains_the_auto_mode_inputs()
    test_actions_write_is_held_by_the_handoff_job_only()
    test_handoff_runs_only_in_auto_mode_after_a_review_that_ran()
    test_handoff_runs_only_trusted_code_and_dispatches_on_the_default_branch()
    test_handoff_counts_the_findings_the_round_will_see()
    test_a_refused_dispatch_is_reported_without_failing_the_review()
    test_the_cap_is_reported_once_per_pull_request()
    test_no_expression_is_interpolated_into_a_review_run_block()
    test_a_dispatch_is_accepted_only_from_the_bot_in_auto_mode()
    test_a_dispatch_off_the_default_branch_is_refused()
    test_a_dispatched_round_stops_at_the_cap()
    test_the_allowlist_still_gates_the_label_path()
    test_a_response_round_never_starts_a_review()
    print("review-response-workflow contract: ok")
