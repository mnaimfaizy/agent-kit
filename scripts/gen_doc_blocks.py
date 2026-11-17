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
import shlex
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

import yaml

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

# The example Callers, whose jobs pass each Stage's settings as GitHub expressions.
CALLERS = "examples/*-caller.yml"
EXPRESSION = re.compile(r"\$\{\{\s*(.*?)\s*\}\}")
VARIABLE = re.compile(r"vars\.([A-Z0-9_]+)")
LITERAL = re.compile(r"'([^']*)'")
SWITCH_TERM = re.compile(r"vars\.([A-Z0-9_]+) (!=|==) '(true|false)'")
OWN_MODEL = re.compile(r"CLAUDE_([A-Z0-9_]+)_MODEL")
# How the docs name each Stage token; a new token is written in lowercase words.
STAGE_NAMES = {"REVIEW_RESPONSE": "Review response", "SECURITY_AUDIT": "security audit"}


@dataclass
class Stage:
    """One Stage as an example Caller sets it up: its Kill switch terms and its fallback chains."""

    name: str
    switch: list[tuple[str, str]]  # (variable, "is `true`" or "is not `false`"), all of which must hold
    model: list[str | None]  # variables in order, then the literal default (None if there is none)
    effort: list[str | None]


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

    @cached_property
    def stages(self) -> list[Stage]:
        """Each Stage, from every example Caller job that passes a `model`, in file and job order."""
        stages = []
        for path in sorted(self.root.glob(CALLERS)):
            label = path.relative_to(self.root).as_posix()
            for job_name, job in (yaml.safe_load(path.read_text(encoding="utf-8")).get("jobs") or {}).items():
                settings = job.get("with") or {}
                if "model" in settings:
                    stages.append(_stage(settings, f"{label}: job {job_name}"))
        return stages


def _expression(settings: dict, key: str, where: str) -> str:
    match = EXPRESSION.fullmatch(str(settings.get(key, "")).strip())
    if not match:
        raise SystemExit(f"{where}: {key} is not one ${{{{ ... }}}} expression, so no block can be written from it")
    return match.group(1)


def _chain(settings: dict, key: str, where: str) -> list[str | None]:
    """`vars.A || vars.B || 'x'` as ["A", "B", "x"]; with no literal at the end, the last item is None."""
    chain: list[str | None] = []
    terms = [term.strip() for term in _expression(settings, key, where).split("||")]
    for at, term in enumerate(terms):
        variable, literal = VARIABLE.fullmatch(term), LITERAL.fullmatch(term)
        if variable:
            chain.append(variable.group(1))
        elif literal and at == len(terms) - 1:
            chain.append(literal.group(1))
        else:
            raise SystemExit(f"{where}: {key} has {term!r}; the generator reads only vars.NAME || ... || 'default'")
    return chain if literal else [*chain, None]


def _stage(settings: dict, where: str) -> Stage:
    switch = []
    for term in _expression(settings, "kill_switch", where).split("||"):
        match = SWITCH_TERM.fullmatch(term.strip())
        if not match or (match.group(2), match.group(3)) not in {("!=", "true"), ("==", "false")}:
            raise SystemExit(
                f"{where}: kill_switch has {term.strip()!r}; the generator reads only"
                " vars.NAME != 'true' or vars.NAME == 'false', joined by ||"
            )
        switch.append((match.group(1), "is `true`" if match.group(2) == "!=" else "is not `false`"))
    model, effort = _chain(settings, "model", where), _chain(settings, "effort", where)
    token = OWN_MODEL.fullmatch(model[0] or "")
    if not token:
        raise SystemExit(f"{where}: model should read the Stage's own CLAUDE_<STAGE>_MODEL first")
    name = STAGE_NAMES.get(token.group(1), token.group(1).lower().replace("_", " "))
    return Stage(name, switch, model, effort)


def _code(items: list[str], conjunction: str = "and") -> str:
    """`a`, `b` and `c`."""
    quoted = [f"`{item}`" for item in items]
    return quoted[0] if len(quoted) == 1 else ", ".join(quoted[:-1]) + f" {conjunction} " + quoted[-1]


def _folders(paths: list[str]) -> list[str]:
    return [path if path.endswith("/") else f"{path}/" for path in paths]


