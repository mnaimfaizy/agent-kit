"""Contract for each Stage's harness, model, effort and model credential (issues #246
and #457, ADRs 0009, 0022 and 0030).

Two seams: each reusable workflow's `workflow_call` inputs and step wiring,
parsed as YAML, and the input check step's own script, run under bash.
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
CHECK_STEP = "Check the harness, model, effort and credential"
# The job whose first step is the check, and the job that runs the agent.
REUSABLE = {
    "agent-plan-reusable.yml": ("plan", "plan"),
    "agent-implement-reusable.yml": ("implement", "implement"),
    "agent-review-reusable.yml": ("review", "review"),
    "agent-review-response-reusable.yml": ("gate", "respond"),
    "security-audit-reusable.yml": ("security_audit", "security_audit"),
}
# How each workflow's messages name its Stage.
STAGE_NAMES = {
    "agent-plan-reusable.yml": "plan",
    "agent-implement-reusable.yml": "implement",
    "agent-review-reusable.yml": "review",
    "agent-review-response-reusable.yml": "Review response",
    "security-audit-reusable.yml": "security audit",
}
DEFAULT_MODEL = "claude-opus-5-5"
PROVIDER_SECRETS = (
    "claude_code_oauth_token",
    "anthropic_api_key",
    "openai_api_key",
    "gemini_api_key",
    "cursor_api_key",
)
# The harnesses of ADR 0022 that no Stage runs yet.
UNWIRED = ("codex", "gemini", "opencode", "cursor", "custom:my-harness")
EFFORT_FLAG = "${{ inputs.effort != '' && format('--effort {0}', inputs.effort) || '' }}"


def workflow(name: str) -> dict:
    data = yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))
    # PyYAML reads the bare `on:` key as the boolean True.
    data["on"] = data.pop(True)
    return data


def agent_step(job: dict) -> dict:
    return next(s for s in job["steps"] if "claude-code-action" in str(s.get("uses", "")))


def check_step(name: str) -> dict:
    first_job = REUSABLE[name][0]
    return workflow(name)["jobs"][first_job]["steps"][0]


def test_harness_model_and_effort_inputs() -> None:
    for name in REUSABLE:
        inputs = workflow(name)["on"]["workflow_call"]["inputs"]
        assert inputs["harness"]["type"] == "string", name
        assert inputs["harness"]["required"] is False, name
        assert inputs["harness"]["default"] == "claude-code", name
        # Empty by default: the check step fills in the harness's own model (ADR 0022).
        assert inputs["model"]["default"] == "", name
        assert inputs["effort"]["type"] == "string", name
        assert inputs["effort"]["required"] is False, name
        assert inputs["effort"]["default"] == "", name


def test_every_model_secret_is_optional_and_named_for_its_provider() -> None:
    for name in REUSABLE:
        secrets = workflow(name)["on"]["workflow_call"]["secrets"]
        for secret in PROVIDER_SECRETS:
            assert secrets[secret]["required"] is False, (name, secret)


def test_check_is_the_first_step_and_reads_inputs_only_through_env() -> None:
    for name, (first_job, agent_job) in REUSABLE.items():
        jobs = workflow(name)["jobs"]
        check = check_step(name)
        assert check.get("name") == CHECK_STEP, name
        assert check["id"] == "settings", name
        expected = {
            "HARNESS": "${{ inputs.harness }}",
            "MODEL": "${{ inputs.model }}",
            "EFFORT": "${{ inputs.effort }}",
            # Whether each secret was passed, never its value.
            "HAS_OAUTH_TOKEN": "${{ secrets.claude_code_oauth_token != '' }}",
            "HAS_API_KEY": "${{ secrets.anthropic_api_key != '' }}",
        }
        if name == "agent-review-reusable.yml":
            expected["IS_FORK"] = "${{ inputs.is_fork }}"
        assert check["env"] == expected, name
        assert check["shell"] == "bash", name
        assert "${{" not in check["run"], name
        # The agent's job runs only after the check's job, or is the same job.
        if first_job != agent_job:
            assert first_job in str(jobs[agent_job].get("needs", "")), name
            assert jobs[first_job]["outputs"]["model"] == "${{ steps.settings.outputs.model }}", name


def resolved_model(name: str) -> str:
    first_job, agent_job = REUSABLE[name]
    if first_job == agent_job:
        return "${{ steps.settings.outputs.model }}"
    return f"${{{{ needs.{first_job}.outputs.model }}}}"


def test_agent_gets_the_resolved_model_and_effort_only_when_set() -> None:
    for name, (_, agent_job) in REUSABLE.items():
        args = agent_step(workflow(name)["jobs"][agent_job])["with"]["claude_args"].splitlines()
        assert f"--model {resolved_model(name)}" in args, name
        assert EFFORT_FLAG in args, name
        assert sum("inputs.effort" in a for a in args) == 1, name


def test_agent_step_takes_either_claude_code_credential() -> None:
    # The API key only when no subscription token was passed, so a repository
    # that holds both secrets keeps the token it has been running on.
    for name, (_, agent_job) in REUSABLE.items():
        params = agent_step(workflow(name)["jobs"][agent_job])["with"]
        assert params["claude_code_oauth_token"] == "${{ secrets.claude_code_oauth_token }}", name
        assert params["anthropic_api_key"] == (
            "${{ secrets.claude_code_oauth_token == '' && secrets.anthropic_api_key || '' }}"
        ), name


def test_each_model_secret_value_reaches_the_agent_step_alone() -> None:
    for name, (_, agent_job) in REUSABLE.items():
        for job_name, job in workflow(name)["jobs"].items():
            for step in job["steps"]:
                if step.get("name") == CHECK_STEP:
                    continue
                if job_name == agent_job and "claude-code-action" in str(step.get("uses", "")):
                    continue
                for secret in PROVIDER_SECRETS:
                    assert f"secrets.{secret}" not in yaml.safe_dump(step), (name, job_name, step.get("name"))
        text = (WORKFLOWS / name).read_text(encoding="utf-8")
        for unused in ("openai_api_key", "gemini_api_key", "cursor_api_key"):
            assert f"secrets.{unused}" not in text, (name, unused)


def bash() -> str:
    # The bash on PATH. Not a bare "bash": on Windows, subprocess finds
    # System32's (WSL) before Git bash.
    path = shutil.which("bash")
    assert path, "bash is required to run step scripts"
    return path


def run_bash(script: str, **kwargs) -> subprocess.CompletedProcess:
    # From a file, not `bash -c`: Git-for-Windows bash cuts a `-c` argument
    # near 8,190 characters.
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "step.sh"
        path.write_text(script, encoding="utf-8", newline="\n")
        return subprocess.run([bash(), path.as_posix()], **kwargs)


def run_check(
    name: str,
    model: str = DEFAULT_MODEL,
    effort: str = "",
    harness: str = "claude-code",
    oauth: bool = True,
    api_key: bool = False,
    fork: bool = False,
) -> tuple[subprocess.CompletedProcess, str]:
    """The check step's result, and what it wrote to GITHUB_OUTPUT."""
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "github_output"
        output.write_text("", encoding="utf-8")
        env = {
            **os.environ,
            "HARNESS": harness,
            "MODEL": model,
            "EFFORT": effort,
            # As GitHub renders `secrets.x != ''`.
            "HAS_OAUTH_TOKEN": str(oauth).lower(),
            "HAS_API_KEY": str(api_key).lower(),
            "IS_FORK": str(fork).lower(),
            "GITHUB_OUTPUT": output.as_posix(),
        }
        result = run_bash(check_step(name)["run"], env=env, capture_output=True, text=True, check=False)
        return result, output.read_text(encoding="utf-8")


