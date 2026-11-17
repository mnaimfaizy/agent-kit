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


# The characters that continue a name of each kind, (before, after) it, so a
# longer name is not a mention: A_B is not in A_B_C, needs-info is not in
# needs-info-extra or agent:needs-info, plan is not in agent-plan-reusable.yml,
# docs/a.md is not in my-docs/a.md or docs/a.md-x. A variable may follow a dot
# (`vars.NAME`), and a path a slash (`../docs/a.md`).
NAME_CHARS = {
    "variable": ("A-Za-z0-9_", "A-Za-z0-9_"),
    "input": ("A-Za-z0-9_-", "A-Za-z0-9_-"),
    "label": ("A-Za-z0-9_:-", "A-Za-z0-9_:-"),
    "command": ("A-Za-z0-9_-", "A-Za-z0-9_-"),
    "path": ("A-Za-z0-9_.-", "A-Za-z0-9_/-"),
}
assert set(NAME_CHARS) == KINDS


def mentions(kind: str, name: str) -> re.Pattern[str]:
    # An unknown kind is reported by the shape check; scan it as a command meanwhile.
    before, after = NAME_CHARS.get(kind, NAME_CHARS["command"])
    # A dot then a name character continues it too (plan.md, a.md.bak); a dot
    # that ends a sentence does not.
    return re.compile(rf"(?<![{before}]){re.escape(name)}(?![{after}]|\.[A-Za-z0-9_])")


def stale_mentions(root: Path) -> list[str]:
    """One message per tracked file that names an old name where its entry does not allow it."""
    entries = [(e, mentions(e["kind"], e["old"])) for e in load_register(root)]
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
            entry = f"(entry `{e['kind']}: {e['old']}`)"
            if e["replacement"] is None:
                change, fix = f"removed in {e['release']} with no replacement {entry}", "Drop the mention"
            else:
                change, fix = f"renamed to {e['replacement']} in {e['release']} {entry}", f"Use {e['replacement']}"
            problems.append(
                f"{rel}: names the {e['kind']} {e['old']}, which {REGISTER} records as {change}. "
                f"{fix}, or add {rel} to that entry's allowed_paths if it must keep the old name."
            )
    return problems


def register_problems(entries: object, tracked: set[str]) -> list[str]:
    """One message per entry that is not in the register's shape."""
    if not isinstance(entries, list) or not entries:
        return [f"{REGISTER}: must be a non-empty list of entries"]
    problems = []
    seen = set()
    for e in entries:
        where = f"{REGISTER}: entry {e.get('old')!r}" if isinstance(e, dict) else f"{REGISTER}: entry {e!r}"
        if not isinstance(e, dict) or set(e) != KEYS:
            problems.append(f"{where}: keys must be exactly {sorted(KEYS)}")
            continue
        if e["kind"] not in KINDS:
            problems.append(f"{where}: kind must be one of {sorted(KINDS)}")
        for key in ("old", "release"):
            if not isinstance(e[key], str) or not e[key]:
                problems.append(f"{where}: {key} must be a non-empty string")
        # null: removed with no successor. Otherwise the name to use instead.
        r = e["replacement"]
        if r is not None and (not isinstance(r, str) or not r or r == e["old"]):
            problems.append(f"{where}: replacement must be null (removed) or a name other than old")
        if not re.fullmatch(r"\d+\.\d+\.\d+(-[a-z]+\.\d+)?", str(e["release"])):
            problems.append(f"{where}: release must be a version")
        if e["old"] in seen:
            problems.append(f"{where}: recorded twice")
        seen.add(e["old"])
        if not isinstance(e["allowed_paths"], list):
            problems.append(f"{where}: allowed_paths must be a list")
            continue
        problems += [
            f"{where}: allowed path {p} is not tracked"
            for p in e["allowed_paths"]
            if not any(covers(p, f) for f in tracked)
        ]
    return problems


def test_register_entries_are_well_formed() -> None:
    problems = register_problems(load_register(ROOT), set(tracked_files(ROOT)))
    assert not problems, "\n".join(problems)


def test_a_removed_name_and_empty_allowed_paths_are_well_formed() -> None:
    entries = yaml.safe_load(REMOVED_ENTRY)
    assert register_problems(entries, set()) == []


