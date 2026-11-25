"""Contract test: the QA terms read the same in GLOSSARY.md and in both QA skills.

A Portable skill must carry its own vocabulary (it links nothing outside its
folder), so the `DESIGN.md` of `qa-plan` and of `manual-qa` each repeat the
terms the root glossary defines under "Manual QA". Two copies drift unless something
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
    "Review box",
    "QA Account",
    "Scenario account",
    "Fix scenario",
    "Session",
    "Cut",
    "Scene",
    "Title card",
    "Story",
    "Surface",
    "Driver",
    "QA Stack",
    "Hazard pack",
    "Execution record",
    "QA Artifact",
    "Storyboard",
    "QA Report",
    "Place",
]
# Under "Hosted targets": carried by `manual-qa` alone, which uses them.
HOSTED_TERMS = ["Host candidate", "Service"]
MANUAL_QA_DESIGN = next(d for d in DESIGNS if d.parent.name == "manual-qa")


def glossary_terms(heading: str = "Manual QA") -> dict[str, str]:
    section = GLOSSARY.read_text(encoding="utf-8").split(f"\n### {heading}\n", 1)[1].split("\n### ", 1)[0]
    return dict(re.findall(r"^\*\*(.+?)\*\*:\n(.+)$", section, re.MULTILINE))


def design_terms(design: Path) -> dict[str, str]:
    section = design.read_text(encoding="utf-8").split("\n## Glossary\n", 1)[1].split("\n## ", 1)[0]
    return dict(re.findall(r"^\*\*(.+?)\*\*: (.+)$", section, re.MULTILINE))


def test_glossary_defines_the_qa_terms() -> None:
    assert list(glossary_terms()) == TERMS


def test_each_qa_skill_design_repeats_them_word_for_word() -> None:
    for design in DESIGNS:
        carried = design_terms(design)
        assert {term: carried.get(term) for term in TERMS} == glossary_terms(), design.parent.name


def test_manual_qa_design_carries_the_hosted_target_terms() -> None:
    hosted = glossary_terms("Hosted targets")
    assert list(hosted) == HOSTED_TERMS
    carried = design_terms(MANUAL_QA_DESIGN)
    assert {term: carried.get(term) for term in HOSTED_TERMS} == hosted
    # The one skill that carries them says so where the glossary defines them.
    intro = GLOSSARY.read_text(encoding="utf-8").split("\n### Hosted targets\n", 1)[1].split("\n**", 1)[0]
    assert "`manual-qa`" in intro and "`DESIGN.md`" in intro


if __name__ == "__main__":
    test_glossary_defines_the_qa_terms()
    test_each_qa_skill_design_repeats_them_word_for_word()
    test_manual_qa_design_carries_the_hosted_target_terms()
    print("qa glossary contract: ok")
