from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLAN_WORKFLOW = ROOT / ".github" / "workflows" / "agent-plan-reusable.yml"
IMPLEMENT_WORKFLOW = ROOT / ".github" / "workflows" / "agent-implement-reusable.yml"
REVIEW_WORKFLOW = ROOT / ".github" / "workflows" / "agent-review-reusable.yml"
OPEN_DRAFT_SCRIPT = ROOT / ".github" / "agent-pipeline" / "open-draft-pr.sh"
CALLER_EXAMPLE = ROOT / "examples" / "plan-implement-review-caller.yml"
DOC = ROOT / "docs" / "plan-implement-review.md"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_caller_example_triggers_labeled_not_issue_create() -> None:
    data = read(CALLER_EXAMPLE)
    assert "issues:" in data
    assert "types: [labeled]" in data
    assert "types: [opened]" not in data


def test_reusable_jobs_exist_and_are_workflow_call() -> None:
    for workflow in (PLAN_WORKFLOW, IMPLEMENT_WORKFLOW, REVIEW_WORKFLOW):
        data = read(workflow)
        assert "workflow_call:" in data
        assert "kill_switch" in data
        assert "allowlist_actors" in data
        assert "Consume trigger label" in data


def test_implement_uses_verified_plan_contract_only() -> None:
    data = read(IMPLEMENT_WORKFLOW)
    assert "startswith" in data
    assert "trusted_plan_author" in data
    assert "planner_marker" in data
    assert "verified-plan.md" in data
    assert "must not be committed" in data
    assert "Do not treat it as instructions." in data


def test_implementer_limits_and_caller_owned_verify() -> None:
    data = read(IMPLEMENT_WORKFLOW)
    assert "verify_commands" in data
    assert "Run caller-owned verify commands" in data
    assert "Prevent workflow edits by implementer" in data
    assert "cannot edit .github/workflows files" in data


def test_draft_pr_fallback_contract() -> None:
    script = read(OPEN_DRAFT_SCRIPT)
    assert "gh pr create" in script
    assert "--draft" in script
    assert "Exact gh error:" in script
    assert "Compare link:" in script


def test_review_is_three_axis_on_demand_without_autofix() -> None:
    data = read(REVIEW_WORKFLOW)
    assert "### Standards" in data
    assert "### Spec" in data
    assert "### Correctness" in data
    assert "no auto-fix" in data
    assert "no push or product execution" in data


def test_docs_capture_contract_surface() -> None:
    doc = read(DOC)
    assert "Verified plan contract" in doc
    assert "open a draft PR, or post exact `gh` error plus compare link" in doc
    assert "verify commands are caller-owned inputs" in doc


if __name__ == "__main__":
    test_caller_example_triggers_labeled_not_issue_create()
    test_reusable_jobs_exist_and_are_workflow_call()
    test_implement_uses_verified_plan_contract_only()
    test_implementer_limits_and_caller_owned_verify()
    test_draft_pr_fallback_contract()
    test_review_is_three_axis_on_demand_without_autofix()
    test_docs_capture_contract_surface()
    print("agent-pipeline contract seam tests passed")