def test_a_replacement_equal_to_old_or_empty_is_not_well_formed() -> None:
    for replacement in ("OLD_FIXTURE_NAME", "''"):
        entries = yaml.safe_load(REMOVED_ENTRY.replace("replacement: null", f"replacement: {replacement}"))
        assert register_problems(entries, set()) == [
            f"{REGISTER}: entry 'OLD_FIXTURE_NAME': replacement must be null (removed) or a name other than old"
        ], replacement


def test_no_old_name_outside_history_and_its_allowed_paths() -> None:
    problems = stale_mentions(ROOT)
    assert not problems, "\n".join(problems)


# A name removed with no successor, allowed nowhere outside history.
REMOVED_ENTRY = """\
- kind: input
  old: OLD_FIXTURE_NAME
  replacement: null
  release: 1.0.0-beta.8
  allowed_paths: []
"""


def fixture_repo(tmp: Path, register: str | None = None) -> tuple[Path, dict]:
    """A throwaway git repository holding the real register (or `register`); returns it and its first entry."""
    (tmp / "docs").mkdir()
    if register is None:
        shutil.copy(ROOT / REGISTER, tmp / REGISTER)
    else:
        (tmp / REGISTER).write_text(register, encoding="utf-8")
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


def test_a_mention_of_a_removed_name_fails_saying_it_has_no_replacement() -> None:
    with tempfile.TemporaryDirectory() as d:
        root, entry = fixture_repo(Path(d), REMOVED_ENTRY)
        add_files(root, {"README.md": "Set `OLD_FIXTURE_NAME`.\n", "CHANGELOG.md": "- Removed `OLD_FIXTURE_NAME`.\n"})
        assert stale_mentions(root) == [
            f"README.md: names the input OLD_FIXTURE_NAME, which {REGISTER} records as removed in 1.0.0-beta.8 "
            "with no replacement (entry `input: OLD_FIXTURE_NAME`). Drop the mention, or add README.md to that "
            "entry's allowed_paths if it must keep the old name."
        ]


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


# One old name per kind of boundary, each beside a longer live name.
KINDS_ENTRIES = "".join(
    f"- kind: {kind}\n  old: {old}\n  replacement: null\n  release: 1.0.0-beta.8\n  allowed_paths: []\n"
    for kind, old in [
        ("variable", "OLD_VAR"),
        ("label", "needs-info"),
        ("command", "plan"),
        ("path", "docs/old.md"),
    ]
)


def test_a_longer_name_of_any_kind_is_not_a_mention_of_the_old_one() -> None:
    with tempfile.TemporaryDirectory() as d:
        root, _ = fixture_repo(Path(d), KINDS_ENTRIES)
        add_files(
            root,
            {
                "live.md": (
                    "`OLD_VAR_X`, `needs-info-extra`, `x-needs-info`, `needs-info:x`, "
                    "agent-plan-reusable.yml, plan.md, `plan-x`, "
                    "docs/old.md.bak, docs/old.mdx, docs/old.md-x, my-docs/old.md\n"
                ),
                "stale.md": "`vars.OLD_VAR`, `needs-info`. Run `plan`. Read [it](../docs/old.md).\n",
            },
        )
        problems = stale_mentions(root)
        assert [p.split(",")[0] for p in problems] == [
            "stale.md: names the variable OLD_VAR",
            "stale.md: names the label needs-info",
            "stale.md: names the command plan",
            "stale.md: names the path docs/old.md",
        ], problems


if __name__ == "__main__":
    test_register_entries_are_well_formed()
    test_no_old_name_outside_history_and_its_allowed_paths()
    test_a_mention_outside_the_allowed_paths_fails_naming_the_file_and_entry()
    test_a_mention_inside_history_or_the_allowed_paths_passes()
    test_a_removed_name_and_empty_allowed_paths_are_well_formed()
    test_a_replacement_equal_to_old_or_empty_is_not_well_formed()
    test_a_mention_of_a_removed_name_fails_saying_it_has_no_replacement()
    test_a_longer_name_of_any_kind_is_not_a_mention_of_the_old_one()
    print("deprecation-register-contract tests passed")
