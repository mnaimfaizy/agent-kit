#!/usr/bin/env python3
"""Verify the working tree contains every whole-kit Release snapshot path."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = Path(__file__).resolve().parent / "release-snapshot-manifest.txt"

TAG_PATTERN = re.compile(
    r"^v(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)"
    r"(?:-(?P<stage>alpha|beta|rc)\.(?P<counter>\d+))?$"
)


def parse_manifest(path: Path) -> list[str]:
    entries: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        entries.append(stripped)
    return entries


def verify_tree(root: Path, manifest_path: Path = MANIFEST) -> list[str]:
    missing: list[str] = []
    for entry in parse_manifest(manifest_path):
        target = root / entry
        if entry.endswith("/"):
            if not target.is_dir() or not any(target.iterdir()):
                missing.append(entry)
        elif not target.is_file():
            missing.append(entry)
    return missing


def parse_tag(tag: str) -> dict[str, str | int] | None:
    match = TAG_PATTERN.match(tag)
    if not match:
        return None
    data = match.groupdict()
    return {
        "major": int(data["major"]),
        "minor": int(data["minor"]),
        "patch": int(data["patch"]),
        "stage": data["stage"] or "",
        "counter": int(data["counter"]) if data["counter"] else 0,
    }


def is_prerelease(tag: str) -> bool:
    parsed = parse_tag(tag)
    return bool(parsed and parsed["stage"])


def notes_required_for_tag(tag: str) -> bool:
    parsed = parse_tag(tag)
    if not parsed:
        return False
    if not parsed["stage"]:
        return True
    return parsed["stage"] in {"beta", "rc"}


CLI_PACKAGE = "cli/package.json"


def cli_version_mismatch(tag: str, root: Path = ROOT) -> str | None:
    """Why `cli/package.json` at HEAD cannot be published from `tag`, or None if it can.

    `git tag -a` tags HEAD, so the version is read from HEAD, not the working
    tree, and an uncommitted change to the file is refused: it would not be in
    the tag that publish-cli.yml publishes.
    """
    shown = subprocess.run(
        ["git", "-C", str(root), "show", f"HEAD:{CLI_PACKAGE}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if shown.returncode != 0:
        return f"cannot read {CLI_PACKAGE} from HEAD: {shown.stderr.strip() or 'git show failed'}"
    version = json.loads(shown.stdout).get("version")
    if f"v{version}" != tag:
        return f"{CLI_PACKAGE} version {version!r} at HEAD does not match tag {tag}; set it to {tag[1:]!r} first."
    diff = subprocess.run(["git", "-C", str(root), "diff", "--quiet", "HEAD", "--", CLI_PACKAGE], check=False)
    if diff.returncode != 0:
        return f"{CLI_PACKAGE} has uncommitted changes; commit them first, because the tag is cut from HEAD."
    return None


def main() -> int:
    missing = verify_tree(ROOT)
    if missing:
        print("Release snapshot verification failed. Missing paths:", file=sys.stderr)
        for path in missing:
            print(f"  - {path}", file=sys.stderr)
        return 1
    print("Release snapshot verification passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