def test_check_accepts_plain_values() -> None:
    for name in REUSABLE:
        for model in ("claude-opus-5-5", "claude-opus-5-5[1m]", "us.anthropic.claude-sonnet-5-5-v1:0"):
            for effort in ("", "low", "medium", "high", "xhigh", "max"):
                r, output = run_check(name, model, effort)
                assert r.returncode == 0, (name, model, effort, r.stdout, r.stderr)
                assert output == f"model={model}\n", (name, output)


def test_check_fills_an_empty_model_with_the_harness_default() -> None:
    for name in REUSABLE:
        r, output = run_check(name, model="")
        assert r.returncode == 0, (name, r.stdout, r.stderr)
        assert output == f"model={DEFAULT_MODEL}\n", (name, output)


def test_check_reads_an_empty_harness_as_claude_code() -> None:
    for name in REUSABLE:
        r, _ = run_check(name, harness="")
        assert r.returncode == 0, (name, r.stdout, r.stderr)


def test_check_refuses_a_harness_not_yet_wired_for_the_stage() -> None:
    for name, stage in STAGE_NAMES.items():
        for harness in UNWIRED:
            r, output = run_check(name, harness=harness)
            assert r.returncode == 1, (name, harness)
            assert "::error title=Harness not wired::" in r.stdout, (name, harness, r.stdout)
            assert f"The {harness} harness is not yet wired for the {stage} Stage" in r.stdout, r.stdout
            assert output == "", (name, harness)


