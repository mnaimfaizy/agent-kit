from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ARCHIVE_DIR = ROOT / ".github" / "workflows-archive" / "copilot"
RESTORE_DOC = ROOT / "docs" / "copilot-restore.md"
README = ROOT / "README.md"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_archive_files_are_inert_location() -> None:
    assert (ARCHIVE_DIR / "agent-pipeline.yml").exists()
    assert (ARCHIVE_DIR / "agent-pipeline-review.yml").exists()
    assert (ARCHIVE_DIR / "security-audit.yml").exists()
    assert (ARCHIVE_DIR / "copilot-setup-steps.yml").exists()
    assert (ARCHIVE_DIR / "README.md").exists()


def test_copilot_prompt_pack_is_forked() -> None:
    data = read(ARCHIVE_DIR / "agent-pipeline.yml")
    assert ".github/workflows-archive/copilot/prompts/planner-prompt.md" in data
    assert ".github/workflows-archive/copilot/prompts/implementer-instructions.md" in data
    assert ".github/agent-pipeline/planner-prompt.md" not in data
    assert ".github/agent-pipeline/implementer-instructions.md" not in data


def test_restore_doc_is_choose_one_with_distinct_killswitches() -> None:
    doc = read(RESTORE_DOC)
    assert "Archive Claude caller workflows first" in doc
    assert "mutually exclusive" in doc
    assert "CLAUDE_PIPELINE_ENABLED" in doc
    assert "AGENT_KIT_COPILOT_PIPELINE_ENABLED" in doc
    assert "AGENT_KIT_COPILOT_SECURITY_AUDIT_ENABLED" in doc


def test_contracts_still_apply_and_no_auto_fix_loop() -> None:
    doc = read(RESTORE_DOC)
    assert "trusted verified plan only" in doc
    assert "draft PR only" in doc
    assert "no auto-fix loop" in doc

    review_workflow = read(ARCHIVE_DIR / "agent-pipeline-review.yml")
    assert "@copilot" not in review_workflow
    assert "fix round" not in review_workflow.lower()


def test_later_paragraph_for_first_party_agentic_options() -> None:
    doc = read(RESTORE_DOC)
    assert "Agentic Workflows" in doc
    assert "Copilot automations" in doc
    assert "out of scope for this v1 kit path" in doc


def test_readme_links_restore_doc() -> None:
    data = read(README)
    assert "docs/copilot-restore.md" in data


if __name__ == "__main__":
    test_archive_files_are_inert_location()
    test_copilot_prompt_pack_is_forked()
    test_restore_doc_is_choose_one_with_distinct_killswitches()
    test_contracts_still_apply_and_no_auto_fix_loop()
    test_later_paragraph_for_first_party_agentic_options()
    test_readme_links_restore_doc()
    print("copilot archive contract tests passed")
