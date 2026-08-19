from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "security-audit-reusable.yml"
PUBLISH = ROOT / ".github" / "security-audit" / "publish-draft-advisory.sh"
COMMENT = ROOT / ".github" / "security-audit" / "comment-pr-counts.sh"
SECURITY_AUDIT_DOC = ROOT / "docs" / "security-audit.md"
CALLER_EXAMPLE = ROOT / "examples" / "security-audit-caller.yml"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_reusable_job_surface() -> None:
    data = read(WORKFLOW)
    assert "workflow_call:" in data
    assert "Publish draft GHSA (required private delivery)" in data
    assert "./.github/security-audit/publish-draft-advisory.sh" in data
    assert "PR comment (counts only)" in data
    assert "steps.finding_count.outputs.count != '0'" in data
    assert "inputs.mode == 'pr'" in data


def test_public_log_rule_no_artifact_upload() -> None:
    data = read(WORKFLOW)
    assert "upload-artifact" not in data
    assert "cat \"$REPORT_PATH\"" not in data


def test_private_delivery_sink_present() -> None:
    publish = read(PUBLISH)
    assert "/security-advisories" in publish
    assert "vulnerabilities[]" in publish
    assert "Draft advisory created" in publish


def test_counts_only_comment() -> None:
    comment = read(COMMENT)
    assert "Medium+ finding(s)" in comment
    assert "private draft advisory" in comment


def test_private_org_docs_use_same_job() -> None:
    doc = read(SECURITY_AUDIT_DOC)
    assert "same job applies to public, private, and org repositories" in doc
    assert "enable Advisories first" in doc


def test_caller_contract_ownership_documented() -> None:
    doc = read(SECURITY_AUDIT_DOC)
    assert "The Caller owns:" in doc
    assert "Threat pack paths" in doc
    assert "allowlist policy" in doc
    assert "advisories token secret" in doc


def test_caller_example_invokes_reusable_job() -> None:
    example = read(CALLER_EXAMPLE)
    assert "uses: mnaimfaizy/agent-kit/.github/workflows/security-audit-reusable.yml@main" in example
    assert "threat_model_path:" in example
    assert "findings_ledger_path:" in example


if __name__ == "__main__":
    test_reusable_job_surface()
    test_public_log_rule_no_artifact_upload()
    test_private_delivery_sink_present()
    test_counts_only_comment()
    test_private_org_docs_use_same_job()
    test_caller_contract_ownership_documented()
    test_caller_example_invokes_reusable_job()
    print("security-audit contract seam tests passed")
