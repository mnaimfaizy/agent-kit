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
  ... --root <dir>                                 # a repository other than this one (the tests use a copy)
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from functools import cached_property
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC_FACTS_SCRIPT = ROOT / "scripts" / "doc-facts.mjs"
FIX_COMMAND = "uv run python scripts/gen_doc_blocks.py"

# The gated docs (ADR 0010) that are Markdown. History (docs/adr/) is exempt.
DOC_PAGES = ["README.md", "CONTRIBUTING.md", "GLOSSARY.md", "AGENTS.md", "cli/README.md"]
DOC_TREES = ["docs", "examples"]
EXEMPT_TREES = ["docs/adr", "docs/research", "docs/agents"]

OPEN = re.compile(r"<!-- generated:([a-z0-9-]+) -->")
CLOSE = re.compile(r"<!-- /generated:([a-z0-9-]+) -->")


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


def rewrite(text: str, label: str, sources: Sources) -> tuple[str, list[str], list[str]]:
    """The page with every block rewritten, the facts it holds, and its problems."""
    out, facts, problems, at = [], [], [], 0
    for opening in OPEN.finditer(text):
        if opening.start() < at:
            continue
        fact = opening.group(1)
        closing = re.compile(rf"<!-- /generated:{re.escape(fact)} -->").search(text, opening.end())
        if not closing:
            problems.append(f"{label}: generated:{fact} has no closing <!-- /generated:{fact} --> marker")
            continue
        if fact not in FACTS:
            problems.append(f"{label}: generated:{fact} is not a known fact ({', '.join(sorted(FACTS))})")
            continue
        facts.append(fact)
        out += [text[at : opening.end()], "\n\n", FACTS[fact](sources).strip(), "\n\n"]
        at = closing.start()
    out.append(text[at:])
    opened = [m.group(1) for m in OPEN.finditer(text)]
    for closing in CLOSE.finditer(text):
        if closing.group(1) not in opened:
            problems.append(f"{label}: <!-- /generated:{closing.group(1)} --> has no opening marker")
    return "".join(out), facts, problems


def run(root: Path, check: bool) -> int:
    sources = Sources(root)
    problems, changed, seen = [], [], set()
    for page in doc_pages(root):
        label = page.relative_to(root).as_posix()
        text = page.read_text(encoding="utf-8")
        new, facts, page_problems = rewrite(text, label, sources)
        problems += page_problems
        seen.update(facts)
        if page_problems or new == text:
            continue
        if check:
            current, wanted = blocks(text), blocks(new)
            for fact in facts:
                if current.get(fact) != wanted.get(fact):
                    problems.append(f"{label}: generated:{fact} is stale")
        else:
            page.write_text(new, encoding="utf-8", newline="\n")
            changed.append(label)
    for fact in sorted(set(FACTS) - seen):
        problems.append(f"generated:{fact} appears in no doc page; add its block where the fact is described")
    if problems:
        print("\n".join(problems), file=sys.stderr)
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


def blocks(text: str) -> dict[str, str]:
    """Each block's text by fact, blank lines at its edges dropped. One fact's blocks in a page are joined."""
    found: dict[str, str] = {}
    for opening in OPEN.finditer(text):
        fact = opening.group(1)
        closing = re.compile(rf"<!-- /generated:{re.escape(fact)} -->").search(text, opening.end())
        if closing:
            found[fact] = found.get(fact, "") + text[opening.end() : closing.start()].strip() + "\n"
    return found


def prettier(root: Path, pages: list[str]) -> None:
    npx = shutil.which("npx")
    if not npx:
        print(f"npx not found; run `npx prettier --write {' '.join(pages)}`", file=sys.stderr)
        return
    subprocess.run([npx, "prettier", "--write", *pages], cwd=root, check=True)


def main(argv: list[str]) -> int:
    root = ROOT
    if "--root" in argv:
        root = Path(argv[argv.index("--root") + 1]).resolve()
    return run(root, check="--check" in argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
