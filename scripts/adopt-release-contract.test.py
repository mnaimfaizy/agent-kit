from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADOPT = ROOT / "docs" / "adopt.md"
RELEASES = ROOT / "docs" / "releases.md"
SECURITY_MODEL = ROOT / "docs" / "security-model.md"
CHANGELOG = ROOT / "CHANGELOG.md"
README = ROOT / "README.md"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_adopt_split_contract_and_same_tag_copy() -> None:
    data = read(ADOPT)
    assert "split contract" in data
    assert "uses: ...@<semver-tag>" in data
    assert "same exact tag" in data
    assert "Do not mix tags" in data


def test_dependabot_stable_only_documented() -> None:
    data = read(ADOPT)
    assert "Dependabot" in data
    assert "github-actions" in data
    assert "not auto-bumped" in data
    assert "*-alpha.*" in data
    assert "*-beta.*" in data
    assert "*-rc.*" in data


def test_release_policy_written() -> None:
    data = read(RELEASES)
    assert "whole-kit snapshots" in data
    assert "v1.0.0" in data
    assert "Major" in data and "Minor" in data and "Patch" in data
    assert "alpha -> beta -> rc -> stable" in data
    assert "Stable, beta, and rc releases require user-facing release notes." in data
    assert "`CHANGELOG.md` must include an entry" in data


def test_no_floating_tags_or_marketplace_or_binaries() -> None:
    data = read(RELEASES)
    assert "no floating major/minor tags" in data
    assert "no binaries" in data
    assert "no skills zip bundle" in data
    assert "no Marketplace listing" in data


def test_security_model_has_required_sections() -> None:
    data = read(SECURITY_MODEL)
    assert "Public-log rule" in data
    assert "Private delivery" in data
    assert "Agent pipeline gates" in data
    assert "Verified plan" in data
    assert "Runner seam" in data


def test_changelog_exists() -> None:
    data = read(CHANGELOG)
    assert "# Changelog" in data
    assert "## [Unreleased]" in data


def test_readme_points_to_adopt_and_releases_docs() -> None:
    data = read(README)
    assert "docs/adopt.md" in data
    assert "docs/releases.md" in data
    assert "CHANGELOG.md" in data


if __name__ == "__main__":
    test_adopt_split_contract_and_same_tag_copy()
    test_dependabot_stable_only_documented()
    test_release_policy_written()
    test_no_floating_tags_or_marketplace_or_binaries()
    test_security_model_has_required_sections()
    test_changelog_exists()
    test_readme_points_to_adopt_and_releases_docs()
    print("adopt-release contract tests passed")
