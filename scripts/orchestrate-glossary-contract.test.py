"""Contract test: the orchestration terms read the same in GLOSSARY.md and in the `orchestrate` skill.

A Portable skill must carry its own vocabulary (it links nothing outside its
folder), so `orchestrate`'s `DESIGN.md` repeats the terms the root glossary
defines under "Orchestration". Two copies drift unless something compares
them, so this test does: same terms, same definitions, word for word. It also
keeps "Live Session" whole, since a Session alone is a QA term.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GLOSSARY = ROOT / "GLOSSARY.md"
SKILL = ROOT / ".claude" / "skills" / "orchestrate"
DESIGN = SKILL / "DESIGN.md"
TERMS = [
    "Chief of Staff",
    "Delegation",
    "Executor",
    "Live Session",
    "Brief Contract",
    "Decision Request",
    "Dispatch Plan",
    "Activity Log",
    "Run Summary",
    "Ready to Merge",
]


def glossary_section() -> str:
    return GLOSSARY.read_text(encoding="utf-8").split("\n### Orchestration\n", 1)[1].split("\n### ", 1)[0]


def glossary_terms() -> dict[str, str]:
    return dict(re.findall(r"^\*\*(.+?)\*\*:\n(.+)$", glossary_section(), re.MULTILINE))


def design_terms() -> dict[str, str]:
    section = DESIGN.read_text(encoding="utf-8").split("\n## Glossary\n", 1)[1].split("\n## ", 1)[0]
    return dict(re.findall(r"^\*\*(.+?)\*\*: (.+)$", section, re.MULTILINE))


def test_glossary_defines_the_orchestration_terms() -> None:
    assert list(glossary_terms()) == TERMS


def test_the_skill_design_repeats_them_word_for_word() -> None:
    assert design_terms() == glossary_terms()


def test_live_session_is_always_written_in_full() -> None:
    # "a Session" is allowed only where the text says what the QA term means.
    texts = {path.name: path.read_text(encoding="utf-8") for path in sorted(SKILL.glob("*.md"))}
    texts["GLOSSARY.md#orchestration"] = glossary_section()
    for name, text in texts.items():
        for line in text.splitlines():
            if re.search(r"(?<!Live )\bSessions?\b", line):
                assert "QA" in line, f"{name}: 'Session' without 'Live' outside a QA note: {line.strip()}"
            for spelling in re.findall(r"\blive sessions?\b", line, re.IGNORECASE):
                assert spelling in ("Live Session", "Live Sessions"), (
                    f"{name}: write 'Live Session', not {spelling!r}: {line.strip()}"
                )


if __name__ == "__main__":
    test_glossary_defines_the_orchestration_terms()
    test_the_skill_design_repeats_them_word_for_word()
    test_live_session_is_always_written_in_full()
    print("orchestrate glossary contract: ok")
