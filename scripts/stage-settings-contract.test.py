"""Contract for each Stage's model and effort inputs (issue #246, ADR 0009).

Two seams: each reusable workflow's `workflow_call` inputs and step wiring,
parsed as YAML, and the input check step's own script, run under bash.
"""

import os
import shutil
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
CHECK_STEP = "Check model and effort inputs"
# The job whose first step is the check, and the job that runs the agent.
REUSABLE = {
    "agent-plan-reusable.yml": ("plan", "plan"),
    "agent-implement-reusable.yml": ("implement", "implement"),
    "agent-review-reusable.yml": ("review", "review"),
    "agent-review-response-reusable.yml": ("gate", "respond"),
    "security-audit-reusable.yml": ("security_audit", "security_audit"),
}
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


def test_model_and_effort_inputs() -> None:
    for name in REUSABLE:
        inputs = workflow(name)["on"]["workflow_call"]["inputs"]
        assert inputs["model"]["default"] == "claude-opus-5-5", name
        assert inputs["effort"]["type"] == "string", name
        assert inputs["effort"]["required"] is False, name
        assert inputs["effort"]["default"] == "", name


def test_check_is_the_first_step_and_reads_inputs_only_through_env() -> None:
    for name, (first_job, agent_job) in REUSABLE.items():
        jobs = workflow(name)["jobs"]
        check = check_step(name)
        assert check.get("name") == CHECK_STEP, name
        assert check["env"] == {"MODEL": "${{ inputs.model }}", "EFFORT": "${{ inputs.effort }}"}, name
        assert check["shell"] == "bash", name
        assert "${{" not in check["run"], name
        # The agent's job runs only after the check's job, or is the same job.
        if first_job != agent_job:
            assert first_job in str(jobs[agent_job].get("needs", "")), name


def test_agent_passes_effort_only_when_set() -> None:
    for name, (_, agent_job) in REUSABLE.items():
        args = agent_step(workflow(name)["jobs"][agent_job])["with"]["claude_args"].splitlines()
        assert "--model ${{ inputs.model }}" in args, name
        assert EFFORT_FLAG in args, name
        assert sum("inputs.effort" in a for a in args) == 1, name


def run_check(name: str, model: str, effort: str) -> subprocess.CompletedProcess:
    bash = shutil.which("bash")
    assert bash, "bash is required to run the check script"
    return subprocess.run(
        [bash, "-c", check_step(name)["run"]],
        env={**os.environ, "MODEL": model, "EFFORT": effort},
        capture_output=True,
        text=True,
        check=False,
    )


def test_check_accepts_plain_values() -> None:
    for name in REUSABLE:
        for model in ("claude-opus-5-5", "claude-opus-5-5[1m]", "us.anthropic.claude-sonnet-5-5-v1:0"):
            for effort in ("", "low", "medium", "high", "xhigh", "max"):
                r = run_check(name, model, effort)
                assert r.returncode == 0, (name, model, effort, r.stdout, r.stderr)


def test_check_refuses_anything_that_could_add_flags() -> None:
    for name in REUSABLE:
        for model in ("x --foo", "claude-opus-5-5\n--foo", "", "-claude", "claude'x", 'a"b', "a$(b)"):
            r = run_check(name, model, "")
            assert r.returncode != 0, (name, model)
            assert "model input" in r.stdout, (name, model, r.stdout)
            # The value is never echoed into the log, where it could be a workflow command.
            assert "foo" not in r.stdout
        for effort in ("high\n--foo", "high --foo", "HIGH", "ultra", " low"):
            r = run_check(name, "claude-opus-5-5", effort)
            assert r.returncode != 0, (name, effort)
            assert "effort input" in r.stdout, (name, effort, r.stdout)
            assert "foo" not in r.stdout


if __name__ == "__main__":
    test_model_and_effort_inputs()
    test_check_is_the_first_step_and_reads_inputs_only_through_env()
    test_agent_passes_effort_only_when_set()
    test_check_accepts_plain_values()
    test_check_refuses_anything_that_could_add_flags()
    print("stage-settings-contract tests passed")
