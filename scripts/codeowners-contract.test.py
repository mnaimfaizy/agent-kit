"""Contract test: every CODEOWNERS rule points at a real path and names a valid owner.

A rule whose path is renamed or deleted stops routing review silently. This test
fails loudly instead, naming the offending line.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CODEOWNERS = ROOT / ".github" / "CODEOWNERS"

# GitHub also accepts an email address as an owner. This repository uses @handle
# and @org/team rules only, so an email owner fails here rather than being waved
# through unnoticed.
OWNER_PATTERN = re.compile(r"^@[A-Za-z0-9-]+(?:/[A-Za-z0-9._-]+)?$")

GLOB_CHARS = ("*", "?", "[")


def parse_codeowners(path: Path) -> list[tuple[int, str, list[str]]]:
    """Return (line number, path pattern, owners) for each rule, skipping blanks and comments."""
    rules: list[tuple[int, str, list[str]]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.split("#", 1)[0].strip()
        if not stripped:
            continue
        fields = stripped.split()
        rules.append((number, fields[0], fields[1:]))
    return rules


def pattern_exists(pattern: str) -> bool:
    """Resolve a gitignore-style CODEOWNERS pattern against the working tree."""
    relative = pattern.lstrip("/")
    if not relative:
        return False
    if any(char in relative for char in GLOB_CHARS):
        return next(ROOT.glob(relative), None) is not None
    target = (ROOT / relative.rstrip("/")).resolve()
    # A pattern that escapes the repository root (`../x`) must fail, not pass off a sibling checkout.
    if not target.is_relative_to(ROOT):
        return False
    if pattern.endswith("/"):
        return target.is_dir()
    return target.exists()


def test_codeowners_file_exists_and_has_rules() -> None:
    assert CODEOWNERS.is_file(), f"missing {CODEOWNERS}"
    rules = parse_codeowners(CODEOWNERS)
    assert rules, "CODEOWNERS declares no rules, so the other contract tests would pass vacuously"


def test_every_pattern_resolves_to_an_existing_path() -> None:
    broken = [
        f"line {number}: {pattern}"
        for number, pattern, _ in parse_codeowners(CODEOWNERS)
        if not pattern_exists(pattern)
    ]
    assert not broken, "CODEOWNERS patterns that match nothing in the working tree:\n" + "\n".join(broken)


def test_every_rule_has_valid_owners() -> None:
    problems: list[str] = []
    for number, pattern, owners in parse_codeowners(CODEOWNERS):
        if not owners:
            problems.append(f"line {number}: {pattern} declares no owner")
            continue
        problems.extend(
            f"line {number}: {pattern} has invalid owner {owner!r}"
            for owner in owners
            if not OWNER_PATTERN.match(owner)
        )
    assert not problems, "CODEOWNERS owner problems:\n" + "\n".join(problems)


def test_comment_and_blank_lines_are_skipped() -> None:
    lines = CODEOWNERS.read_text(encoding="utf-8").splitlines()
    assert any(line.strip().startswith("#") for line in lines), "expected comment lines to exercise the parser"
    assert any(not line.strip() for line in lines), "expected a blank line to exercise the parser"

    rule_lines = {number for number, _, _ in parse_codeowners(CODEOWNERS)}
    kept = [
        f"line {number}: {line}"
        for number, line in enumerate(lines, start=1)
        if number in rule_lines and (not line.strip() or line.strip().startswith("#"))
    ]
    assert not kept, "parser kept blank or comment lines as rules:\n" + "\n".join(kept)


if __name__ == "__main__":
    test_codeowners_file_exists_and_has_rules()
    test_every_pattern_resolves_to_an_existing_path()
    test_every_rule_has_valid_owners()
    test_comment_and_blank_lines_are_skipped()
    print("codeowners contract tests passed")
