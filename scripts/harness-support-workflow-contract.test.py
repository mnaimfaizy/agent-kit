"""Contract for the harness preflight in the Stage reusable workflows (#458,
ADRs 0027, 0028 and 0030): the effort rule, the Support Level the run summary
shows, and the Proving run flag no workflow exposes.

Two seams: each workflow parsed as YAML, and its check step's own script, run
under bash. What the steps hold is compared with `cli/harnesses.json`.
"""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
CLAUDE = json.loads((ROOT / "cli" / "harnesses.json").read_text(encoding="utf-8"))["harnesses"]["claude-code"]
# Each workflow's Stage as harnesses.json names it, and its variable token.
STAGES = {
    "agent-plan-reusable.yml": ("plan", "PLAN"),
    "agent-implement-reusable.yml": ("implement", "IMPLEMENT"),
    "agent-review-reusable.yml": ("review", "REVIEW"),
    "agent-review-response-reusable.yml": ("review-response", "REVIEW_RESPONSE"),
    "security-audit-reusable.yml": ("security-audit", "SECURITY_AUDIT"),
    "deep-scan-reusable.yml": ("deep-scan", "DEEP_SCAN"),
}
# The workflows whose own check step writes the run summary. The Deep scan's
# summary is written by `agent-kit deep-scan` (cli-deep-scan-support.test.mjs).
SUMMARY_STAGES = [name for name, (stage, _) in STAGES.items() if stage != "deep-scan"]


def workflow(name: str) -> dict:
    data = yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))
    # PyYAML reads the bare `on:` key as the boolean True.
    data["on"] = data.pop(True)
    return data


def check_step(name: str) -> dict:
    found = [step for job in workflow(name)["jobs"].values() for step in job["steps"] if step.get("id") == "settings"]
    assert len(found) == 1, f"{name}: one check step"
    return found[0]


def run_check(
    name: str, effort: str = "", inherited: bool = False
) -> tuple[subprocess.CompletedProcess, dict[str, str], str]:
    """The check step's result, its outputs and the run summary it wrote."""
    bash = shutil.which("bash")
    assert bash, "bash is required to run step scripts"
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "step.sh"
        script.write_text(check_step(name)["run"], encoding="utf-8", newline="\n")
        output = Path(tmp) / "github_output"
        summary = Path(tmp) / "github_step_summary"
        output.write_text("", encoding="utf-8")
        summary.write_text("", encoding="utf-8")
        env = {
            **os.environ,
            "HARNESS": "claude-code",
            "MODEL": "",
            "EFFORT": effort,
            "EFFORT_INHERITED": str(inherited).lower(),
            "HAS_OAUTH_TOKEN": "false" if name == "deep-scan-reusable.yml" else "true",
            "HAS_API_KEY": "true",
            "IS_FORK": "false",
            "SETUP_MINUTES": "20",
            "SCAN_MINUTES": "60",
            "MAX_TURNS": "200",
            "MAX_TOKENS": "5000000",
            "GITHUB_OUTPUT": output.as_posix(),
            "GITHUB_STEP_SUMMARY": summary.as_posix(),
        }
        result = subprocess.run(
            [bash, script.as_posix()], env=env, capture_output=True, text=True, encoding="utf-8", check=False
        )
        outputs = dict(line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines())
        return result, outputs, summary.read_text(encoding="utf-8")


def test_the_check_reads_whether_the_effort_is_inherited() -> None:
    for name, (_, token) in STAGES.items():
        expected = f"${{{{ vars.AGENT_KIT_{token}_EFFORT == '' && inputs.effort == vars.AGENT_KIT_EFFORT }}}}"
        assert check_step(name)["env"]["EFFORT_INHERITED"] == expected, name


def test_every_effort_the_harness_accepts_passes_through() -> None:
    for name in STAGES:
        for effort in ("", *CLAUDE["effortValues"]):
            for inherited in (False, True):
                r, outputs, _ = run_check(name, effort, inherited)
                assert r.returncode == 0, (name, effort, r.stdout, r.stderr)
                assert outputs["effort"] == effort, (name, outputs)
                assert "Effort dropped" not in r.stdout, name


