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
# cli/src holds the deep-scan facts' sources too: limits.mjs and recipe.mjs.
FACT_SOURCES = [".github/agent-review-response", "cli/src", "cli/package.json"]
REVIEW_RESPONSE_SCRIPT = Path(".github/agent-review-response/review-response.mjs")
INIT_SCRIPT = Path("cli/src/init.mjs")
LIMITS_SCRIPT = Path("cli/src/deep-scan/limits.mjs")
RECIPE_SCRIPT = Path("cli/src/deep-scan/recipe.mjs")
PROTECTED_BLOCK = "review-response-protected-paths"
LABELS_BLOCK = "trigger-labels"
KILL_SWITCH_BLOCK = "stage-kill-switches"
MODEL_BLOCK = "stage-model-and-effort"
LIMITS_BLOCK = "deep-scan-limits"
RECIPE_FIELDS_BLOCK = "deep-scan-recipe-fields"
PIPELINE_CALLER = Path("examples/plan-implement-review-caller.yml")
RESPONSE_CALLER = Path("examples/review-response-caller.yml")
# Each fact this test names, and the pages that hold its block.
BLOCK_PAGES = {
    PROTECTED_BLOCK: ["docs/review-response.md", "CONTRIBUTING.md"],
    LABELS_BLOCK: ["docs/getting-started.md", "CONTRIBUTING.md"],
    KILL_SWITCH_BLOCK: ["docs/getting-started.md"],
    MODEL_BLOCK: ["docs/getting-started.md"],
    LIMITS_BLOCK: ["docs/security-audit.md"],
    RECIPE_FIELDS_BLOCK: ["docs/security-audit.md"],
}


def block(fact: str, page: str = "docs/getting-started.md") -> str:
    text = (ROOT / page).read_text(encoding="utf-8")
    return text.split(f"<!-- generated:{fact} -->")[1].split(f"<!-- /generated:{fact} -->")[0]


