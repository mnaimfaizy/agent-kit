"""Contract for the review workflow's Spec source (issue #56).

Two seams: the workflow's `workflow_call` contract and step wiring, parsed as
YAML, and the Build review brief step's own script, run in a temporary git
repository with a fake `gh` that serves a fixed PR body and issue comments.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
REVIEW_WORKFLOW = ROOT / ".github" / "workflows" / "agent-review-reusable.yml"
BRIEF_STEP = "Build review brief"


def workflow() -> dict:
    data = yaml.safe_load(REVIEW_WORKFLOW.read_text(encoding="utf-8"))
    # PyYAML reads the bare `on:` key as the boolean True.
    data["on"] = data.pop(True)
    return data


def review_inputs() -> dict:
    return workflow()["on"]["workflow_call"]["inputs"]


def step(name: str) -> dict:
    return next(s for s in workflow()["jobs"]["review"]["steps"] if s.get("name") == name)


def test_caller_can_list_trusted_spec_authors_defaulting_to_none() -> None:
    trusted = review_inputs()["trusted_spec_authors"]
    assert trusted["type"] == "string"
    assert trusted["required"] is False
    assert trusted["default"] == "[]"


def test_brief_step_reads_trusted_spec_authors_only_through_env() -> None:
    assert step(BRIEF_STEP)["env"]["TRUSTED_SPEC_AUTHORS"] == "${{ inputs.trusted_spec_authors }}"
    for job_name, job in workflow()["jobs"].items():
        for s in job.get("steps", []):
            assert "inputs.trusted_spec_authors" not in s.get("run", ""), f"{job_name} / {s.get('name')}"


# Behavior seam: run the Build review brief step's real script.

BRIEF_MARKER = "<!-- agent-kit-brief -->"
PLAN_MARKER = "<!-- agent-kit-plan -->"
SECRET = "SPEC-SECRET-91c2"


def bash() -> str:
    path = shutil.which("bash")
    assert path, "bash is required to run step scripts"
    return path


def comment(login: str, body: str) -> dict:
    return {"user": {"login": login}, "body": body}


def run_brief(
    tmp_path: Path,
    comments: list[dict],
    trusted: str = "[]",
    pr_body: str = "Closes #7",
    issue_input: str = "",
) -> tuple[subprocess.CompletedProcess, str]:
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args: str) -> str:
        return subprocess.run(
            ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
            cwd=repo,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

    git("init", "-q")
    (repo / "a.txt").write_text("one\n", encoding="utf-8")
    git("add", ".")
    git("commit", "-q", "-m", "base")
    base = git("rev-parse", "HEAD")
    (repo / "a.txt").write_text("two\n", encoding="utf-8")
    git("commit", "-q", "-am", "head")
    head = git("rev-parse", "HEAD")
    skill = repo / "SKILL.md"
    skill.write_text("# skill\n", encoding="utf-8")

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    comments_file = tmp_path / "comments.json"
    comments_file.write_text(json.dumps(comments), encoding="utf-8")
    gh = bin_dir / "gh"
    gh.write_text(
        "#!/usr/bin/env bash\n"
        'if [ "$1" = "pr" ]; then printf "%s" "$FAKE_PR_BODY"; exit 0; fi\n'
        f'if [ "$1" = "api" ]; then cat "{comments_file.as_posix()}"; exit 0; fi\n'
        "exit 1\n",
        encoding="utf-8",
    )
    gh.chmod(0o755)

    env = {
        **os.environ,
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "GITHUB_WORKSPACE": str(repo),
        "GITHUB_REPOSITORY": "owner/repo",
        "GH_TOKEN": "unused",
        "PR": "12",
        "BASE_SHA": base,
        "HEAD_SHA": head,
        "FAKE_PR_BODY": pr_body,
        "ISSUE_INPUT": issue_input,
        "TRUSTED_AUTHOR": "github-actions[bot]",
        "MARKER": PLAN_MARKER,
        "TRUSTED_SPEC_AUTHORS": trusted,
        "SKILL_PATH": str(skill),
    }
    result = subprocess.run(
        [bash(), "-c", step(BRIEF_STEP)["run"]], env=env, cwd=repo, capture_output=True, text=True, check=False
    )
    brief_file = repo / "review-brief.md"
    brief = brief_file.read_text(encoding="utf-8") if brief_file.exists() else ""
    return result, brief


def spec_in(brief: str) -> str:
    """The text inside the <untrusted_spec> fence, or "" when there is none."""
    if "<untrusted_spec>" not in brief:
        return ""
    return brief.split("<untrusted_spec>", 1)[1].split("</untrusted_spec>", 1)[0]


def test_a_trusted_maintainer_brief_becomes_the_spec(tmp_path: Path) -> None:
    result, brief = run_brief(
        tmp_path,
        [comment("maintainer", f"{BRIEF_MARKER}\n## Agent Brief\n{SECRET}")],
        trusted='["maintainer"]',
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert SECRET in spec_in(brief)
    assert "maintainer brief from issue #7, by maintainer" in brief
    assert SECRET not in result.stdout + result.stderr


def test_with_no_trusted_authors_a_marked_brief_is_ignored(tmp_path: Path) -> None:
    result, brief = run_brief(tmp_path, [comment("maintainer", f"{BRIEF_MARKER}\n{SECRET}")])
    assert result.returncode == 0, result.stdout + result.stderr
    assert spec_in(brief) == ""
    assert "Spec source: none" in result.stdout


def test_a_marked_brief_from_an_unlisted_login_is_ignored(tmp_path: Path) -> None:
    result, brief = run_brief(tmp_path, [comment("drive-by", f"{BRIEF_MARKER}\n{SECRET}")], trusted='["maintainer"]')
    assert result.returncode == 0, result.stdout + result.stderr
    assert spec_in(brief) == ""
    assert "Spec source: none" in result.stdout


def test_a_listed_login_needs_the_marker_at_the_start(tmp_path: Path) -> None:
    for i, body in enumerate((f"## Agent Brief\n{SECRET}", f"> *AI note*\n{BRIEF_MARKER}\n{SECRET}")):
        case = tmp_path / str(i)
        case.mkdir()
        result, brief = run_brief(case, [comment("maintainer", body)], trusted='["maintainer"]')
        assert result.returncode == 0, result.stdout + result.stderr
        assert spec_in(brief) == "", body
        assert "Spec source: none" in result.stdout


def test_a_verified_plan_wins_over_a_trusted_brief(tmp_path: Path) -> None:
    result, brief = run_brief(
        tmp_path,
        [
            comment("github-actions[bot]", f"{PLAN_MARKER}\nTHE-PLAN"),
            comment("maintainer", f"{BRIEF_MARKER}\n{SECRET}"),
        ],
        trusted='["maintainer"]',
    )
    assert "THE-PLAN" in spec_in(brief)
    assert SECRET not in brief
    assert "the verified plan from issue #7" in brief
    assert "Spec source: verified plan" in result.stdout


def test_the_latest_trusted_brief_is_used(tmp_path: Path) -> None:
    result, brief = run_brief(
        tmp_path,
        [
            comment("maintainer", f"{BRIEF_MARKER}\nOLD-BRIEF"),
            comment("co-maintainer", f"{BRIEF_MARKER}\nNEW-BRIEF"),
        ],
        trusted='["maintainer", "co-maintainer"]',
    )
    assert "NEW-BRIEF" in spec_in(brief)
    assert "OLD-BRIEF" not in brief
    assert "by co-maintainer" in brief


def test_trusted_spec_authors_must_be_a_json_array_of_logins(tmp_path: Path) -> None:
    # Several JSON values in one string must fail too, not only the last one.
    for i, value in enumerate(("maintainer", '{"login": "maintainer"}', "[1]", "[] []", '[] ["maintainer"]')):
        case = tmp_path / str(i)
        case.mkdir()
        result, _ = run_brief(case, [], trusted=value)
        assert result.returncode != 0, value
        assert "trusted_spec_authors must be a JSON array" in result.stdout


def test_by_default_a_verified_plan_is_still_the_spec(tmp_path: Path) -> None:
    result, brief = run_brief(tmp_path, [comment("github-actions[bot]", f"{PLAN_MARKER}\nTHE-PLAN")])
    assert result.returncode == 0, result.stdout + result.stderr
    assert "THE-PLAN" in spec_in(brief)
    assert "Spec source: verified plan" in result.stdout


def test_a_trusted_brief_is_found_through_the_issue_number_input(tmp_path: Path) -> None:
    result, brief = run_brief(
        tmp_path,
        [comment("maintainer", f"{BRIEF_MARKER}\n{SECRET}")],
        trusted='["maintainer"]',
        pr_body="No issue link here.",
        issue_input="7",
    )
    assert SECRET in spec_in(brief)
    assert "maintainer brief from issue #7, by maintainer" in brief


if __name__ == "__main__":
    import tempfile

    test_caller_can_list_trusted_spec_authors_defaulting_to_none()
    test_brief_step_reads_trusted_spec_authors_only_through_env()
    test_a_trusted_maintainer_brief_becomes_the_spec(Path(tempfile.mkdtemp()))
    test_with_no_trusted_authors_a_marked_brief_is_ignored(Path(tempfile.mkdtemp()))
    test_a_marked_brief_from_an_unlisted_login_is_ignored(Path(tempfile.mkdtemp()))
    test_a_listed_login_needs_the_marker_at_the_start(Path(tempfile.mkdtemp()))
    test_a_verified_plan_wins_over_a_trusted_brief(Path(tempfile.mkdtemp()))
    test_the_latest_trusted_brief_is_used(Path(tempfile.mkdtemp()))
    test_trusted_spec_authors_must_be_a_json_array_of_logins(Path(tempfile.mkdtemp()))
    test_by_default_a_verified_plan_is_still_the_spec(Path(tempfile.mkdtemp()))
    test_a_trusted_brief_is_found_through_the_issue_number_input(Path(tempfile.mkdtemp()))
    print("review-spec-source contract tests passed")
