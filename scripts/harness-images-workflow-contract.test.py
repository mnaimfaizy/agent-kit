"""Contract for the two Harness image workflows (ADR 0029).

harness-images.yml builds and pushes a Harness image in the pull request that
changes its pin, and fails until the adapter records the digest it pushed.
harness-images-refresh.yml opens the monthly pull request that moves the bases
and rebuilds every image. The script both run is held by
harness-images-script.test.mjs.
"""

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
IMAGES = ROOT / "docker" / "harness-images"
HARNESSES = sorted(p.stem for p in IMAGES.glob("*.Dockerfile"))


def load(name: str) -> tuple[str, dict]:
    text = (WORKFLOWS / name).read_text(encoding="utf-8")
    data = yaml.safe_load(text)
    # YAML 1.1 reads the `on` key as the boolean true.
    data["on"] = data.pop(True)
    return text, data


def script_of(job: dict) -> str:
    return "\n".join(step.get("run", "") for step in job["steps"])


def assert_pinned(job: dict) -> None:
    for step in job["steps"]:
        if "uses" in step:
            assert re.search(r"@[0-9a-f]{40}$", step["uses"]), step["uses"]
        # Nothing of an event or an input is pasted into a shell.
        assert "${{" not in step.get("run", ""), step.get("run")
    for image in re.findall(r"(?:tonistiigi/binfmt|moby/buildkit)\S*", script_of(job)):
        assert re.search(r"@sha256:[0-9a-f]{64}", image), image


def test_the_image_workflow_runs_on_the_pull_request_that_changes_a_pin():
    _, flow = load("harness-images.yml")
    assert set(flow["on"]) == {"pull_request", "workflow_dispatch"}
    assert set(flow["on"]["pull_request"]["paths"]) == {
        "docker/harness-images/**",
        "cli/src/harness/**",
        ".github/workflows/harness-images.yml",
    }
    assert flow["permissions"] == {"contents": "read"}


def test_the_image_workflow_publishes_then_checks_every_harness():
    _, flow = load("harness-images.yml")
    job = flow["jobs"]["image"]
    assert job["permissions"] == {"contents": "read", "packages": "write"}
    assert sorted(job["strategy"]["matrix"]["harness"]) == HARNESSES
    assert job["strategy"]["fail-fast"] is False
    assert job["timeout-minutes"] <= 60
    assert_pinned(job)
    run = script_of(job)
    assert "--install arm64" in run
    publish = run.index('image.mjs publish "$HARNESS"')
    assert run.index('image.mjs check "$HARNESS"') > publish
    checkout = job["steps"][0]
    assert checkout["with"]["persist-credentials"] is False


def test_a_fork_pull_request_builds_without_logging_in_or_pushing():
    _, flow = load("harness-images.yml")
    steps = flow["jobs"]["image"]["steps"]
    ours = "env.OWN_BRANCH == 'true'"
    login = next(s for s in steps if "docker login ghcr.io" in s.get("run", ""))
    publish = next(s for s in steps if "image.mjs publish" in s.get("run", ""))
    build = next(s for s in steps if 'image.mjs build "$HARNESS"' in s.get("run", ""))
    assert login["if"] == publish["if"] == ours
    assert build["if"] == "env.OWN_BRANCH != 'true'"
    assert "--password-stdin" in login["run"]
    own = flow["jobs"]["image"]["env"]["OWN_BRANCH"]
    assert "github.event.pull_request.head.repo.full_name == github.repository" in own


def test_the_refresh_runs_monthly_and_by_hand_on_main_only():
    _, flow = load("harness-images-refresh.yml")
    assert set(flow["on"]) == {"schedule", "workflow_dispatch"}
    [schedule] = flow["on"]["schedule"]
    minute, hour, day, month, weekday = schedule["cron"].split()
    assert minute.isdigit() and hour.isdigit() and day.isdigit(), schedule
    assert (month, weekday) == ("*", "*"), "once a month"
    assert flow["permissions"] == {}
    [job] = flow["jobs"].values()
    assert job["if"] == "github.ref == 'refs/heads/main'"


def test_the_refresh_rebuilds_every_image_then_opens_a_pull_request():
    _, flow = load("harness-images-refresh.yml")
    job = flow["jobs"]["refresh"]
    assert job["permissions"] == {
        "contents": "write",
        "packages": "write",
        "pull-requests": "write",
        "actions": "write",
    }
    assert_pinned(job)
    run = script_of(job)
    order = [
        "image.mjs refresh",
        'image.mjs publish "$harness"',
        'image.mjs record "$harness"',
        "git commit",
        "git push",
        "gh pr create",
        # A pull request opened with the job token starts no workflow.
        'gh workflow run ci.yml --ref "$branch"',
        'gh workflow run harness-images.yml --ref "$branch"',
    ]
    at = [run.index(step) for step in order]
    assert at == sorted(at), run
    for harness in HARNESSES:
        assert harness in job["env"]["HARNESSES"].split()
    # Never a push to the default branch.
    assert not re.search(r"git push\b.*\bmain\b", run)
    assert "--force" not in run


if __name__ == "__main__":
    test_the_image_workflow_runs_on_the_pull_request_that_changes_a_pin()
    test_the_image_workflow_publishes_then_checks_every_harness()
    test_a_fork_pull_request_builds_without_logging_in_or_pushing()
    test_the_refresh_runs_monthly_and_by_hand_on_main_only()
    test_the_refresh_rebuilds_every_image_then_opens_a_pull_request()
    print("harness images workflow contract tests passed")
