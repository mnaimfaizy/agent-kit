"""Contract test: every Generated block on disk equals what its Doc fact's source says.

A Generated block is the text between `<!-- generated:<fact> -->` and
`<!-- /generated:<fact> -->` in a doc page, written by
`scripts/gen_doc_blocks.py` (ADR 0010). These cases run the generator's own
`--check` command, against the real repository and against a throwaway copy
with a block or a source made stale.
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "gen_doc_blocks.py"
FIX_COMMAND = "uv run python scripts/gen_doc_blocks.py"
REVIEW_RESPONSE_SCRIPT = Path(".github/agent-review-response/review-response.mjs")
PROTECTED_BLOCK = "review-response-protected-paths"


def check(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(GENERATOR), "--check", "--root", str(root)],
        capture_output=True,
        text=True,
        check=False,
    )


def copy_repo(dest: Path) -> Path:
    """The files the generator reads: the gated docs and each fact's source."""
    root = dest / "repo"
    for path in ["README.md", "CONTRIBUTING.md", "GLOSSARY.md", "AGENTS.md", "cli/README.md"]:
        if (ROOT / path).exists():
            (root / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / path, root / path)
    for folder in ["docs", "examples", ".github/agent-review-response"]:
        shutil.copytree(ROOT / folder, root / folder)
    return root


def test_every_block_on_disk_matches_its_source() -> None:
    result = check(ROOT)
    assert result.returncode == 0, f"Generated blocks are stale:\n{result.stderr}"


def test_protected_paths_block_is_in_both_pages() -> None:
    marker = f"<!-- generated:{PROTECTED_BLOCK} -->"
    for page in ["docs/review-response.md", "CONTRIBUTING.md"]:
        assert marker in (ROOT / page).read_text(encoding="utf-8"), f"{page} has no {PROTECTED_BLOCK} block"


def test_check_names_a_stale_block_and_the_fix() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = copy_repo(Path(tmp))
        page = root / "docs" / "review-response.md"
        text = page.read_text(encoding="utf-8")
        assert "`.gitmodules`" in text, "the review-response block should list .gitmodules"
        page.write_text(text.replace("`.gitmodules`", "`.gitmodules-old`", 1), encoding="utf-8")

        result = check(root)

    assert result.returncode == 1, f"--check passed on a stale block:\n{result.stdout}{result.stderr}"
    assert f"docs/review-response.md: generated:{PROTECTED_BLOCK}" in result.stderr, result.stderr
    assert "CONTRIBUTING.md" not in result.stderr, f"only the stale block should be named:\n{result.stderr}"
    assert FIX_COMMAND in result.stderr, result.stderr


def test_a_new_protected_path_without_regenerating_fails() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = copy_repo(Path(tmp))
        script = root / REVIEW_RESPONSE_SCRIPT
        text = script.read_text(encoding="utf-8")
        anchor = 'const PROTECTED_FILES = new Set([\n  "CLAUDE.md",\n'
        assert anchor in text, "PROTECTED_FILES no longer opens with CLAUDE.md; update this test"
        script.write_text(text.replace(anchor, anchor + '  "GEMINI.md",\n', 1), encoding="utf-8")

        result = check(root)

    assert result.returncode == 1, f"--check passed after a protected path was added:\n{result.stdout}"
    for page in ["docs/review-response.md", "CONTRIBUTING.md"]:
        assert f"{page}: generated:{PROTECTED_BLOCK}" in result.stderr, result.stderr


def test_an_unknown_or_unclosed_block_fails() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = copy_repo(Path(tmp))
        page = root / "docs" / "getting-started.md"
        original = page.read_text(encoding="utf-8")
        opening, closing = "<!-- generated:no-such-fact -->", "<!-- /generated:no-such-fact -->"
        page.write_text(f"{original}\n{opening}\n\n{closing}\n", encoding="utf-8")
        unknown = check(root)
        page.write_text(f"{original}\n<!-- generated:{PROTECTED_BLOCK} -->\n", encoding="utf-8")
        unclosed = check(root)

    assert unknown.returncode == 1 and "no-such-fact" in unknown.stderr, unknown.stderr
    assert unclosed.returncode == 1 and "no closing" in unclosed.stderr, unclosed.stderr


if __name__ == "__main__":
    test_every_block_on_disk_matches_its_source()
    test_protected_paths_block_is_in_both_pages()
    test_check_names_a_stale_block_and_the_fix()
    test_a_new_protected_path_without_regenerating_fails()
    test_an_unknown_or_unclosed_block_fails()
    print("generated-blocks-contract tests passed")
