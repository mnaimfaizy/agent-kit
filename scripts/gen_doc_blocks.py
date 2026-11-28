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
# The reusable workflows, whose check step fills an empty model with the harness's default.
REUSABLE = ".github/workflows/*-reusable.yml"
DEFAULT_MODEL = re.compile(r'^\s*model="\$\{MODEL:-([^}"]+)\}"$', re.MULTILINE)
EXPRESSION = re.compile(r"\$\{\{\s*(.*?)\s*\}\}")
VARIABLE = re.compile(r"vars\.([A-Z0-9_]+)")
LITERAL = re.compile(r"'([^']*)'")
SWITCH_TERM = re.compile(r"vars\.([A-Z0-9_]+) (!=|==) '(true|false)'")
OWN_MODEL = re.compile(r"AGENT_KIT_([A-Z0-9_]+)_MODEL")
# How the docs name each Stage token; a new token is written in lowercase words.
STAGE_NAMES = {"REVIEW_RESPONSE": "Review response", "SECURITY_AUDIT": "security audit"}


@dataclass(frozen=True)
class Fallback:
    """A setting read as `vars.A || vars.B || 'x'`: the variables in order, then the literal default, if any."""

    variables: tuple[str, ...]
    default: str | None


@dataclass
class Stage:
    """One Stage as an example Caller sets it up: its Kill switch terms and its fallback chains."""

    name: str
    switch: list[tuple[str, bool]]  # (variable, True if it must be `true`, False if it must not be `false`)
    harness: Fallback
    model: Fallback
    effort: Fallback


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
    def default_model(self) -> str:
        """The model every reusable workflow gives `claude-code` when the Caller passes none."""
        found: dict[str, list[str]] = {}
        for path in sorted(self.root.glob(REUSABLE)):
            for model in DEFAULT_MODEL.findall(path.read_text(encoding="utf-8")):
                found.setdefault(model, []).append(path.relative_to(self.root).as_posix())
        if len(found) != 1:
            raise SystemExit(
                f"The reusable workflows should fill an empty model with one default, but have {found or 'none'}"
                ' (a line `model="${MODEL:-<id>}"`); make them agree'
            )
        return next(iter(found))

    @cached_property
    def stages(self) -> list[Stage]:
        """Each Stage, from every example Caller job that passes a `model`, in file and job order."""
        stages: list[Stage] = []
        for path in sorted(self.root.glob(CALLERS)):
            label = path.relative_to(self.root).as_posix()
            caller = yaml.safe_load(path.read_text(encoding="utf-8"))
            jobs = caller.get("jobs") if isinstance(caller, dict) else None
            if not isinstance(jobs, dict):
                raise SystemExit(f"{label}: has no jobs mapping, so no Stage can be read from it")
            for job_name, job in jobs.items():
                settings = (job or {}).get("with") or {}
                if "model" not in settings:
                    continue
                stage = _stage(settings, f"{label}: job {job_name}")
                if any(seen.name == stage.name for seen in stages):
                    raise SystemExit(f"{label}: job {job_name} sets up the {stage.name} Stage a second time")
                stages.append(stage)
        return stages


def _expression(settings: dict, key: str, where: str) -> str:
    match = EXPRESSION.fullmatch(str(settings.get(key, "")).strip())
    if not match:
        raise SystemExit(f"{where}: {key} is not one ${{{{ ... }}}} expression, so no block can be written from it")
    return match.group(1)


def _fallback(settings: dict, key: str, where: str) -> Fallback:
    """`vars.A || vars.B || 'x'`, which must start with a variable."""
    terms = [term.strip() for term in _expression(settings, key, where).split("||")]
    default = LITERAL.fullmatch(terms[-1])
    variables = [VARIABLE.fullmatch(term) for term in (terms[:-1] if default else terms)]
    if not variables or not all(variables):
        raise SystemExit(
            f"{where}: {key} is {' || '.join(terms)!r}; the generator reads only vars.NAME || ... || 'default'"
        )
    return Fallback(tuple(match.group(1) for match in variables), default.group(1) if default else None)