def test_check_refuses_an_unknown_harness_and_lists_the_accepted_names() -> None:
    for name in REUSABLE:
        for harness in ("claude", "Codex", "custom:", "custom:a b", "custom:../x", "foo\n::foo", "codex --foo"):
            r, output = run_check(name, harness=harness)
            assert r.returncode == 1, (name, harness)
            assert "::error title=Unknown harness::" in r.stdout, (name, harness, r.stdout)
            assert "claude-code, codex, gemini, opencode, cursor, custom:<name>" in r.stdout, r.stdout
            # The value is never echoed into the log.
            assert "foo" not in r.stdout and "../x" not in r.stdout
            assert output == ""


def test_check_takes_either_claude_code_credential_and_names_both_when_neither_is_passed() -> None:
    for name in REUSABLE:
        for oauth, api_key in ((True, False), (False, True), (True, True)):
            r, _ = run_check(name, oauth=oauth, api_key=api_key)
            assert r.returncode == 0, (name, oauth, api_key, r.stdout)
        r, output = run_check(name, oauth=False, api_key=False)
        assert r.returncode == 1, name
        assert "::error title=No model credential::" in r.stdout, (name, r.stdout)
        assert "claude_code_oauth_token" in r.stdout and "anthropic_api_key" in r.stdout
        assert output == ""


def test_review_of_a_fork_pull_request_needs_no_credential() -> None:
    # GitHub withholds secrets from a fork's run, and the gate then does nothing.
    name = "agent-review-reusable.yml"
    r, _ = run_check(name, oauth=False, api_key=False, fork=True)
    assert r.returncode == 0, r.stdout


def test_check_refuses_anything_that_could_add_flags() -> None:
    for name in REUSABLE:
        for model in ("x --foo", "claude-opus-5-5\n--foo", "-claude", "claude'x", 'a"b', "a$(b)"):
            r, output = run_check(name, model)
            assert r.returncode != 0, (name, model)
            assert "model input" in r.stdout, (name, model, r.stdout)
            # The value is never echoed into the log, where it could be a workflow command.
            assert "foo" not in r.stdout
            assert output == ""
        for effort in ("high\n--foo", "high --foo", "HIGH", "ultra", " low"):
            r, _ = run_check(name, effort=effort)
            assert r.returncode != 0, (name, effort)
            assert "effort input" in r.stdout, (name, effort, r.stdout)
            assert "foo" not in r.stdout


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("stage-settings-contract tests passed")