def test_the_stages_own_effort_that_is_not_accepted_fails_preflight() -> None:
    for name in STAGES:
        r, outputs, _ = run_check(name, "minimal-x", inherited=False)
        assert r.returncode == 1, name
        assert "::error title=Invalid effort input::" in r.stdout, (name, r.stdout)
        assert "minimal-x" not in r.stdout, "the value is never echoed"
        assert outputs == {}, name


def test_an_inherited_effort_that_is_not_accepted_is_dropped_with_a_log_line() -> None:
    for name in STAGES:
        for effort in ("minimal-x", "high --foo", "high\n::error::x"):
            r, outputs, _ = run_check(name, effort, inherited=True)
            assert r.returncode == 0, (name, effort, r.stdout, r.stderr)
            assert outputs["effort"] == "", (name, outputs)
            assert "::notice title=Effort dropped::AGENT_KIT_EFFORT" in r.stdout, (name, r.stdout)
            assert "foo" not in r.stdout and "::error::x" not in r.stdout, "the value is never echoed"


def test_the_checks_efforts_are_the_ones_harnesses_json_names() -> None:
    values = " | ".join(CLAUDE["effortValues"])
    for name in STAGES:
        assert f'"" | {values})' in check_step(name)["run"], name
        assert f'model="${{MODEL:-{CLAUDE["defaultModel"]}}}"' in check_step(name)["run"], name


def test_the_agent_gets_the_checked_effort_never_the_raw_input() -> None:
    for name in STAGES:
        text = (WORKFLOWS / name).read_text(encoding="utf-8")
        # The raw input reaches the check alone.
        assert text.count("${{ inputs.effort }}") == 1, name
        assert "inputs.effort != ''" not in text and "format('--effort {0}', inputs.effort)" not in text, name
    data = workflow("agent-review-response-reusable.yml")
    assert data["jobs"]["gate"]["outputs"]["effort"] == "${{ steps.settings.outputs.effort }}"
    deep = workflow("deep-scan-reusable.yml")["jobs"]["deep_scan"]["steps"]
    launcher = next(s for s in deep if s.get("id") == "scan")
    assert launcher["env"]["EFFORT"] == "${{ steps.settings.outputs.effort }}"


def test_stages_run_at_documented_with_a_warning_in_the_run_summary() -> None:
    # The static security audit too, until it moves to the Launcher, where a
    # security Stage below tried is refused.
    for name in SUMMARY_STAGES:
        stage, _ = STAGES[name]
        level = CLAUDE["supportLevels"][stage]["level"]
        r, _, summary = run_check(name)
        assert r.returncode == 0, (name, r.stdout, r.stderr)
        assert f"Harness: `claude-code` · Support Level: `{level}` · Proving run: no" in summary, (name, summary)
        warned = "> [!WARNING]" in summary and "::warning title=Support Level documented::" in r.stdout
        assert warned == (level == "documented"), (name, summary, r.stdout)
        # The step holds the level harnesses.json does: raising a cell means raising it here.
        assert f"level={level}\n" in check_step(name)["run"], name


def test_no_reusable_workflow_exposes_the_proving_run_flag() -> None:
    reusable = sorted(WORKFLOWS.glob("*-reusable.yml"))
    assert len(reusable) >= len(STAGES)
    for path in reusable:
        text = path.read_text(encoding="utf-8")
        assert "--proving-run" not in text, path.name
        inputs = (workflow(path.name)["on"].get("workflow_call") or {}).get("inputs") or {}
        assert not [i for i in inputs if "proving" in i.lower()], path.name


def test_publish_checks_harnesses_json_before_it_ships() -> None:
    steps = workflow("publish-cli.yml")["jobs"]["publish"]["steps"]
    names = [s.get("name") for s in steps]
    assert names.index("Check harnesses.json matches the adapters") < names.index("Publish")
    step = steps[names.index("Check harnesses.json matches the adapters")]
    assert step["run"] == "node scripts/gen_harnesses.mjs --check"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("harness-support-workflow-contract tests passed")
