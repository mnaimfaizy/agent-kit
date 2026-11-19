"""Contract for the deep-scan reusable workflow (#373, spec #362, ADR 0018).

The opt-in CI path for a Deep scan: a reusable workflow, separate from the
static `security-audit-reusable.yml`, that runs `agent-kit deep-scan` on an
ephemeral GitHub-hosted runner with gVisor. Two seams: the workflow parsed as
YAML (triggers, secrets, step order, pins), and its input check step's own
script, run under bash.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
WORKFLOW = WORKFLOWS / "deep-scan-reusable.yml"
STATIC = WORKFLOWS / "security-audit-reusable.yml"
CALLER = ROOT / "examples" / "deep-scan-caller.yml"
LAUNCHER = "Run the deep scan (agent-kit deep-scan)"
CHECK = "Check model and limit inputs"
STAGE = "Stage trusted delivery scripts"
# Uploads and caches outlive the job and are readable beyond Private delivery.
UPLOADS = re.compile(r"actions/(upload-artifact|upload-pages-artifact|cache|attest)")


def raw() -> str:
    return WORKFLOW.read_text(encoding="utf-8")


def workflow() -> dict:
    data = yaml.safe_load(raw())
    # PyYAML reads the bare `on:` key as the boolean True.
    data["on"] = data.pop(True)
    return data


def job() -> dict:
    jobs = workflow()["jobs"]
    assert list(jobs) == ["deep_scan"], "one job, so every step shares the one ephemeral runner"
    return jobs["deep_scan"]


def steps() -> list[dict]:
    return job()["steps"]


def step(name: str) -> dict:
    found = [s for s in steps() if s.get("name") == name]
    assert len(found) == 1, f"one step named {name!r}"
    return found[0]


def index(name: str) -> int:
    return [s.get("name") for s in steps()].index(name)


def text(s: dict) -> str:
    return yaml.safe_dump(s, width=10_000)


def test_it_is_a_reusable_workflow_only() -> None:
    assert list(workflow()["on"]) == ["workflow_call"]


def test_it_runs_on_the_default_branch_only_never_a_pull_request() -> None:
    data = raw()
    for event in ("pull_request", "pull_request_target", "issue_comment", "push"):
        assert event not in workflow()["on"], event
    condition = job()["if"]
    assert "!inputs.kill_switch" in condition
    assert "github.event_name == 'schedule'" in condition
    assert "github.event_name == 'workflow_dispatch'" in condition
    assert "pull_request" not in condition
    gate = step("Gate")["run"]
    # The default branch comes from the API (a schedule event's payload has
    # no repository), and the run's ref must be exactly that branch.
    assert "gh api" in gate and ".default_branch" in gate
    assert '"$GITHUB_REF" != "refs/heads/$DEFAULT_BRANCH"' in gate
    # Never a Caller-named head: the checkout takes no ref input.
    checkout = next(s for s in steps() if str(s.get("uses", "")).startswith("actions/checkout@"))
    assert "ref" not in (checkout.get("with") or {})
    assert checkout["with"]["persist-credentials"] is False
    assert "head_sha" not in data and "pr_number" not in data


def test_runner_is_ephemeral_github_hosted_with_gvisor() -> None:
    assert job()["runs-on"] == "ubuntu-latest"
    install = step("Install gVisor (pinned, checksum-verified)")["run"]
    assert re.search(r'GVISOR_RELEASE="\d{8}"', install), "a dated release, never latest"
    assert "releases/release/${GVISOR_RELEASE}/x86_64/gvisor.tar.bz2" in install
    assert "latest" not in install
    assert re.search(r"GVISOR_SHA512=\"?[0-9a-f]{128}", install)
    assert "sha512sum --check --strict" in install
    assert "runsc install" in install
    assert index("Install gVisor (pinned, checksum-verified)") < index(LAUNCHER)


def test_inputs_are_the_kill_switch_the_model_and_the_limits() -> None:
    inputs = workflow()["on"]["workflow_call"]["inputs"]
    assert set(inputs) == {"kill_switch", "model", "setup_minutes", "scan_minutes", "max_turns", "max_tokens"}
    assert inputs["kill_switch"]["default"] is False
    assert inputs["model"]["default"] == "claude-opus-5-5"
    # The launcher's own defaults.
    assert {k: inputs[k]["default"] for k in ("setup_minutes", "scan_minutes", "max_turns", "max_tokens")} == {
        "setup_minutes": 20,
        "scan_minutes": 60,
        "max_turns": 200,
        "max_tokens": 5_000_000,
    }


def test_the_model_secret_reaches_the_launcher_step_alone() -> None:
    secrets = workflow()["on"]["workflow_call"]["secrets"]
    assert secrets["anthropic_api_key"]["required"] is True
    holders = [s.get("name") for s in steps() if "secrets.anthropic_api_key" in text(s)]
    assert holders == [LAUNCHER]
    assert "anthropic_api_key" not in yaml.safe_dump(job().get("env", {}))
    assert step(LAUNCHER)["env"]["ANTHROPIC_API_KEY"] == "${{ secrets.anthropic_api_key }}"


def test_no_github_token_or_advisory_token_reaches_the_launcher() -> None:
    launcher = text(step(LAUNCHER))
    for token in ("github.token", "GITHUB_TOKEN", "GH_TOKEN", "advisories_token", "secrets.", "ADVISORY"):
        if token == "secrets.":
            assert launcher.count("secrets.") == 1, "only the model secret"
            continue
        assert token not in launcher, token
    job_env = yaml.safe_dump(job().get("env", {}))
    for token in ("github.token", "secrets."):
        assert token not in job_env, f"job env holds {token}"
    # The CLI is installed in its own step, with no secret, its scripts off.
    install = step("Install the agent-kit CLI (pinned)")
    assert "secrets." not in text(install) and "--ignore-scripts" in install["run"]
    assert index("Install the agent-kit CLI (pinned)") < index(LAUNCHER)


def test_the_cli_pin_is_this_tags_cli_version() -> None:
    version = json.loads((ROOT / "cli" / "package.json").read_text(encoding="utf-8"))["version"]
    install = step("Install the agent-kit CLI (pinned)")["run"]
    assert f"@mnaimfaizy/agent-kit@{version}" in install, "release.py's bump_pins moves this pin"


def test_the_launcher_writes_the_report_where_delivery_reads_it() -> None:
    launcher = step(LAUNCHER)["run"]
    for flag in (
        "--default-branch",
        "--model",
        "--setup-minutes",
        "--scan-minutes",
        "--max-turns",
        "--max-tokens",
        "--report",
    ):
        assert flag in launcher, flag
    assert "--verify" not in launcher, "--verify has no CI form"
    assert '--report "$REPORT"' in launcher


def test_delivery_runs_after_teardown_from_staged_digest_checked_scripts() -> None:
    stage = step(STAGE)
    assert index(STAGE) < index(LAUNCHER)
    assert 'git show "$GITHUB_SHA:.github/security-audit/publish-draft-advisory.sh"' in stage["run"]
    assert 'git show "$GITHUB_SHA:.github/security-audit/notify-email.sh"' in stage["run"]
    delivery = [s for s in steps() if "advisories_token" in text(s) or "notify_email_to" in text(s)]
    names = [s["name"] for s in delivery]
    assert "Publish draft GHSA (private delivery)" in names
    for s in delivery:
        if s["name"] == "Gate":
            continue
        # The launcher tears the sandbox down before it exits.
        assert index(s["name"]) > index(LAUNCHER), s["name"]
        run = s["run"]
        assert "$STAGED_DIR/" in run and "sha256sum -c --quiet -" in run, s["name"]
        runs = re.search(r'^\s*(if ! )?"\$SCRIPT" ', run, re.MULTILINE)
        assert runs and run.index("sha256sum -c") < runs.start(), s["name"]
        assert "${{ steps.stage.outputs." in yaml.safe_dump(s["env"]), s["name"]


def test_delivery_logs_no_counts() -> None:
    # The publisher logs the report's counts for the static audit; here its
    # stdout goes nowhere, so the public status stays counts-free.
    for name in ("Publish draft GHSA (private delivery)", "Email the report", "Email report after failed publish"):
        assert '"$SCRIPT"' in step(name)["run"]
        assert re.search(r'"\$SCRIPT"[^\n]*> ?/dev/null', step(name)["run"]), name
    status = step("Status")["run"]
    assert "finding_count" not in status and "max_severity" not in status
    assert "finding_count" not in raw().split("- name: Status", 1)[1]


def test_nothing_is_uploaded_or_cached() -> None:
    data = raw()
    assert not UPLOADS.search(data), UPLOADS.search(data)
    assert "GITHUB_STEP_SUMMARY" not in data
    # setup-node caches on its own when package.json names a packageManager.
    node = next(s for s in steps() if str(s.get("uses", "")).startswith("actions/setup-node@"))
    assert node["with"].get("package-manager-cache") is False
    assert "cache" not in node["with"]
    for s in steps():
        uses = str(s.get("uses", ""))
        assert not uses or uses.startswith(("actions/checkout@", "actions/setup-node@")), uses


def test_timeout_is_above_the_sum_of_the_phase_limits() -> None:
    timeout = job()["timeout-minutes"]
    assert isinstance(timeout, int)
    inputs = workflow()["on"]["workflow_call"]["inputs"]
    assert timeout > inputs["setup_minutes"]["default"] + inputs["scan_minutes"]["default"]
    check = step(CHECK)
    match = re.search(r"MAX_PHASE_MINUTES=(\d+)", check["run"])
    assert match, "the check names the largest phase sum it accepts"
    assert int(match.group(1)) < timeout


def test_permissions_are_read_only() -> None:
    assert workflow()["permissions"] == {"contents": "read"}
    assert "permissions" not in job()


def test_actions_are_sha_pinned() -> None:
    for s in steps():
        if "uses" in s:
            assert re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", s["uses"]), s["uses"]


def test_the_static_workflow_is_untouched_in_kind() -> None:
    # Its tool list and its "no Bash" invariant are pinned by
    # security-audit-contract.test.py; here, that it gains no deep mode.
    static = STATIC.read_text(encoding="utf-8")
    assert 'echo "allowed=Read,Glob,Grep,Write"' in static
    assert "deep-scan" not in static and "runsc" not in static


def test_caller_example() -> None:
    caller = yaml.safe_load(CALLER.read_text(encoding="utf-8"))
    on = caller.pop(True)
    assert set(on) == {"schedule", "workflow_dispatch"}
    (only,) = caller["jobs"].values()
    assert re.fullmatch(r"mnaimfaizy/agent-kit/\.github/workflows/deep-scan-reusable\.yml@v\S+", only["uses"])
    assert only["secrets"]["anthropic_api_key"] == "${{ secrets.AGENT_KIT_DEEP_SCAN_ANTHROPIC_API_KEY }}"
    assert only["with"]["kill_switch"] == "${{ vars.CLAUDE_DEEP_SCAN_ENABLED != 'true' }}"
    assert caller["permissions"] == {"contents": "read"}


# --- the input check, run under bash -------------------------------------------


def run_check(**inputs: str) -> subprocess.CompletedProcess:
    env = {k.upper(): v for k, v in inputs.items()}
    defaults = {"MODEL": "claude-opus-5-5", "SETUP_MINUTES": "20", "SCAN_MINUTES": "60", "MAX_TURNS": "200"}
    defaults["MAX_TOKENS"] = "5000000"
    bash = shutil.which("bash")
    assert bash, "bash is needed to run the check step"
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "check.sh"
        script.write_text(step(CHECK)["run"], encoding="utf-8", newline="\n")
        return subprocess.run(
            [bash, str(script)],
            env={**os.environ, **defaults, **env},
            capture_output=True,
            text=True,
            check=False,
        )


def test_the_check_reads_its_inputs_through_env() -> None:
    check = step(CHECK)
    assert index(CHECK) == 0
    assert "${{" not in check["run"]
    assert check["env"]["MODEL"] == "${{ inputs.model }}"


def test_the_check_accepts_the_defaults_and_a_raised_scan() -> None:
    assert run_check().returncode == 0, run_check().stdout
    assert run_check(scan_minutes="120", setup_minutes="25.5").returncode == 0


def test_the_check_refuses_a_bad_model_or_limit_and_a_sum_past_the_timeout() -> None:
    for bad in ({"model": "m --x"}, {"model": ""}, {"max_turns": "1.5"}, {"max_tokens": "0"}, {"scan_minutes": "-1"}):
        result = run_check(**bad)
        assert result.returncode == 1, bad
        assert "::error" in result.stdout, bad
    over = run_check(setup_minutes="60", scan_minutes="120")
    assert over.returncode == 1
    assert "timeout-minutes" in over.stdout
    # The values are never echoed back.
    assert "m --x" not in run_check(model="m --x").stdout


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("deep-scan-workflow-contract tests passed")