def edit(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    assert old in text, f"{path.name} no longer has {old!r}; update this test"
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


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
        edit(
            root / INIT_SCRIPT,
            '["agent:review", "5319E7", "Agent-kit: review this PR"]',
            '["agent:review", "C5DEF5", "Agent-kit: review this PR"]',
        )

        result = check(root)

    assert result.returncode == 1, f"--check passed after an init label's colour changed:\n{result.stdout}"
    for page in BLOCK_PAGES[LABELS_BLOCK]:
        assert f"{page}: generated:{LABELS_BLOCK} is stale" in result.stderr, result.stderr


def test_the_label_block_holds_inits_labels() -> None:
    labels = block(LABELS_BLOCK)
    assert 'gh label create "agent:address-review" --color FBCA04' in labels, labels
    assert '--description "Agent-kit: answer the review on this PR"' in labels, labels


def test_the_stage_blocks_hold_each_stages_variables() -> None:
    switches = block(KILL_SWITCH_BLOCK)
    assert "`CLAUDE_AGENT_FLOW_ENABLED` is `true` and `CLAUDE_IMPLEMENT_ENABLED` is not `false`" in switches, switches
    assert "| Review response | `CLAUDE_REVIEW_RESPONSE_ENABLED` is `true`" in switches, switches
    models = block(MODEL_BLOCK)
    assert "| security audit | `CLAUDE_SECURITY_AUDIT_MODEL` | `CLAUDE_SECURITY_AUDIT_EFFORT` |" in " ".join(
        models.split()
    ), models
    assert "`CLAUDE_MODEL`" in models and "`CLAUDE_EFFORT`" in models and "`claude-opus-5-5`" in models, models


def test_a_renamed_caller_variable_without_regenerating_fails() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = copy_repo(Path(tmp))
        edit(root / PIPELINE_CALLER, "vars.CLAUDE_PLAN_EFFORT ||", "vars.CLAUDE_PLAN_THINKING ||")

        result = check(root)

    assert result.returncode == 1, f"--check passed after a Caller variable was renamed:\n{result.stdout}"
    assert f"docs/getting-started.md: generated:{MODEL_BLOCK} is stale" in result.stderr, result.stderr
    assert KILL_SWITCH_BLOCK not in result.stderr, f"only the model block should be named:\n{result.stderr}"


def test_a_changed_kill_switch_without_regenerating_fails() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = copy_repo(Path(tmp))
        edit(
            root / RESPONSE_CALLER,
            "kill_switch: ${{ vars.CLAUDE_REVIEW_RESPONSE_ENABLED != 'true' }}",
            "kill_switch: ${{ vars.CLAUDE_AGENT_FLOW_ENABLED != 'true'"
            " || vars.CLAUDE_REVIEW_RESPONSE_ENABLED != 'true' }}",
        )

        result = check(root)

    assert result.returncode == 1, f"--check passed after a Kill switch changed:\n{result.stdout}"
    assert f"docs/getting-started.md: generated:{KILL_SWITCH_BLOCK} is stale" in result.stderr, result.stderr


def test_a_caller_setting_the_generator_cannot_read_fails_and_names_it() -> None:
    cases = {
        "kill_switch": (
            "kill_switch: ${{ vars.CLAUDE_REVIEW_RESPONSE_ENABLED != 'true' }}",
            "kill_switch: ${{ !vars.CLAUDE_REVIEW_RESPONSE_ENABLED }}",
        ),
        "effort": (
            "effort: ${{ vars.CLAUDE_REVIEW_RESPONSE_EFFORT || vars.CLAUDE_EFFORT || '' }}",
            "effort: ${{ 'high' }}",
        ),
    }
    for key, (old, new) in cases.items():
        with tempfile.TemporaryDirectory() as tmp:
            root = copy_repo(Path(tmp))
            edit(root / RESPONSE_CALLER, old, new)

            result = check(root)

        assert result.returncode == 1, f"--check passed on a {key} it cannot read:\n{result.stdout}"
        assert "Traceback" not in result.stderr, result.stderr
        assert "examples/review-response-caller.yml" in result.stderr and key in result.stderr, result.stderr


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
    test_the_stage_blocks_hold_each_stages_variables()
    test_a_renamed_caller_variable_without_regenerating_fails()
    test_a_changed_kill_switch_without_regenerating_fails()
    test_a_caller_setting_the_generator_cannot_read_fails_and_names_it()
    test_a_broken_marker_fails_and_names_it()
    test_an_empty_source_list_is_rendered_not_a_crash()
    test_a_marker_problem_stops_the_write_before_any_page_changes()
    print("generated-blocks-contract tests passed")


def test_the_deep_scan_blocks_hold_the_code_defaults_and_fields() -> None:
    limits = " ".join(block(LIMITS_BLOCK, "docs/security-audit.md").split())
    assert "| Scan wall clock | 60 min | 15 min | `--scan-minutes <n>` |" in limits, limits
    assert "| Tokens | 5,000,000 for the run | 5,000,000 for the run | `--max-tokens <n>` |" in limits, limits
    fields = " ".join(block(RECIPE_FIELDS_BLOCK, "docs/security-audit.md").split())
    assert "| `entry_points` | yes, at least one | Each one of `url` (http or https), `port`" in fields, fields


def test_a_changed_deep_scan_limit_without_regenerating_fails() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = copy_repo(Path(tmp))
        edit(root / LIMITS_SCRIPT, "  scanMinutes: 60,\n", "  scanMinutes: 90,\n")

        result = check(root)

    assert result.returncode == 1, f"--check passed after a deep-scan limit changed:\n{result.stdout}"
    assert f"docs/security-audit.md: generated:{LIMITS_BLOCK} is stale" in result.stderr, result.stderr
    assert RECIPE_FIELDS_BLOCK not in result.stderr, f"only the limits block should be named:\n{result.stderr}"


def test_a_reordered_recipe_field_without_regenerating_fails() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = copy_repo(Path(tmp))
        edit(root / RECIPE_SCRIPT, '  "start",\n  "ready",\n', '  "ready",\n  "start",\n')

        result = check(root)

    assert result.returncode == 1, f"--check passed after the recipe fields were reordered:\n{result.stdout}"
    assert f"docs/security-audit.md: generated:{RECIPE_FIELDS_BLOCK} is stale" in result.stderr, result.stderr
    assert LIMITS_BLOCK not in result.stderr, f"only the field block should be named:\n{result.stderr}"


def test_a_new_recipe_field_with_no_description_fails_and_names_it() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = copy_repo(Path(tmp))
        edit(root / RECIPE_SCRIPT, '  "notes",\n];', '  "notes",\n  "services",\n];')

        result = check(root)

    assert result.returncode == 1, f"--check passed with an undescribed recipe field:\n{result.stdout}"
    assert "Traceback" not in result.stderr, result.stderr
    assert "services" in result.stderr and "scripts/gen_doc_blocks.py" in result.stderr, result.stderr
