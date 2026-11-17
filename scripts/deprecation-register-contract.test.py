"""Contract for the Deprecation register (ADR 0010): `docs/deprecations.yml`.

Each removed or renamed name is recorded once. This test reads the register
and fails on any mention of an old name in a tracked file outside history
(ADRs, `CHANGELOG.md`, `release-notes/`), the register itself, and the entry's
own `allowed_paths`. It names no old name itself: every name comes from the
register, so this file never needs an allow-list entry.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
REGISTER = "docs/deprecations.yml"
KINDS = {"variable", "input", "label", "path", "command"}
KEYS = {"kind", "old", "replacement", "release", "allowed_paths"}
# History is meant to keep old names, so every entry may appear there.
HISTORY = ("docs/adr/", "CHANGELOG.md", "release-notes/")


def load_register(root: Path) -> list[dict]:
    return yaml.safe_load((root / REGISTER).read_text(encoding="utf-8"))


def tracked_files(root: Path) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, text=True, check=True).stdout
    return [f for f in out.split("\0") if f]


def covers(path: str, rel: str) -> bool:
    # A path ending in "/" is a folder; any other is one file.
    return rel.startswith(path) if path.endswith("/") else rel == path


def allowed(rel: str, paths: tuple[str, ...]) -> bool:
    return any(covers(p, rel) for p in paths)


def mentions(name: str) -> re.Pattern[str]:
    # A whole name: A_B does not match inside A_B_C.
    return re.compile(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])")


def stale_mentions(root: Path) -> list[str]:
    """One message per tracked file that names an old name where its entry does not allow it."""
    entries = [(e, mentions(e["old"])) for e in load_register(root)]
    problems = []
    for rel in tracked_files(root):
        if rel == REGISTER or allowed(rel, HISTORY):
            continue
        try:
            text = (root / rel).read_text(encoding="utf-8")
        except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError):
            continue
        for e, pattern in entries:
            if allowed(rel, tuple(e["allowed_paths"])) or not pattern.search(text):
                continue
            problems.append(
                f"{rel}: names {e['old']}, which {REGISTER} records as a {e['kind']} "
                f"renamed to {e['replacement']} in {e['release']} (entry `{e['kind']}: {e['old']}`). "
                f"Use {e['replacement']}, or add {rel} to that entry's allowed_paths if it must keep the old name."
            )
    return problems


def test_register_entries_are_well_formed() -> None:
    entries = load_register(ROOT)
    assert isinstance(entries, list) and entries, f"{REGISTER}: must be a non-empty list of entries"
    tracked = set(tracked_files(ROOT))
    seen = set()
    for e in entries:
        where = f"{REGISTER}: entry {e.get('old')!r}"
        assert set(e) == KEYS, f"{where}: keys must be exactly {sorted(KEYS)}, got {sorted(e)}"
        assert e["kind"] in KINDS, f"{where}: kind must be one of {sorted(KINDS)}"
        for key in ("old", "replacement", "release"):
            assert isinstance(e[key], str) and e[key], f"{where}: {key} must be a non-empty string"
        assert re.fullmatch(r"\d+\.\d+\.\d+(-[a-z]+\.\d+)?", e["release"]), f"{where}: release must be a version"
        assert e["old"] != e["replacement"], f"{where}: replacement must differ from old"
        assert e["old"] not in seen, f"{where}: recorded twice"
        seen.add(e["old"])
        assert isinstance(e["allowed_paths"], list), f"{where}: allowed_paths must be a list"
        for p in e["allowed_paths"]:
            assert any(covers(p, f) for f in tracked), f"{where}: allowed path {p} is not tracked"


def test_no_old_name_outside_history_and_its_allowed_paths() -> None:
    problems = stale_mentions(ROOT)
    assert not problems, "\n".join(problems)


def fixture_repo(tmp: Path) -> tuple[Path, dict]:
    """A throwaway git repository holding the real register; returns it and the register's first entry."""
    (tmp / "docs").mkdir()
    shutil.copy(ROOT / REGISTER, tmp / REGISTER)
    subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
    return tmp, load_register(tmp)[0]


def add_files(root: Path, files: dict[str, str]) -> None:
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)


def test_a_mention_outside_the_allowed_paths_fails_naming_the_file_and_entry() -> None:
    with tempfile.TemporaryDirectory() as d:
        root, entry = fixture_repo(Path(d))
        add_files(root, {"README.md": f"Set `{entry['old']}` to `true`.\n"})
        problems = stale_mentions(root)
        assert len(problems) == 1, problems
        assert problems[0].startswith("README.md: "), problems
        assert f"entry `{entry['kind']}: {entry['old']}`" in problems[0], problems
        assert entry["replacement"] in problems[0], problems


def test_a_mention_inside_history_or_the_allowed_paths_passes() -> None:
    with tempfile.TemporaryDirectory() as d:
        root, entry = fixture_repo(Path(d))
        old = entry["old"]
        files = {
            "docs/adr/0009-renames.md": f"`{old}` became `{entry['replacement']}`.\n",
            "CHANGELOG.md": f"- Renamed `{old}`.\n",
            "release-notes/v1.md": f"| `{old}` | `{entry['replacement']}` |\n",
            # A longer name that only starts with the old one is not a mention.
            "README.md": f"Set `{old}_SUFFIX`.\n",
        }
        for p in entry["allowed_paths"]:
            files[p + "x.md" if p.endswith("/") else p] = f"{old}\n"
        add_files(root, files)
        assert stale_mentions(root) == []


if __name__ == "__main__":
    test_register_entries_are_well_formed()
    test_no_old_name_outside_history_and_its_allowed_paths()
    test_a_mention_outside_the_allowed_paths_fails_naming_the_file_and_entry()
    test_a_mention_inside_history_or_the_allowed_paths_passes()
    print("deprecation-register-contract tests passed")
