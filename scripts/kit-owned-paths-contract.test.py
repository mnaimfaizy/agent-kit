"""Contract test: `kit-owned-paths.txt` is the one list of Kit-owned paths, and the docs follow it.

A Kit-owned path is copied verbatim from one tag and replaced whole on upgrade.
`kit-owned-paths.txt` at the repository root lists them; `docs/adopt.md`, the
README quickstart, the getting-started copy step, and the future CLI all read
it. The quickstart must delete each path before copying it, or files the kit
later removes linger after an upgrade, and it must never touch a Consumer's
own skills next to the kit's in `.claude/skills/`.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KIT_OWNED = ROOT / "kit-owned-paths.txt"
SNAPSHOT_MANIFEST = ROOT / "scripts" / "release-snapshot-manifest.txt"
ADOPT = ROOT / "docs" / "adopt.md"
README = ROOT / "README.md"
GETTING_STARTED = ROOT / "docs" / "getting-started.md"

ENTRY = re.compile(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*/$")
# Consumers run `rm -rf` on every entry, so only these shapes may appear: one
# Portable skill folder, or one of the four runtime folders. Anything else
# (`.github/workflows/`, `docs/`, a parent folder) would delete Consumer files.
ALLOWED_SHAPE = re.compile(
    r"^(?:\.claude/skills/[A-Za-z0-9._-]+/|\.github/(?:agent-runtime|agent-pipeline|security-audit|agent-review-response)/)$"
)
ADOPT_SECTION = "## Copy Kit-owned paths from the same tag"
ADOPT_BULLET = re.compile(r"^- `([^`]+/)`", re.MULTILINE)


def manifest_entries() -> list[str]:
    lines = KIT_OWNED.read_text(encoding="utf-8").splitlines()
    return [line for line in lines if line and not line.startswith("#")]


def adopt_copy_list() -> list[str]:
    text = ADOPT.read_text(encoding="utf-8")
    assert ADOPT_SECTION in text, f"docs/adopt.md has no '{ADOPT_SECTION}' section"
    section = text.split(ADOPT_SECTION, 1)[1].split("\n## ", 1)[0]
    return ADOPT_BULLET.findall(section)


def copy_block(text: str, doc: str) -> str:
    blocks = [b for b in re.findall(r"```bash\n(.*?)```", text, re.DOTALL) if "git clone" in b and "agent-kit" in b]
    assert len(blocks) == 1, f"{doc}: expected one bash block that clones agent-kit, found {len(blocks)}"
    return blocks[0]


def test_manifest_format_is_trivially_parseable() -> None:
    raw = KIT_OWNED.read_bytes()
    assert b"\r" not in raw, "kit-owned-paths.txt must use LF line endings"
    entries = manifest_entries()
    assert entries, "kit-owned-paths.txt lists no paths"
    for entry in entries:
        assert ENTRY.match(entry), f"kit-owned-paths.txt: {entry!r} is not a plain relative folder path ending in /"
        assert ".." not in entry.split("/"), f"kit-owned-paths.txt: {entry!r} leaves the repository"
        assert ALLOWED_SHAPE.match(entry), (
            f"kit-owned-paths.txt: {entry!r} is not a permitted Kit-owned path shape "
            "(.claude/skills/<name>/ or a .github/ runtime folder)"
        )
    assert len(entries) == len(set(entries)), "kit-owned-paths.txt lists a path twice"


def test_manifest_lists_the_expected_folders() -> None:
    entries = set(manifest_entries())
    for runtime in (
        ".github/agent-runtime/",
        ".github/agent-pipeline/",
        ".github/security-audit/",
        ".github/agent-review-response/",
    ):
        assert runtime in entries, f"kit-owned-paths.txt is missing {runtime}"
    skills = {e for e in entries if e.startswith(".claude/skills/")}
    # Every Portable skill shipped in this repository is Kit-owned, so a new
    # skill folder cannot ship without a manifest line. skills-list-contract.test.py
    # checks this too, and names every other skill list that is out of step.
    shipped = {f".claude/skills/{d.name}/" for d in (ROOT / ".claude" / "skills").iterdir() if d.is_dir()}
    assert skills == shipped, (
        f"kit-owned-paths.txt skills {sorted(skills)} != .claude/skills/ folders {sorted(shipped)}"
    )
    # Folder granularity, one skill per line: never the whole skills folder,
    # which would delete a Consumer's own skills on upgrade.
    assert ".claude/skills/" not in entries
    assert ".claude/" not in entries
    assert ".github/" not in entries


def test_every_entry_is_an_existing_directory() -> None:
    for entry in manifest_entries():
        path = ROOT / entry
        assert path.is_dir(), f"kit-owned-paths.txt: {entry} is not a directory in this repository"
        assert any(path.iterdir()), f"kit-owned-paths.txt: {entry} is empty"


def test_every_entry_ships_in_the_release_snapshot() -> None:
    lines = SNAPSHOT_MANIFEST.read_text(encoding="utf-8").splitlines()
    snapshot = {line.strip() for line in lines if line.strip() and not line.startswith("#")}
    assert "kit-owned-paths.txt" in snapshot, "release-snapshot-manifest.txt must list kit-owned-paths.txt"
    for entry in manifest_entries():
        assert entry in snapshot, f"{entry} is Kit-owned but not in release-snapshot-manifest.txt"


def test_adopt_copy_list_matches_the_manifest() -> None:
    listed = adopt_copy_list()
    assert len(listed) == len(set(listed)), f"docs/adopt.md lists a path twice: {listed}"
    assert sorted(listed) == sorted(manifest_entries()), (
        f"docs/adopt.md copy list {sorted(listed)} != kit-owned-paths.txt {sorted(manifest_entries())}"
    )
    assert "kit-owned-paths.txt" in ADOPT.read_text(encoding="utf-8"), "docs/adopt.md must name the manifest"


def test_adopt_never_calls_a_kit_owned_path_optional() -> None:
    # `doctor` fails when any Kit-owned path is missing, so the copy list must
    # not tell a Consumer they may leave one out.
    text = ADOPT.read_text(encoding="utf-8")
    section = text.split(ADOPT_SECTION, 1)[1].split("\n## ", 1)[0]
    for line in section.splitlines():
        if ADOPT_BULLET.match(line):
            assert "optional" not in line.lower(), f"docs/adopt.md calls a Kit-owned path optional: {line}"


def test_copy_steps_read_the_manifest_and_delete_before_copying() -> None:
    for doc, path in (("README.md", README), ("docs/getting-started.md", GETTING_STARTED)):
        block = copy_block(path.read_text(encoding="utf-8"), doc)
        assert "kit-owned-paths.txt" in block, f"{doc}: the copy step must read kit-owned-paths.txt"
        assert re.search(r"while read -r \w+", block), f"{doc}: the copy step must loop over the manifest"
        # BSD cp copies a source's contents when it ends in /; strip it first.
        assert '"${path%/}"' in block, f"{doc}: strip the trailing / before cp"
        rm = block.find('rm -rf "./$path"')
        cp = block.find('cp -R "/tmp/agent-kit/$path"')
        assert rm != -1, f"{doc}: the copy step must delete each path first"
        assert cp != -1, f"{doc}: the copy step must copy each path from the tag clone"
        assert rm < cp, f"{doc}: the copy step must delete each path before copying it"
        # A stale clone from an earlier run would make `git clone` fail and the
        # loop read the wrong tag: clear it first, and only loop if the clone worked.
        clear = block.find("rm -rf /tmp/agent-kit\n")
        clone = block.find("git clone")
        assert clear != -1 and clear < clone, f"{doc}: remove /tmp/agent-kit before cloning"
        assert re.search(r"git clone [^\n]*/tmp/agent-kit &&\n", block), f"{doc}: chain the loop on git clone &&"
        assert re.search(r"cp -R [^\n]*\|\| \{", block), f"{doc}: stop the loop if a copy fails"
        # Copying the whole skills folder would overwrite or keep stale files
        # next to a Consumer's own skills.
        assert ".claude/skills/." not in block, f"{doc}: never copy the whole .claude/skills/ folder"
        assert "rm -rf .claude" not in block, f"{doc}: never delete a whole folder that holds Consumer files"


if __name__ == "__main__":
    test_manifest_format_is_trivially_parseable()
    test_manifest_lists_the_expected_folders()
    test_every_entry_is_an_existing_directory()
    test_every_entry_ships_in_the_release_snapshot()
    test_adopt_copy_list_matches_the_manifest()
    test_adopt_never_calls_a_kit_owned_path_optional()
    test_copy_steps_read_the_manifest_and_delete_before_copying()
    print("kit-owned-paths contract: ok")
