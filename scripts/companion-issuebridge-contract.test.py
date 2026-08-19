from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
ADOPT = ROOT / "docs" / "adopt.md"
ISSUEBRIDGE = ROOT / "docs" / "issuebridge.md"

COMPANION_URL = "https://github.com/mattpocock/skills"
COMPANION_NAME = "Matt Pocock's skills"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_readme_names_companion_with_copy_or_plugin_one_liner() -> None:
    data = read(README)
    assert COMPANION_NAME in data
    assert COMPANION_URL in data
    assert "copy from that repo or use its Claude plugin" in data
    assert "not on the Agent-kit Release line" in data
    assert "docs/issuebridge.md" in data


def test_adopt_companion_pointer_is_not_kit_runbook() -> None:
    data = read(ADOPT)
    assert COMPANION_NAME in data
    assert COMPANION_URL in data
    assert "copy from that repo or use its Claude plugin" in data
    assert "outside this kit's Release line" in data
    assert "no SemVer pin" in data


def test_issuebridge_is_target_state_and_checklist_only() -> None:
    data = read(ISSUEBRIDGE)
    assert "target state + stand-up checklist" in data
    assert "does not perform the extract" in data
    assert "Pin kit SemVer tags" in data
    assert "Keep in-tree Companion" in data or "Leave Companion skill copies" in data
    assert "Copilot" in data and "inert" in data
    assert COMPANION_URL in data


def test_issuebridge_has_no_extract_runbook_or_ordered_prs() -> None:
    data = read(ISSUEBRIDGE).lower()
    assert "extract runbook" not in data
    assert "ordered pr" not in data
    assert "pr #1" not in data
    assert "pull request" not in data


if __name__ == "__main__":
    test_readme_names_companion_with_copy_or_plugin_one_liner()
    test_adopt_companion_pointer_is_not_kit_runbook()
    test_issuebridge_is_target_state_and_checklist_only()
    test_issuebridge_has_no_extract_runbook_or_ordered_prs()
    print("companion-issuebridge contract tests passed")
