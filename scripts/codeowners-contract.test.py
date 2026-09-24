"""Contract test: every CODEOWNERS rule points at a real path and names a valid owner.

A rule whose path is renamed or deleted stops routing review silently. This test
fails loudly instead, naming the offending line. Every rule must be root-anchored
(start with `/`), because paths are resolved from the repository root only.
"""

import re
from pathlib import Path
from unittest import mock

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
        # Strip the trailing slash and check is_dir() ourselves: Python 3.10's glob
        # ignores it, while 3.11+ treats it as "directories only".
        try:
            matches = ROOT.glob(relative.rstrip("/"))
            if pattern.endswith("/"):
                return any(match.is_dir() for match in matches)
            return next(matches, None) is not None
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
        "match a file rather than a directory; or, for a rule without a leading `/`, need the anchor "
        "because every rule here is root-anchored):\n" + "\n".join(broken)
    )


def test_every_pattern_is_root_anchored() -> None:
    # GitHub matches an unanchored pattern (`docs/`) at any depth, but pattern_exists resolves
    # from the repository root only, so every rule here must start with `/`.
    unanchored = [
        f"line {number}: {pattern}"
        for number, pattern, _ in parse_codeowners(CODEOWNERS)
        if not pattern.startswith("/")
    ]
    assert not unanchored, "CODEOWNERS patterns without a leading `/`:\n" + "\n".join(unanchored)


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
    # Raises ValueError on Python <= 3.12 and matches nothing on 3.13+; false either way.
    assert not pattern_exists("/scripts/**foo")


def test_pattern_exists_glob_branch() -> None:
    assert not pattern_exists("/scripts/*.py/")  # trailing-slash glob matching only files
    assert pattern_exists("/.github/*/")  # trailing-slash glob matching a directory
    # Patch the concrete class (PosixPath/WindowsPath) that ROOT.glob resolves to, so the
    # ValueError handler runs on every Python version.
    with mock.patch.object(type(ROOT), "glob", side_effect=ValueError("invalid pattern")):
        assert not pattern_exists("/scripts/*.test.py")
    # Pin the is_dir() filter itself: with glob faked to return only a file (as Python
    # 3.10 does for a trailing-slash pattern), the rule must fail on 3.11+ too.
    only_a_file = lambda *_: iter([ROOT / "CONTRIBUTING.md"])  # noqa: E731
    with mock.patch.object(type(ROOT), "glob", side_effect=only_a_file):
        assert not pattern_exists("/CONTRIBUTING*/")
        assert pattern_exists("/CONTRIBUTING*")


if __name__ == "__main__":
    test_codeowners_file_exists_and_has_rules()
    test_every_pattern_resolves_to_an_existing_path()
    test_every_pattern_is_root_anchored()
    test_every_rule_has_valid_owners()
    test_parser_skips_blank_and_comment_lines()
    test_pattern_exists_edge_cases()
    test_pattern_exists_glob_branch()
    print("codeowners contract tests passed")
