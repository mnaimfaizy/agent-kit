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


def parse_codeowners_text(text: str) -> list[tuple[int, str, list[str]]]:
    """Return (line number, path pattern, owners) for each rule, skipping blanks and comments."""
    rules: list[tuple[int, str, list[str]]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.split("#", 1)[0].strip()
        if not stripped:
            continue
        fields = stripped.split()
        rules.append((number, fields[0], fields[1:]))
    return rules


def parse_codeowners(path: Path) -> list[tuple[int, str, list[str]]]:
    return parse_codeowners_text(path.read_text(encoding="utf-8"))


def pattern_exists(pattern: str) -> bool:
    """Resolve a gitignore-style CODEOWNERS pattern against the working tree."""
    relative = pattern.lstrip("/")
    # A pattern that escapes the repository root (`../x`) must fail, not pass off a sibling checkout.
    if not relative or ".." in Path(relative).parts:
        return False
    if any(char in relative for char in GLOB_CHARS):
        try:
            return next(ROOT.glob(relative), None) is not None
        except ValueError:  # e.g. `**` not used as a whole path component
            return False
    target = (ROOT / relative.rstrip("/")).resolve()
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
    assert not broken, (
        "CODEOWNERS patterns that match nothing in the working tree (or, for a trailing-slash rule, "
        "match a file rather than a directory):\n" + "\n".join(broken)
    )


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


def test_parser_skips_blank_and_comment_lines() -> None:
    # Synthetic input, so reformatting the real CODEOWNERS can never break this test.
    sample = "# header\n\n/docs/  @someone  # trailing note\n   \n# another\n/src/ @a @org/team\n"
    assert parse_codeowners_text(sample) == [
        (3, "/docs/", ["@someone"]),
        (6, "/src/", ["@a", "@org/team"]),
    ]


def test_pattern_exists_edge_cases() -> None:
    assert pattern_exists("/scripts/")
    assert pattern_exists("/scripts/*.test.py")  # glob branch
    assert not pattern_exists("/")  # empty after stripping the anchor
    assert not pattern_exists("/../agent-kit/")  # escapes the repository root
    assert not pattern_exists("/no-such-dir/")
    assert not pattern_exists("/CONTRIBUTING.md/")  # trailing slash requires a directory
    assert not pattern_exists("/scripts/**foo")  # invalid glob fails instead of raising


if __name__ == "__main__":
    test_codeowners_file_exists_and_has_rules()
    test_every_pattern_resolves_to_an_existing_path()
    test_every_rule_has_valid_owners()
    test_parser_skips_blank_and_comment_lines()
    test_pattern_exists_edge_cases()
    print("codeowners contract tests passed")
