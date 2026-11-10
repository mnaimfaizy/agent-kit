"""Contract test: the root README keeps up with what the repository ships.

The README went stale wherever no test pinned it: the status line still said
`1.0.0-alpha` two beta releases later, and the CLI, a docs page and the ADRs
were never mentioned. Each check below derives its expectation from the
repository, so adding a doc, a Kit-owned path, a CLI command or a release
fails here until the README says so:

- the status line names the stage of the current version (`cli/package.json`);
- the tags the Quickstart tells a reader to use are the current version;
- every `docs/*.md` page, `docs/adr/` and `cli/README.md` are linked;
- "What ships" has a row for every Kit-owned path, and for the other shipped
  top-level paths;
- "The CLI" has a row for every command the CLI accepts;
- every workflow badge and local image points at a file that exists.

The Portable skills named in "What ships" are checked by
`skills-list-contract.test.py`. What a row *says* about a path is prose, and
is not checked here: that still needs a reviewer.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STAGED = re.compile(r"^(\d+\.\d+\.\d+)-(alpha|beta|rc)\.\d+$")
STABLE = re.compile(r"^\d+\.\d+\.\d+$")
STATUS = re.compile(r"\*\*Status:\*\* pre-release \(`([^`]+)`\)")
# A tag the reader is told to use: `TAG=v…`, `--tag v…`, or "e.g. `v…`".
USED_TAG = re.compile(r"(?:TAG=|--tag |e\.g\. `)(v\d[0-9A-Za-z.\-]*)")
WORKFLOW_BADGE = re.compile(r"actions/workflows/([^/)\s]+)/badge\.svg")
LOCAL_IMAGE = re.compile(r'<img\s[^>]*src="(?!https?://)([^"]+)"|!\[[^\]]*\]\((?!https?://)([^)\s]+)\)')
COMMAND_OPTIONS = re.compile(r"const COMMAND_OPTIONS = \{(.*?)\n\};", re.DOTALL)
# Shipped top-level paths that are not Kit-owned but belong in "What ships".
OTHER_SHIPPED = ("kit-owned-paths.txt", "examples/", "cli/")
SKILLS_DIR = ".claude/skills/"


def readme(root: Path = ROOT) -> str:
    return (root / "README.md").read_text(encoding="utf-8")


def version(root: Path = ROOT) -> str:
    return json.loads((root / "cli" / "package.json").read_text(encoding="utf-8"))["version"]


def section(text: str, heading: str) -> str:
    if f"\n{heading}\n" not in f"\n{text}":
        return ""
    return f"\n{text}".split(f"\n{heading}\n", 1)[1].split("\n## ", 1)[0]


def row_names(body: str) -> set[str]:
    """The backticked first word of each table row's first cell: `init --tag <tag>` gives `init`."""
    names = set()
    for line in body.splitlines():
        first = re.match(r"\|\s*`([^`]+)`", line)
        if first:
            names.add(first.group(1).split()[0])
    return names


def kit_owned_paths(root: Path = ROOT) -> list[str]:
    lines = (root / "kit-owned-paths.txt").read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.startswith("#")]


def cli_commands(root: Path = ROOT) -> list[str]:
    block = COMMAND_OPTIONS.search((root / "cli" / "src" / "cli.mjs").read_text(encoding="utf-8"))
    assert block, "cli/src/cli.mjs no longer has a COMMAND_OPTIONS table; update this test's parser"
    return re.findall(r"^  ([a-z][a-z-]*):", block.group(1), re.MULTILINE)


def status_problems(text: str, current: str) -> list[str]:
    status = STATUS.search(text)
    if STABLE.match(current):
        return [f"README still has a pre-release status line, but the version is {current}"] if status else []
    staged = STAGED.match(current)
    assert staged, f"cli/package.json version {current!r} is not a Release-line version"
    want = f"{staged.group(1)}-{staged.group(2)}"
    if status is None:
        return [f"README has no '**Status:** pre-release (`{want}`)' line"]
    return [] if status.group(1) == want else [f"README status line says `{status.group(1)}`, the version is `{want}`"]


def tag_problems(text: str, current: str) -> list[str]:
    used = USED_TAG.findall(section(text, "## Quickstart"))
    if not used:
        return ["README Quickstart names no tag to use"]
    return [f"README Quickstart uses {tag}, the current tag is v{current}" for tag in used if tag != f"v{current}"]


