import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from gen_workflow_reference import OUTPUT, normalize, render  # noqa: E402 - needs the sys.path entry above


def test_reference_doc_matches_workflows() -> None:
    assert OUTPUT.exists(), "docs/reference.md missing; run scripts/gen_workflow_reference.py"
    assert normalize(OUTPUT.read_text(encoding="utf-8")) == normalize(render()), (
        "docs/reference.md is stale; run: uv run python scripts/gen_workflow_reference.py"
    )


if __name__ == "__main__":
    test_reference_doc_matches_workflows()
    print("workflow-reference-contract tests passed")