def _stage(settings: dict, where: str) -> Stage:
    switch = []
    for term in _expression(settings, "kill_switch", where).split("||"):
        match = SWITCH_TERM.fullmatch(term.strip())
        if not match or (match.group(2), match.group(3)) not in {("!=", "true"), ("==", "false")}:
            raise SystemExit(
                f"{where}: kill_switch has {term.strip()!r}; the generator reads only"
                " vars.NAME != 'true' or vars.NAME == 'false', joined by ||"
            )
        switch.append((match.group(1), match.group(2) == "!="))
    harness = _fallback(settings, "harness", where)
    model = _fallback(settings, "model", where)
    effort = _fallback(settings, "effort", where)
    token = OWN_MODEL.fullmatch(model.variables[0])
    if not token:
        raise SystemExit(f"{where}: model should read the Stage's own AGENT_KIT_<STAGE>_MODEL first")
    name = STAGE_NAMES.get(token.group(1), token.group(1).lower().replace("_", " "))
    return Stage(name, switch, harness, model, effort)


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
    def condition(variable: str, must_be_true: bool) -> str:
        return f"`{variable}` is `true`" if must_be_true else f"`{variable}` is not `false`"

    rows = [[stage.name, " and ".join(condition(*term) for term in stage.switch)] for stage in sources.stages]
    return _table(["Stage", "Runs when"], rows)


def stage_harness_model_and_effort(sources: Sources) -> str:
    stages = sources.stages
    # Every Stage reads its own variable, then the same shared ones, then the same default.
    for setting in ("harness", "model", "effort"):
        chains = [getattr(stage, setting) for stage in stages]
        tails = {(chain.variables[1:], chain.default) for chain in chains}
        if len(tails) > 1:
            raise SystemExit(
                f"The example Callers' {setting} settings fall back differently ({sorted(map(str, tails))});"
                " the stage-harness-model-and-effort block shows one shared fallback, so make them agree"
            )

    def shared(fallback: Fallback) -> str:
        return ", then ".join(f"`{variable}`" for variable in fallback.variables[1:]) or "none"

    def default(fallback: Fallback) -> str:
        return f"`{fallback.default}`" if fallback.default else "none"

    def own(fallback: Fallback) -> str:
        return f"`{fallback.variables[0]}`"

    rows = [[stage.name, own(stage.harness), own(stage.model), own(stage.effort)] for stage in stages]
    if stages:
        harness, model, effort = stages[0].harness, stages[0].model, stages[0].effort
        rows.append(["any Stage above", shared(harness), shared(model), shared(effort)])
        # A Caller that passes no model leaves it to the workflow's harness default.
        unset = default(model) if model.default else f"the harness's default (`{sources.default_model}`)"
        rows.append(["neither set", default(harness), unset, default(effort)])
    return _table(["Stage", "Harness", "Model", "Effort"], rows)


def _shell_word(value: str) -> str:
    """A shell word, double-quoted as the docs write them unless that would expand something."""
    return f'"{value}"' if not set(value) & set('"\\$`!') else shlex.quote(value)


def trigger_labels(sources: Sources) -> str:
    labels = sources.js["trigger-labels"]
    width = max((len(_shell_word(label["name"])) for label in labels), default=0)
    lines = [
        f"gh label create {_shell_word(label['name']).ljust(width)} --color {label['color']}"
        f" --description {_shell_word(label['description'])}"
        for label in labels
    ]
    return "\n".join(["```bash", *lines, "```"])


# How the Limits table names each limit in cli/src/deep-scan/limits.mjs, and what enforces it.
DEEP_SCAN_LIMITS = {
    "setupMinutes": ("Setup wall clock", "`deep-scan`, from the image step until the agent step starts"),
    "scanMinutes": ("Scan wall clock", "`deep-scan`, over the agent step"),
    "turns": ("Turns", "`deep-scan`'s own `--max-turns` on the Claude Code command line"),
    "tokens": ("Tokens", "the model proxy on your machine, which counts the `usage` the model API returns"),
}


