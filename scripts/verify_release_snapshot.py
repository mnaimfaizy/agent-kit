#!/usr/bin/env python3
"""Verify the working tree contains every whole-kit Release snapshot path."""

from __future__ import annotations

import re
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