def link_problems(text: str, root: Path = ROOT) -> list[str]:
    wanted = [f"docs/{page.name}" for page in sorted((root / "docs").glob("*.md"))]
    if any((root / "docs" / "adr").glob("*.md")):
        wanted.append("docs/adr/")
    wanted.append("cli/README.md")
    return [f"README does not link {target}" for target in wanted if f"]({target}" not in text]


def ships_problems(text: str, root: Path = ROOT) -> list[str]:
    rows = row_names(section(text, "## What ships"))
    wanted = {SKILLS_DIR if path.startswith(SKILLS_DIR) else path for path in kit_owned_paths(root)}
    wanted.update(OTHER_SHIPPED)
    return [f"README 'What ships' has no row for `{path}`" for path in sorted(wanted - rows)]


def command_problems(text: str, root: Path = ROOT) -> list[str]:
    rows = row_names(section(text, "## The CLI"))
    return [f"README 'The CLI' has no row for `{name}`" for name in cli_commands(root) if name not in rows]


def file_problems(text: str, root: Path = ROOT) -> list[str]:
    problems = [
        f"README badge names workflow {name}, which is not in .github/workflows/"
        for name in WORKFLOW_BADGE.findall(text)
        if not (root / ".github" / "workflows" / name).is_file()
    ]
    for html, markdown in LOCAL_IMAGE.findall(text):
        target = (html or markdown).split("#", 1)[0]
        if not (root / target).is_file():
            problems.append(f"README shows image {target}, which does not exist")
    return problems


def test_status_line_names_the_current_stage() -> None:
    assert status_problems(readme(), version()) == []


def test_quickstart_uses_the_current_tag() -> None:
    assert tag_problems(readme(), version()) == []


def test_every_doc_page_is_linked() -> None:
    assert link_problems(readme()) == []


def test_what_ships_covers_every_shipped_path() -> None:
    assert ships_problems(readme()) == []


def test_the_cli_section_covers_every_command() -> None:
    assert command_problems(readme()) == []


def test_badges_and_images_point_at_real_files() -> None:
    assert file_problems(readme()) == []


def test_the_checks_can_fail() -> None:
    """Each check reports the staleness it exists for, so none passes by never matching."""
    text, current = readme(), version()
    assert STAGED.match(current), "rewrite the stale-status cases below for a stable version"
    core = current.split("-", 1)[0]

    assert status_problems(text.replace("**Status:**", "**State:**"), current)
    assert status_problems(STATUS.sub(f"**Status:** pre-release (`{core}-nightly`)", text), current)
    assert status_problems(text, core), "a stable version must reject a pre-release status line"

    assert tag_problems(text.replace(f"TAG=v{current}", "TAG=v0.0.1"), current)
    assert tag_problems(text.replace(f"--tag v{current}", "--tag v0.0.1"), current)
    assert tag_problems(text.replace("## Quickstart", "## Start"), current)

    assert "README does not link docs/adopt.md" in link_problems(text.replace("](docs/adopt.md", "](docs/gone.md"))
    assert "README does not link docs/adr/" in link_problems(text.replace("](docs/adr/", "](docs/"))
    assert "README does not link cli/README.md" in link_problems(text.replace("](cli/README.md", "](cli/"))

    owned = next(path for path in kit_owned_paths() if not path.startswith(SKILLS_DIR))
    assert ships_problems(text.replace(f"| `{owned}`", "| `elsewhere/`"))
    assert ships_problems(text.replace("| `cli/`", "| `tools/`"))
    assert len(ships_problems(text.replace("## What ships", "## Contents"))) >= len(OTHER_SHIPPED)

    command = cli_commands()[0]
    assert command_problems(re.sub(rf"\| `{command}\b", "| `other", text))

    assert file_problems(text + "\n![x](https://github.com/o/r/actions/workflows/gone.yml/badge.svg)\n")
    assert file_problems(text + '\n<img src="docs/assets/gone.svg" alt="">\n')
    assert file_problems(text + "\n![gone](docs/assets/gone.png)\n")


if __name__ == "__main__":
    test_status_line_names_the_current_stage()
    test_quickstart_uses_the_current_tag()
    test_every_doc_page_is_linked()
    test_what_ships_covers_every_shipped_path()
    test_the_cli_section_covers_every_command()
    test_badges_and_images_point_at_real_files()
    test_the_checks_can_fail()