def _missing_prose(kind: str, have: list[str], described: dict) -> None:
    """Stop when the code's list and this script's prose for it differ: new names need words."""
    if sorted(have) != sorted(described):
        raise SystemExit(
            f"{kind} in the code are {sorted(have)}, but scripts/gen_doc_blocks.py describes {sorted(described)};"
            " describe each new one there"
        )


def deep_scan_limits(sources: Sources) -> str:
    fact = sources.js["deep-scan-limits"]
    defaults, verify, flags = fact["DEFAULT_LIMITS"], fact["VERIFY_LIMITS"], fact["LIMIT_FLAGS"]
    _missing_prose("The deep-scan limits", list(defaults), DEEP_SCAN_LIMITS)

    def value(key: str, number: int | float) -> str:
        if key.endswith("Minutes"):
            return f"{number:g} min"
        return f"{number:,} for the run" if key == "tokens" else f"{number:,}"

    rows = [
        [name, value(key, defaults[key]), value(key, verify[key]), f"`--{flags[key]['flag']} <n>`", enforced]
        for key, (name, enforced) in DEEP_SCAN_LIMITS.items()
    ]
    return _table(["Limit", "Default", "Verification run", "Option", "Enforced by"], rows)


# The Scan recipe field table: each field in cli/src/deep-scan/recipe.mjs, whether it is required, and what it holds.
RECIPE_FIELD_ROWS = {
    "image": (
        "no; never with `dockerfile`",
        "A glibc Linux base image, pinned by digest (`@sha256:`). Agent-kit copies its pinned Claude Code onto it.",
    ),
    "dockerfile": ("no; never with `image`", "A Dockerfile's path in the repository. Not a compose file."),
    "setup": (
        "yes (`[]` for none)",
        "Commands run before the agent enters, without the agent or the model credential.",
    ),
    "registries": ("yes (`[]` for none)", "Hosts the setup phase may reach. The network is cut after setup."),
    "start": (
        "with `ready`; optional when every entry point is a command",
        "Commands that start the services as processes inside the one sandbox.",
    ),
    "ready": ("with `start`", "Commands that confirm the services are up."),
    "seed": ("no", "Commands that load test data."),
    "entry_points": ("yes, at least one", None),
    "fixtures": ("yes (`[]` for none)", "Mappings of test users, roles and similar. Fake values only."),
    "grounding": (
        "no",
        "Public `https://` URLs or repository paths `deep-scan` copies in before the agent enters,"
        " since it has no web access.",
    ),
    "notes": ("yes", "A line or a list of lines: what stays static-only."),
}
# How the entry_points row names each entry kind.
ENTRY_KIND_WORDS = {"url": "`url` (http or https)", "port": "`port` (1 to 65535)", "command": "`command`"}


def deep_scan_recipe_fields(sources: Sources) -> str:
    fact = sources.js["deep-scan-recipe-fields"]
    fields, kinds = fact["RECIPE_FIELDS"], fact["ENTRY_KINDS"]
    _missing_prose("The Scan recipe fields", fields, RECIPE_FIELD_ROWS)
    _missing_prose("The entry point kinds", kinds, ENTRY_KIND_WORDS)
    words = [ENTRY_KIND_WORDS[kind] for kind in kinds]
    entry = f"Each one of {', '.join(words[:-1])} or {words[-1]}, with a one-line `note`."
    rows = [[f"`{field}`", RECIPE_FIELD_ROWS[field][0], RECIPE_FIELD_ROWS[field][1] or entry] for field in fields]
    return _table(["Field", "Required", "Holds"], rows)


# Each fact's name, as its markers spell it, and the function that writes its block.
FACTS: dict[str, Callable[[Sources], str]] = {
    "review-response-protected-paths": review_response_protected_paths,
    "trigger-labels": trigger_labels,
    "stage-kill-switches": stage_kill_switches,
    "stage-harness-model-and-effort": stage_harness_model_and_effort,
    "deep-scan-limits": deep_scan_limits,
    "deep-scan-recipe-fields": deep_scan_recipe_fields,
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
