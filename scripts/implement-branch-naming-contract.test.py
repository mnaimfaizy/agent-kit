"""Contract for the Caller-owned implementer branch name (issue #52).

Two seams: the workflow's `workflow_call` contract and step wiring, parsed as
YAML, and the guardrail step's own script, run under bash.
"""

import os
import shutil
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
IMPLEMENT_WORKFLOW = ROOT / ".github" / "workflows" / "agent-implement-reusable.yml"
AGENT_STEP = "Run implementer (Claude Code)"
GUARD_STEP = "Check branch naming inputs"


def workflow() -> dict:
    data = yaml.safe_load(IMPLEMENT_WORKFLOW.read_text(encoding="utf-8"))
    # PyYAML reads the bare `on:` key as the boolean True.
    data["on"] = data.pop(True)
    return data


def implement_steps() -> list[dict]:
    return workflow()["jobs"]["implement"]["steps"]


def implement_inputs() -> dict:
    return workflow()["on"]["workflow_call"]["inputs"]


def step(name: str) -> dict:
    return next(s for s in implement_steps() if s.get("name") == name)


def test_caller_can_set_branch_prefix_defaulting_to_claude() -> None:
    inputs = implement_inputs()
    assert inputs["branch_prefix"]["type"] == "string"
    assert inputs["branch_prefix"]["required"] is False
    assert inputs["branch_prefix"]["default"] == "claude/"


def test_caller_can_set_branch_name_template_defaulting_to_action_naming() -> None:
    inputs = implement_inputs()
    assert inputs["branch_name_template"]["type"] == "string"
    assert inputs["branch_name_template"]["required"] is False
    assert inputs["branch_name_template"]["default"] == ""


def test_agent_step_takes_branch_naming_from_caller_inputs() -> None:
    action_inputs = step(AGENT_STEP)["with"]
    assert action_inputs["branch_prefix"] == "${{ inputs.branch_prefix }}"
    assert action_inputs["branch_name_template"] == "${{ inputs.branch_name_template }}"


def test_guardrail_runs_before_the_agent() -> None:
    names = [s.get("name") for s in implement_steps()]
    assert GUARD_STEP in names
    assert names.index(GUARD_STEP) < names.index(AGENT_STEP)


def test_guardrail_reads_inputs_only_through_env() -> None:
    guard = step(GUARD_STEP)
    assert guard["env"]["BRANCH_PREFIX"] == "${{ inputs.branch_prefix }}"
    assert guard["env"]["BRANCH_NAME_TEMPLATE"] == "${{ inputs.branch_name_template }}"
    assert guard["shell"] == "bash"
    assert "${{" not in guard["run"]


def run_guard(prefix: str, template: str = "") -> subprocess.CompletedProcess:
    bash = shutil.which("bash")
    assert bash, "bash is required to run the guardrail script"
    return subprocess.run(
        [bash, "-c", step(GUARD_STEP)["run"]],
        env={**os.environ, "BRANCH_PREFIX": prefix, "BRANCH_NAME_TEMPLATE": template},
        capture_output=True,
        text=True,
        check=False,
    )


def test_guardrail_accepts_the_defaults() -> None:
    assert run_guard("claude/").returncode == 0


def test_guardrail_accepts_an_empty_or_policy_style_prefix() -> None:
    for prefix in ("", "feat/", "agent-"):
        assert run_guard(prefix).returncode == 0, f"refused prefix {prefix!r}"


def test_guardrail_refuses_a_prefix_that_cannot_start_a_branch_name() -> None:
    for prefix in ("bad prefix/", "two..dots/", "-dash", "tilde~/"):
        result = run_guard(prefix)
        assert result.returncode != 0, f"accepted prefix {prefix!r}"
        assert "branch_prefix" in result.stdout + result.stderr


def test_guardrail_accepts_a_template_that_names_the_issue() -> None:
    for template in ("fix/{{entityNumber}}-{{description}}", "{{prefix}}{{entityType}}-{{entityNumber}}"):
        assert run_guard("claude/", template).returncode == 0, f"refused template {template!r}"