def review_response_protected_paths(sources: Sources) -> str:
    fact = sources.js["review-response-protected-paths"]
    bullets = [
        (fact["PROTECTED_FILES"], "- Files named {}, at any depth.", "or"),
        (_folders(fact["PROTECTED_DIRS_ANY_DEPTH"]), "- Anything under {}, at any depth.", "or"),
        (_folders(fact["PROTECTED_ROOT_DIRS"]), "- Anything under {}, from the repository root.", "or"),
        (fact["KIT_OWNED_PATHS"], "- Every Kit-owned path, from the repository root: {}.", "and"),
    ]
    # A constant emptied in the script drops its bullet rather than rendering an empty list.
    return "\n".join(line.format(_code(items, conjunction)) for items, line, conjunction in bullets if items)


def _table(header: list[str], rows: list[list[str]]) -> str:
    """A Markdown table, padded as prettier pads it."""
    widths = [max(len(cells[at]) for cells in [header, *rows]) for at in range(len(header))]

    def line(cells: list[str]) -> str:
        return "| " + " | ".join(cell.ljust(width) for cell, width in zip(cells, widths, strict=True)) + " |"

    return "\n".join([line(header), line(["-" * width for width in widths]), *map(line, rows)])


def stage_kill_switches(sources: Sources) -> str:
    rows = [[stage.name, " and ".join(f"`{var}` {state}" for var, state in stage.switch)] for stage in sources.stages]
    return _table(["Stage", "Runs when"], rows)


def stage_model_and_effort(sources: Sources) -> str:
    stages = sources.stages
    # Every Stage reads its own variable, then the same shared ones, then the same default.
    for setting in ("model", "effort"):
        tails = {tuple(getattr(stage, setting)[1:]) for stage in stages}
        if len(tails) > 1:
            raise SystemExit(
                f"The example Callers' {setting} settings fall back differently ({sorted(map(str, tails))});"
                " the stage-model-and-effort block shows one shared fallback, so make them agree"
            )

    def shared(chain: list[str | None]) -> str:
        return ", then ".join(f"`{var}`" for var in chain[1:-1]) or "none"

    def default(chain: list[str | None]) -> str:
        return f"`{chain[-1]}`" if chain[-1] else "none"

    rows = [[stage.name, f"`{stage.model[0]}`", f"`{stage.effort[0]}`"] for stage in stages]
    if stages:
        first = stages[0]
        rows.append(["any Stage above", shared(first.model), shared(first.effort)])
        rows.append(["neither set", default(first.model), default(first.effort)])
    return _table(["Stage", "Model", "Effort"], rows)


def _sh(value: str) -> str:
    """A shell word, double-quoted as the docs write them unless that would expand something."""
    return f'"{value}"' if not set(value) & set('"\\$`!') else shlex.quote(value)


def trigger_labels(sources: Sources) -> str:
    labels = sources.js["trigger-labels"]
    width = max((len(_sh(label["name"])) for label in labels), default=0)
    lines = [
        f"gh label create {_sh(label['name']).ljust(width)} --color {label['color']}"
        f" --description {_sh(label['description'])}"
        for label in labels
    ]
    return "\n".join(["```bash", *lines, "```"])


# Each fact's name, as its markers spell it, and the function that writes its block.
FACTS: dict[str, Callable[[Sources], str]] = {
    "review-response-protected-paths": review_response_protected_paths,
    "trigger-labels": trigger_labels,
    "stage-kill-switches": stage_kill_switches,
    "stage-model-and-effort": stage_model_and_effort,
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
    problems: list[str] = []
    stale: list[str] = []
    pending: list[tuple[Path, str, str]] = []
    seen: set[str] = set()
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
        stale += [f"{label}: generated:{block.fact} is stale" for block in page_stale]
        out, at = [], 0
        for block in blocks:
            out += [text[at : block.start], "\n\n", wanted[block.fact], "\n\n"]
            at = block.end
        pending.append((page, label, "".join(out) + text[at:]))
    for fact in sorted(set(FACTS) - seen):
        problems.append(f"generated:{fact} appears in no doc page; add its block where the fact is described")
    # Every page is read and checked before any is written, so a problem leaves the docs as they were.
    if problems and not check:
        print("\n".join(problems), file=sys.stderr)
        print("Fix the markers above; nothing was written.", file=sys.stderr)
        return 1
    if check and (problems or stale):
        print("\n".join(problems + stale), file=sys.stderr)
        if stale:
            print(f"Run: {FIX_COMMAND}", file=sys.stderr)
        return 1
    if check:
        print(f"Generated blocks are up to date ({', '.join(sorted(seen))})")
        return 0
    for page, _, new in pending:
        page.write_text(new, encoding="utf-8", newline="\n")
    if pending:
        changed = [label for _, label, _ in pending]
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
