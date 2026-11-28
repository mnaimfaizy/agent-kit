"""Contract for harness-live.yml, the live tier of the adapter tests (ADR 0031).

It runs on pull requests (forks included, since it needs no secret), weekly on
main and by hand; its `Harness live` job reports on every pull request, so a
ruleset can require it; and a failed weekly run reaches an issue. The scripts it
runs are held by harness-live-workflow.test.mjs.
"""

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
TEXT = (WORKFLOWS / "harness-live.yml").read_text(encoding="utf-8")


def load() -> dict:
    data = yaml.safe_load(TEXT)
    # YAML 1.1 reads the `on` key as the boolean true.
    data["on"] = data.pop(True)
    return data


FLOW = load()
JOBS = FLOW["jobs"]


def script_of(job: dict) -> str:
    return "\n".join(step.get("run", "") for step in job["steps"])


def test_it_runs_on_every_pull_request_weekly_and_by_hand():
    assert set(FLOW["on"]) == {"pull_request", "schedule", "workflow_dispatch"}
    # No path or branch filter: a required check must report on every pull request.
    assert not FLOW["on"]["pull_request"]
    [schedule] = FLOW["on"]["schedule"]
    minute, hour, day, month, weekday = schedule["cron"].split()
    assert minute.isdigit() and hour.isdigit() and weekday.isdigit(), schedule
    assert (day, month) == ("*", "*"), "once a week"


def test_it_needs_no_secret_and_holds_no_write_token_on_a_pull_request():
    assert "secrets." not in TEXT
    assert FLOW["permissions"] == {"contents": "read"}
    writers = {name for name, job in JOBS.items() if "write" in (job.get("permissions") or {}).values()}
    assert writers == {"report"}
    assert JOBS["report"]["permissions"] == {"contents": "read", "issues": "write"}
    assert "github.event_name == 'schedule'" in JOBS["report"]["if"]
    # The suite runs a pull request's code: no token reaches any of its steps.
    assert "github.token" not in str(JOBS["suite"])


def test_every_action_is_pinned_checkouts_keep_no_token_and_nothing_is_pasted_into_a_shell():
    for job in JOBS.values():
        assert job["timeout-minutes"] <= 60
        for step in job["steps"]:
            if "uses" in step:
                assert re.search(r"@[0-9a-f]{40}$", step["uses"]), step["uses"]
            if step.get("uses", "").startswith("actions/checkout@"):
                assert step["with"]["persist-credentials"] is False
            assert "${{" not in step.get("run", ""), step.get("run")


def test_the_suite_runs_when_the_changes_job_says_so():
    assert JOBS["changes"]["outputs"] == {"run": "${{ steps.changes.outputs.run }}"}
    assert JOBS["changes"]["steps"][0]["with"]["fetch-depth"] == 2
    assert "node .github/harness-live/changes.mjs" in script_of(JOBS["changes"])
    suite = JOBS["suite"]
    assert suite["needs"] == "changes"
    assert suite["if"] == "needs.changes.outputs.run == 'true'"
    run = script_of(suite)
    assert run.index("runsc install") < run.index("node cli/src/harness-live/run.mjs")
    assert "sha512sum --check --strict" in run
    assert set(suite["outputs"]) == {"guard_failed", "failed"}


def test_it_installs_the_gvisor_release_the_deep_scan_workflow_installs():
    deep = (WORKFLOWS / "deep-scan-reusable.yml").read_text(encoding="utf-8")
    for name in ("GVISOR_RELEASE", "GVISOR_SHA512"):
        pins = [re.findall(rf'{name}="([^"]+)"', text) for text in (TEXT, deep)]
        assert pins[0] and pins[0] == pins[1], name


def test_the_check_to_require_always_reports_and_passes_only_on_a_pass_or_a_skip():
    gate = JOBS["gate"]
    assert gate["name"] == "Harness live"
    assert [job["name"] for job in JOBS.values()].count("Harness live") == 1
    assert gate["if"] == "always()"
    assert gate["needs"] == ["changes", "suite"]
    [step] = gate["steps"]
    run = step["run"]
    assert '"$CHANGES" = success ] && [ "$NEEDED" = false ] && [ "$SUITE" = skipped' in run
    assert '"$CHANGES" = success ] && [ "$NEEDED" = true ] && [ "$SUITE" = success' in run
    assert "exit 1" in run


def test_a_weekly_failure_of_any_kind_is_reported():
    report = JOBS["report"]
    assert report["needs"] == ["changes", "suite"]
    for part in ("always()", "needs.changes.result != 'success'", "needs.suite.result != 'success'"):
        assert part in report["if"]
    step = report["steps"][-1]
    assert step["run"] == "node .github/harness-live/report-failure.mjs"
    assert step["env"]["GUARD_FAILED"] == "${{ needs.suite.outputs.guard_failed }}"
    assert step["env"]["FAILED"] == "${{ needs.suite.outputs.failed }}"
