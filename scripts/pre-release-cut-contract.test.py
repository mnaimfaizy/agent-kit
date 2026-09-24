import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from verify_release_snapshot import (  # noqa: E402 - needs the sys.path entry above
    notes_required_for_tag,
    parse_tag,
    verify_tree,
)

MANIFEST = ROOT / "scripts" / "release-snapshot-manifest.txt"
CUT_SCRIPT = ROOT / "scripts" / "cut-release.sh"
CUTTING_DOC = ROOT / "docs" / "cutting-releases.md"
RELEASES = ROOT / "docs" / "releases.md"
CHANGELOG = ROOT / "CHANGELOG.md"
README = ROOT / "README.md"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_whole_kit_manifest_covers_required_areas() -> None:
    data = read(MANIFEST)
    assert ".github/workflows/" in data
    assert ".claude/skills/" in data
    assert "docs/" in data
    assert "workflows-archive/copilot/" in data


def test_current_tree_passes_snapshot_verification() -> None:
    missing = verify_tree(ROOT, MANIFEST)
    assert missing == []


def test_first_alpha_tag_is_valid() -> None:
    parsed = parse_tag("v1.0.0-alpha.1")
    assert parsed is not None
    assert parsed["stage"] == "alpha"
    assert parsed["counter"] == 1


def test_alpha_notes_optional_beta_rc_required() -> None:
    assert notes_required_for_tag("v1.0.0-alpha.1") is False
    assert notes_required_for_tag("v1.0.0-beta.1") is True
    assert notes_required_for_tag("v1.0.0-rc.1") is True
    assert notes_required_for_tag("v1.0.0") is True


def test_cutting_doc_has_no_release_branch_or_binaries() -> None:
    data = read(CUTTING_DOC)
    assert "default branch" in data
    assert "no release branch" in data.lower() or "No release branch" in data
    assert "no attached binaries" in data.lower() or "No attached binaries" in data
    assert "v1.0.0-alpha.1" in data
    assert "dry run" in data.lower() or "dry-run" in data.lower() or "Dry run" in data


def test_cut_script_exists_and_is_dry_run_by_default() -> None:
    data = read(CUT_SCRIPT)
    assert "--apply" in data
    assert "--publish" in data
    assert "verify_release_snapshot.py" in data
    assert "gh release create" in data


def test_changelog_has_unreleased_and_prerelease_shape() -> None:
    data = read(CHANGELOG)
    assert "## [Unreleased]" in data
    assert "1.0.0-alpha.1" in data or "v1.0.0-alpha.1" in data


def test_releases_doc_links_cutting_procedure() -> None:
    data = read(RELEASES)
    assert "cutting-releases.md" in data


def test_readme_links_cutting_releases_doc() -> None:
    data = read(README)
    assert "docs/cutting-releases.md" in data


if __name__ == "__main__":
    test_whole_kit_manifest_covers_required_areas()
    test_current_tree_passes_snapshot_verification()
    test_first_alpha_tag_is_valid()
    test_alpha_notes_optional_beta_rc_required()
    test_cutting_doc_has_no_release_branch_or_binaries()
    test_cut_script_exists_and_is_dry_run_by_default()
    test_changelog_has_unreleased_and_prerelease_shape()
    test_releases_doc_links_cutting_procedure()
    test_readme_links_cutting_releases_doc()
    print("pre-release cut contract tests passed")
