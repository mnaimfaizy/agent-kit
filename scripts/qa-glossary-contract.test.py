"""Contract test: the QA terms read the same in GLOSSARY.md and in the qa-plan skill.

A Portable skill must carry its own vocabulary (it links nothing outside its
folder), so `.claude/skills/qa-plan/DESIGN.md` repeats the eight terms the
root glossary defines under "Manual QA". Two copies drift unless something
compares them, so this test does: same terms, same definitions, word for word.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GLOSSARY = ROOT / "GLOSSARY.md"
DESIGN = ROOT / ".claude" / "skills" / "qa-plan" / "DESIGN.md"
TERMS = [
    "QA Plan",
    "Residue",
    "QA Account",
    "QA Stack",
    "Hazard pack",
    "Execution record",
    "QA Artifact",
    "QA Report",
]


def glossary_terms() -> dict[str, str]:
    section = GLOSSARY.read_text(encoding="utf-8").split("\n### Manual QA\n", 1)[1].split("\n### ", 1)[0]
    return dict(re.findall(r"^\*\*(.+?)\*\*:\n(.+)$", section, re.MULTILINE))


def design_terms() -> dict[str, str]:
    section = DESIGN.read_text(encoding="utf-8").split("\n## Glossary\n", 1)[1].split("\n## ", 1)[0]
    return dict(re.findall(r"^\*\*(.+?)\*\*: (.+)$", section, re.MULTILINE))


def test_glossary_defines_the_eight_qa_terms() -> None:
    assert list(glossary_terms()) == TERMS


def test_qa_plan_design_repeats_them_word_for_word() -> None:
    assert design_terms() == glossary_terms()


if __name__ == "__main__":
    test_glossary_defines_the_eight_qa_terms()
    test_qa_plan_design_repeats_them_word_for_word()
    print("qa glossary contract: ok")
