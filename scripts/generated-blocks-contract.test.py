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
sys.path.insert(0, str(ROOT / "scripts"))

from gen_doc_blocks import DOC_PAGES, DOC_TREES, FIX_COMMAND  # noqa: E402 - needs the sys.path entry above

GENERATOR = ROOT / "scripts" / "gen_doc_blocks.py"
# Every Doc fact's source, copied with the docs so the copy can be regenerated.
# cli/src/tags.mjs, imported by init.mjs, reads cli/package.json when it loads.
FACT_SOURCES = [".github/agent-review-response", "cli/src", "cli/package.json"]
REVIEW_RESPONSE_SCRIPT = Path(".github/agent-review-response/review-response.mjs")
INIT_SCRIPT = Path("cli/src/init.mjs")
PROTECTED_BLOCK = "review-response-protected-paths"
LABELS_BLOCK = "trigger-labels"
# Each fact this test names, and the pages that hold its block.
BLOCK_PAGES = {
    PROTECTED_BLOCK: ["docs/review-response.md", "CONTRIBUTING.md"],
    LABELS_BLOCK: ["docs/getting-started.md", "CONTRIBUTING.md"],
}


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
    for path in [*DOC_PAGES, *DOC_TREES, *FACT_SOURCES]:
        if (ROOT / path).is_dir():
            shutil.copytree(ROOT / path, root / path)
        elif (ROOT / path).exists():
            (root / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / path, root / path)
    return root


def test_every_block_on_disk_matches_its_source() -> None:
    result = check(ROOT)
    assert result.returncode == 0, f"Generated blocks are stale:\n{result.stderr}"


def test_each_block_is_in_its_pages() -> None:
    for fact, pages in BLOCK_PAGES.items():
        for page in pages:
            text = (ROOT / page).read_text(encoding="utf-8")
            assert f"<!-- generated:{fact} -->" in text, f"{page} has no {fact} block"


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


def test_a_changed_init_label_without_regenerating_fails() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = copy_repo(Path(tmp))
        script = root / INIT_SCRIPT
        text = script.read_text(encoding="utf-8")
        anchor = '["agent:review", "5319E7", "Agent-kit: review this PR"]'
        assert anchor in text, "init's agent:review label changed shape; update this test"
        script.write_text(text.replace(anchor, '["agent:review", "C5DEF5", "Agent-kit: review this PR"]'), "utf-8")

        result = check(root)

    assert result.returncode == 1, f"--check passed after an init label's colour changed:\n{result.stdout}"
    for page in BLOCK_PAGES[LABELS_BLOCK]:
        assert f"{page}: generated:{LABELS_BLOCK} is stale" in result.stderr, result.stderr


def test_the_label_block_holds_inits_labels() -> None:
    text = (ROOT / "docs" / "getting-started.md").read_text(encoding="utf-8")
    block = text.split(f"<!-- generated:{LABELS_BLOCK} -->")[1].split(f"<!-- /generated:{LABELS_BLOCK} -->")[0]
    assert 'gh label create "agent:address-review" --color FBCA04' in block, block
    assert '--description "Agent-kit: answer the review on this PR"' in block, block


def test_a_broken_marker_fails_and_names_it() -> None:
    known = PROTECTED_BLOCK
    cases = {
        "an unknown fact": ("<!-- generated:no-such-fact -->\n\n<!-- /generated:no-such-fact -->", "no-such-fact"),
        "no closing marker": (f"<!-- generated:{known} -->", "no closing"),
        "a closing marker alone": (f"<!-- /generated:{known} -->", "no opening"),
        "a second opening inside a block": (
            f"<!-- generated:{known} -->\n<!-- generated:{known} -->\n<!-- /generated:{known} -->",
            "inside another block",
        ),
        "a mistyped marker": (f"<!--generated: {known}-->", "not a well-formed marker"),
    }
    with tempfile.TemporaryDirectory() as tmp:
        root = copy_repo(Path(tmp))
        page = root / "docs" / "getting-started.md"
        original = page.read_text(encoding="utf-8")
        for name, (markers, expected) in cases.items():
            page.write_text(f"{original}\n{markers}\n", encoding="utf-8")
            result = check(root)
            assert result.returncode == 1, f"{name}: --check passed:\n{result.stdout}"
            assert "docs/getting-started.md" in result.stderr and expected in result.stderr, f"{name}:\n{result.stderr}"
            assert FIX_COMMAND not in result.stderr, f"{name}: the fix command cannot fix a marker:\n{result.stderr}"


def test_an_empty_source_list_is_rendered_not_a_crash() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = copy_repo(Path(tmp))
        script = root / REVIEW_RESPONSE_SCRIPT
        text = script.read_text(encoding="utf-8")
        anchor = 'const PROTECTED_ROOT_DIRS = [".github/agent-runtime"];'
        assert anchor in text, "PROTECTED_ROOT_DIRS changed shape; update this test"
        script.write_text(text.replace(anchor, "const PROTECTED_ROOT_DIRS = [];", 1), encoding="utf-8")

        result = check(root)

    assert "Traceback" not in result.stderr, result.stderr
    assert result.returncode == 1, f"--check passed after PROTECTED_ROOT_DIRS was emptied:\n{result.stdout}"
    assert f"docs/review-response.md: generated:{PROTECTED_BLOCK} is stale" in result.stderr, result.stderr


def test_a_marker_problem_stops_the_write_before_any_page_changes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = copy_repo(Path(tmp))
        stale = root / "docs" / "review-response.md"
        stale.write_text(stale.read_text(encoding="utf-8").replace("`.gitmodules`", "`.gitmodules-old`", 1), "utf-8")
        before = stale.read_text(encoding="utf-8")
        broken = root / "docs" / "getting-started.md"
        broken.write_text(broken.read_text(encoding="utf-8") + "\n<!--generated: typo-->\n", encoding="utf-8")

        result = subprocess.run(
            [sys.executable, str(GENERATOR), "--root", str(root)], capture_output=True, text=True, check=False
        )
        after = stale.read_text(encoding="utf-8")

    assert result.returncode == 1, f"the write passed with a broken marker:\n{result.stdout}"
    assert "docs/getting-started.md" in result.stderr and "nothing was written" in result.stderr, result.stderr
    assert after == before, "a page was rewritten although another page had a marker problem"


if __name__ == "__main__":
    test_every_block_on_disk_matches_its_source()
    test_each_block_is_in_its_pages()
    test_check_names_a_stale_block_and_the_fix()
    test_a_new_protected_path_without_regenerating_fails()
    test_a_changed_init_label_without_regenerating_fails()
    test_the_label_block_holds_inits_labels()
    test_a_broken_marker_fails_and_names_it()
    test_an_empty_source_list_is_rendered_not_a_crash()
    test_a_marker_problem_stops_the_write_before_any_page_changes()
    print("generated-blocks-contract tests passed")
