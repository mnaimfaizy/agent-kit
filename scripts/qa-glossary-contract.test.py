"""Contract test: the QA terms read the same in GLOSSARY.md and in both QA skills.

A Portable skill must carry its own vocabulary (it links nothing outside its
folder), so the `DESIGN.md` of `qa-plan` and of `manual-qa` each repeat the
ten terms the root glossary defines under "Manual QA". Two copies drift unless something
compares them, so this test does: same terms, same definitions, word for word.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GLOSSARY = ROOT / "GLOSSARY.md"
DESIGNS = [ROOT / ".claude" / "skills" / skill / "DESIGN.md" for skill in ("qa-plan", "manual-qa")]
TERMS = [
    "QA Plan",
    "Residue",
    "QA Account",
    "Scenario account",
    "Session",
    "QA Stack",
    "Hazard pack",
    "Execution record",
    "QA Artifact",
    "QA Report",
]


def glossary_terms() -> dict[str, str]:
    section = GLOSSARY.read_text(encoding="utf-8").split("\n### Manual QA\n", 1)[1].split("\n### ", 1)[0]
    return dict(re.findall(r"^\*\*(.+?)\*\*:\n(.+)$", section, re.MULTILINE))


def design_terms(design: Path) -> dict[str, str]:
    section = design.read_text(encoding="utf-8").split("\n## Glossary\n", 1)[1].split("\n## ", 1)[0]
    return dict(re.findall(r"^\*\*(.+?)\*\*: (.+)$", section, re.MULTILINE))


def test_glossary_defines_the_ten_qa_terms() -> None:
    assert list(glossary_terms()) == TERMS


def test_each_qa_skill_design_repeats_them_word_for_word() -> None:
    for design in DESIGNS:
        assert design_terms(design) == glossary_terms(), design.parent.name


if __name__ == "__main__":
    test_glossary_defines_the_ten_qa_terms()
    test_each_qa_skill_design_repeats_them_word_for_word()
    print("qa glossary contract: ok")
