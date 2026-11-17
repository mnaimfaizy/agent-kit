#!/usr/bin/env python3
"""Write every Generated block in the docs from its Doc fact's source (ADR 0010).

A Generated block is the text between two markers in a doc page:

  <!-- generated:<fact> -->
  ...written by this script...
  <!-- /generated:<fact> -->

Only that text is rewritten; the prose around it stays hand-written. Each fact
has one renderer in FACTS. Facts held as JavaScript constants are read by
running scripts/doc-facts.mjs, which prints them as JSON.

Usage:
  uv run python scripts/gen_doc_blocks.py          # rewrite every block, then run prettier on the pages
  uv run python scripts/gen_doc_blocks.py --check  # exit 1, naming each stale block, if any is out of date
  ... --root <dir>   # a repository other than this one (the tests use a copy); the fact readers stay this one's
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC_FACTS_SCRIPT = ROOT / "scripts" / "doc-facts.mjs"
FIX_COMMAND = "uv run python scripts/gen_doc_blocks.py"

# The gated docs (ADR 0010) that are Markdown. History (docs/adr/) is exempt.
DOC_PAGES = ["README.md", "CONTRIBUTING.md", "GLOSSARY.md", "AGENTS.md", "cli/README.md"]
DOC_TREES = ["docs", "examples"]
EXEMPT_TREES = ["docs/adr", "docs/research", "docs/agents"]

MARKER = re.compile(r"<!-- (/?)generated:([a-z0-9-]+) -->")
# Anything a marker was meant to be, so a mistyped one is reported, not skipped.
LOOSE_MARKER = re.compile(r"<!--\s*/?\s*generated\s*:[^>]*-->", re.IGNORECASE)


class Sources:
    """Where renderers read their facts from. Each source is read once."""

    def __init__(self, root: Path) -> None:
        self.root = root

    @cached_property
    def js(self) -> dict:
        """The Doc facts held as JavaScript constants, from scripts/doc-facts.mjs."""
        result = subprocess.run(
            ["node", str(DOC_FACTS_SCRIPT), str(self.root)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise SystemExit(f"scripts/doc-facts.mjs failed:\n{result.stderr}")
        return json.loads(result.stdout)


def _code(items: list[str], conjunction: str = "and") -> str:
    """`a`, `b` and `c`."""
    quoted = [f"`{item}`" for item in items]
    return quoted[0] if len(quoted) == 1 else ", ".join(quoted[:-1]) + f" {conjunction} " + quoted[-1]


def _folders(paths: list[str]) -> list[str]:
    return [path if path.endswith("/") else f"{path}/" for path in paths]


def review_response_protected_paths(sources: Sources) -> str:
    fact = sources.js["review-response-protected-paths"]
    return "\n".join(
        [
            f"- Files named {_code(fact['PROTECTED_FILES'], 'or')}, at any depth.",
            f"- Anything under {_code(_folders(fact['PROTECTED_DIRS_ANY_DEPTH']), 'or')}, at any depth.",
            f"- Anything under {_code(_folders(fact['PROTECTED_ROOT_DIRS']), 'or')}, from the repository root.",
            f"- Every Kit-owned path, from the repository root: {_code(fact['KIT_OWNED_PATHS'])}.",
        ]
    )


# Each fact's name, as its markers spell it, and the function that writes its block.
FACTS: dict[str, Callable[[Sources], str]] = {
    "review-response-protected-paths": review_response_protected_paths,
}


def doc_pages(root: Path) -> list[Path]:
    pages = [root / page for page in DOC_PAGES if (root / page).is_file()]
    for tree in DOC_TREES:
        for page in sorted((root / tree).rglob("*.md")):
            relative = page.relative_to(root).as_posix()
            if not any(relative.startswith(f"{exempt}/") for exempt in EXEMPT_TREES):
                pages.append(page)
    return pages


@dataclass
class Block:
    """One Generated block: its fact, and where its text sits between the markers."""

    fact: str
    start: int
    end: int


def parse(text: str, label: str) -> tuple[list[Block], list[str]]:
    """The page's blocks, and each marker problem in it, by page."""
    blocks, problems, opened = [], [], None
    for marker in LOOSE_MARKER.finditer(text):
        exact = MARKER.fullmatch(marker.group(0))
        if not exact:
            problems.append(
                f"{label}: {marker.group(0)} is not a well-formed marker"
                " (write <!-- generated:<fact> --> and <!-- /generated:<fact> -->)"
            )
            continue
        closing, fact = exact.group(1) == "/", exact.group(2)
        if not closing and opened:
            problems.append(f"{label}: generated:{fact} opens inside another block (generated:{opened[0]})")
        elif not closing:
            opened = (fact, marker.end())
        elif not opened or opened[0] != fact:
            problems.append(f"{label}: <!-- /generated:{fact} --> has no opening marker")
        else:
            if fact in FACTS:
                blocks.append(Block(fact, opened[1], marker.start()))
            else:
                problems.append(f"{label}: generated:{fact} is not a known fact ({', '.join(sorted(FACTS))})")
            opened = None
    if opened:
        problems.append(f"{label}: generated:{opened[0]} has no closing <!-- /generated:{opened[0]} --> marker")
    return blocks, problems


def run(root: Path, check: bool) -> int:
    sources = Sources(root)
    problems, stale, changed, seen = [], [], [], set()
    for page in doc_pages(root):
        label = page.relative_to(root).as_posix()
        text = page.read_text(encoding="utf-8")
        blocks, page_problems = parse(text, label)
        problems += page_problems
        seen.update(block.fact for block in blocks)
        if page_problems:
            continue
        wanted = {block.fact: FACTS[block.fact](sources).strip() for block in blocks}
        page_stale = [block for block in blocks if text[block.start : block.end].strip() != wanted[block.fact]]
        if not page_stale:
            continue
        if check:
            stale += [f"{label}: generated:{block.fact} is stale" for block in page_stale]
            continue
        out, at = [], 0
        for block in blocks:
            out += [text[at : block.start], "\n\n", wanted[block.fact], "\n\n"]
            at = block.end
        page.write_text("".join(out) + text[at:], encoding="utf-8", newline="\n")
        changed.append(label)
    for fact in sorted(set(FACTS) - seen):
        problems.append(f"generated:{fact} appears in no doc page; add its block where the fact is described")
    if problems or stale:
        print("\n".join(problems + stale), file=sys.stderr)
        if stale:
            print(f"Run: {FIX_COMMAND}", file=sys.stderr)
        return 1
    if check:
        print(f"Generated blocks are up to date ({', '.join(sorted(seen))})")
    elif changed:
        prettier(root, changed)
        print(f"Rewrote {', '.join(changed)}")
    else:
        print("Generated blocks were already up to date")
    return 0


def prettier(root: Path, pages: list[str]) -> None:
    npx = shutil.which("npx")
    if not npx:
        print(f"npx not found; run `npx prettier --write {' '.join(pages)}`", file=sys.stderr)
        return
    subprocess.run([npx, "prettier", "--write", *pages], cwd=root, check=True)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Write every Generated block in the docs from its Doc fact's source.")
    parser.add_argument("--check", action="store_true", help="exit 1, naming each stale block, instead of writing")
    parser.add_argument("--root", type=Path, default=ROOT, help="the repository to read and write (default: this one)")
    args = parser.parse_args(argv)
    return run(args.root.resolve(), check=args.check)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