def test_guardrail_refuses_a_template_without_the_issue_number() -> None:
    # Without {{entityNumber}} every run can share one name, even the base branch.
    for template in ("main", "{{prefix}}{{description}}", "fix/{{entityType}}-{{timestamp}}"):
        result = run_guard("claude/", template)
        assert result.returncode != 0, f"accepted template {template!r}"
        assert "branch_name_template" in result.stdout + result.stderr


def test_no_run_script_interpolates_branch_naming() -> None:
    # {{label}} and {{description}} come from issue text, so the branch name is
    # attacker-influenced: it reaches scripts through env or outputs only.
    tainted = ("inputs.branch_prefix", "inputs.branch_name_template", "outputs.branch")
    for job_name, job in workflow()["jobs"].items():
        for s in job.get("steps", []):
            script = s.get("run", "")
            for expr in tainted:
                assert expr not in script, f"{job_name} / {s.get('name')}: run script names {expr}"


def test_guardrail_refuses_a_prefix_the_default_naming_would_truncate() -> None:
    # Default naming is <prefix>issue-<N>-<YYYYMMDD-HHMM>, cut to 50 characters.
    # Past 24 characters the cut eats the timestamp, then the issue number.
    assert run_guard("p" * 24 + "/").returncode != 0
    assert run_guard("p" * 23 + "/").returncode == 0
    result = run_guard("a-very-long-team-prefix/agents/")
    assert result.returncode != 0
    assert "branch_prefix" in result.stdout + result.stderr


def test_guardrail_refuses_a_long_prefix_even_with_a_template() -> None:
    # When the template's name already exists on the remote, the action falls
    # back to default naming, which truncates a long prefix's name too.
    result = run_guard("a-very-long-team-prefix/agents/", "{{prefix}}{{entityNumber}}")
    assert result.returncode != 0
    assert "branch_prefix" in result.stdout + result.stderr


def test_guardrail_judges_a_template_with_an_empty_description() -> None:
    # A title with no ASCII letters or digits makes {{description}} empty. The
    # action collapses the empty path segments that leaves, but not a leading "-".
    for template in ("{{description}}/{{entityNumber}}", "fix/{{entityNumber}}-{{description}}"):
        assert run_guard("claude/", template).returncode == 0, f"refused template {template!r}"
    result = run_guard("claude/", "{{description}}-{{entityNumber}}")
    assert result.returncode != 0
    assert "branch_name_template" in result.stdout + result.stderr


def test_guardrail_refuses_characters_the_action_rejects() -> None:
    # git accepts these, but the action's own name check does not.
    for prefix in ("bang!/", "quote'/", "café/", "dollar$/"):
        result = run_guard(prefix)
        assert result.returncode != 0, f"accepted prefix {prefix!r}"
        assert "branch_prefix" in result.stdout + result.stderr
    for template in ("fix /{{entityNumber}}", "fix/{{entityNumber}}!", "{{unknown}}-{{entityNumber}}"):
        result = run_guard("claude/", template)
        assert result.returncode != 0, f"accepted template {template!r}"
        assert "branch_name_template" in result.stdout + result.stderr


if __name__ == "__main__":
    test_caller_can_set_branch_prefix_defaulting_to_claude()
    test_caller_can_set_branch_name_template_defaulting_to_action_naming()
    test_agent_step_takes_branch_naming_from_caller_inputs()
    test_guardrail_runs_before_the_agent()
    test_guardrail_reads_inputs_only_through_env()
    test_guardrail_accepts_the_defaults()
    test_guardrail_accepts_an_empty_or_policy_style_prefix()
    test_guardrail_refuses_a_prefix_that_cannot_start_a_branch_name()
    test_guardrail_accepts_a_template_that_names_the_issue()
    test_guardrail_refuses_a_template_without_the_issue_number()
    test_no_run_script_interpolates_branch_naming()
    test_guardrail_refuses_a_prefix_the_default_naming_would_truncate()
    test_guardrail_refuses_a_long_prefix_even_with_a_template()
    test_guardrail_judges_a_template_with_an_empty_description()
    test_guardrail_refuses_characters_the_action_rejects()
    print("implement-branch-naming contract tests passed")
