"""Contract test: every Portable skill declares its scope, and every skill list follows the skill folders.

Each `.claude/skills/<name>/SKILL.md` declares `metadata.agent-kit-scope` in its
frontmatter: `user` for a User-scope skill, `repo` for a Repo-scope skill (see
GLOSSARY.md and ADR 0002).

The skills-list gate takes the folders in `.claude/skills/` as the source of
truth. Adding or deleting a skill fails it until every list follows, and the
failure names each list that is missing a skill or lists an extra one. It never
rewrites docs. The lists:

- `kit-owned-paths.txt`: one `.claude/skills/<name>/` line per skill;
- `docs/adopt.md`: one `` - `.claude/skills/<name>/` `` bullet per skill under
  "Copy Kit-owned paths from the same tag";
- `README.md`: the backticked names in the `` `.claude/skills/` `` row under "What ships";
- `docs/install-skills.md`, once it exists: the first table with a header cell
  that is exactly `agent-kit-scope` (backticks optional). Each row's first cell
  is `` `<name>` `` or `` [`<name>`](link) ``, and its scope cell is `user` or
  `repo`, equal to the skill's own declaration;
- each skill's `metadata.agent-kit-scope`.

`kit-owned-paths-contract.test.py` also checks the first two lists, against the
manifest's other rules. The overlap is on purpose: this gate is the one place
whose failure names every list that is out of step after a skill is added or
deleted. Change the two together.
"""

import re
import shutil
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SKILLS = Path(".claude") / "skills"
SCOPES = ("user", "repo")


def skill_names(root: Path) -> list[str]:
    return sorted(d.name for d in (root / SKILLS).iterdir() if d.is_dir())


INVALID_YAML = object()


def frontmatter(skill_md: Path) -> dict:
    """The YAML between the opening `---` line and the next `---` line; raises yaml.YAMLError if it does not parse."""
    lines = skill_md.read_text(encoding="utf-8-sig").splitlines()
    if not lines or lines[0] != "---" or "---" not in lines[1:]:
        return {}
    data = yaml.safe_load("\n".join(lines[1 : lines.index("---", 1)]))
    return data if isinstance(data, dict) else {}


def declared_scope(root: Path, name: str) -> str | None:
    skill_md = root / SKILLS / name / "SKILL.md"
    if not skill_md.is_file():
        return None
    metadata = frontmatter(skill_md).get("metadata")
    return metadata.get("agent-kit-scope") if isinstance(metadata, dict) else None


def declared_scopes(root: Path, folders: list[str]) -> dict[str, object]:
    """Each skill's declared scope: a value, None when it declares none, or INVALID_YAML."""
    scopes: dict[str, object] = {}
    for name in folders:
        try:
            scopes[name] = declared_scope(root, name)
        except yaml.YAMLError:
            scopes[name] = INVALID_YAML
    return scopes


def kit_owned_skills(root: Path) -> list[str]:
    prefix = ".claude/skills/"
    lines = (root / "kit-owned-paths.txt").read_text(encoding="utf-8").splitlines()
    return [line[len(prefix) : -1] for line in lines if line.startswith(prefix) and line.endswith("/")]


ADOPT_SECTION = "## Copy Kit-owned paths from the same tag"
ADOPT_SKILL_BULLET = re.compile(r"^- `\.claude/skills/([^`/]+)/`", re.MULTILINE)
INSTALL_SKILLS = Path("docs") / "install-skills.md"
README_SECTION = "## What ships"
README_SKILLS_ROW = re.compile(r"^\| `\.claude/skills/` +\|(.*)\|\s*$", re.MULTILINE)


def section(text: str, heading: str) -> str | None:
    if f"\n{heading}\n" not in f"\n{text}":
        return None
    return f"\n{text}".split(f"\n{heading}\n", 1)[1].split("\n## ", 1)[0]


def adopt_skills(root: Path) -> list[str] | None:
    body = section((root / "docs" / "adopt.md").read_text(encoding="utf-8"), ADOPT_SECTION)
    return None if body is None else ADOPT_SKILL_BULLET.findall(body)


def readme_skills(root: Path) -> list[str] | None:
    body = section((root / "README.md").read_text(encoding="utf-8"), README_SECTION)
    row = README_SKILLS_ROW.search(body or "")
    if row is None:
        return None
    # Only the names in "**Portable skills**: `a`, `b`." count, not other code later in the cell.
    names = re.search(r"\*\*Portable skills\*\*:\s*((?:`[^`]+`(?:,\s*)?)+)", row.group(1))
    return [] if names is None else re.findall(r"`([^`]+)`", names.group(1))


def cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


TABLE_SKILL_CELL = re.compile(r"\[?`([^`]+)`(?:\]\([^)]*\))?")


def install_scope_table(root: Path) -> list[tuple[str, str]] | None:
    """(skill, scope) rows of the table whose header has an `agent-kit-scope` column, or None if there is none."""
    lines = (root / INSTALL_SKILLS).read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        header = cells(line) if line.startswith("|") else []
        scope_column = next((n for n, cell in enumerate(header) if cell.strip("`") == "agent-kit-scope"), None)
        if scope_column is None:
            continue
        rows = []
        for row in lines[i + 2 :]:
            if not row.startswith("|"):
                break
            row_cells = cells(row)
            # A first cell that is not `name` or [`name`](link) is kept whole, so it shows up as an extra skill.
            skill = TABLE_SKILL_CELL.fullmatch(row_cells[0])
            scope = row_cells[scope_column].strip("`") if scope_column < len(row_cells) else ""
            rows.append((skill.group(1) if skill else row_cells[0], scope))
        return rows
    return None


def out_of_step(list_name: str, listed: list[str], folders: list[str]) -> list[str]:
    missing = sorted(set(folders) - set(listed))
    extra = sorted(set(listed) - set(folders))
    twice = sorted({name for name in listed if listed.count(name) > 1})
    problems = []
    if missing:
        problems.append(f"{list_name} is missing {', '.join(missing)}")
    if extra:
        problems.append(f"{list_name} lists {', '.join(extra)}, with no folder in .claude/skills/")
    if twice:
        problems.append(f"{list_name} lists {', '.join(twice)} twice")
    return problems


def skills_list_problems(root: Path) -> list[str]:
    """One message per list that does not name exactly the folders in `.claude/skills/`."""
    folders = skill_names(root)
    # (label, the skills it names or None when the list itself is not found, what to say when it is not found)
    lists = [
        ("kit-owned-paths.txt", kit_owned_skills(root), ""),
        ("docs/adopt.md copy list", adopt_skills(root), f"no '{ADOPT_SECTION}' section"),
        ("README.md What ships row", readme_skills(root), "no `.claude/skills/` row under What ships"),
    ]
    table = None
    # docs/install-skills.md ships with the Skill installer docs (#112); until then there is no table to check.
    # #112 must drop this is_file() guard when it adds the page, so a later rename or deletion fails as "not found".
    if (root / INSTALL_SKILLS).is_file():
        table = install_scope_table(root)
        names = None if table is None else [skill for skill, _ in table]
        lists.append(("docs/install-skills.md scope table", names, "no table with an agent-kit-scope column"))
    problems = []
    for label, listed, why_not_found in lists:
        if listed is None:
            problems.append(f"{label} not found ({why_not_found})")
        else:
            problems += out_of_step(label, listed, folders)
    scopes = declared_scopes(root, folders)
    for skill, scope in table or []:
        declared = scopes.get(skill)
        if declared in SCOPES and scope != declared:
            problems.append(
                f"docs/install-skills.md scope table says {skill} is {scope}, but its SKILL.md declares {declared}"
            )
    for name, scope in scopes.items():
        if scope is INVALID_YAML:
            problems.append(f"SKILL.md frontmatter is not valid YAML in {name}")
        elif scope is None:
            problems.append(f"metadata.agent-kit-scope is missing from {name}")
        elif scope not in SCOPES:
            problems.append(f"metadata.agent-kit-scope is not user or repo in {name} ({scope!r})")
    return problems


# A scratch repository tree whose lists all name the same skills.
def make_repo(root: Path, scopes: dict[str, str]) -> Path:
    for name, scope in scopes.items():
        write_skill(root, name, scope)
    (root / "kit-owned-paths.txt").write_text(
        "# comment\n\n" + "".join(f".claude/skills/{n}/\n" for n in scopes) + ".github/agent-runtime/\n",
        encoding="utf-8",
    )
    (root / "docs").mkdir()
    bullets = "".join(f"- `.claude/skills/{n}/` — note\n" for n in scopes)
    (root / "docs" / "adopt.md").write_text(
        f"# Adopt\n\n## Copy Kit-owned paths from the same tag\n\nIntro.\n\n{bullets}"
        "- `.github/agent-runtime/`\n\n## Next\n\n- `.claude/skills/not-this-section/`\n",
        encoding="utf-8",
    )
    names = ", ".join(f"`{n}`" for n in scopes)
    (root / "README.md").write_text(
        "# Kit\n\n## What ships\n\n| Path | Purpose |\n| --- | --- |\n"
        "| `.github/agent-runtime/` | Hook `x`. Copy. |\n"
        f"| `.claude/skills/` | **Portable skills**: {names}. Each ships a `SKILL.md`. Copy. |\n",
        encoding="utf-8",
    )
    return root


def write_skill(root: Path, name: str, scope: str | None) -> None:
    folder = root / SKILLS / name
    folder.mkdir(parents=True)
    meta = f"metadata:\n  agent-kit-scope: {scope}\n" if scope else ""
    (folder / "SKILL.md").write_text(f"---\nname: {name}\ndescription: d\n{meta}---\n\nbody\n", encoding="utf-8")


def test_gate_names_every_list_missing_a_skill_when_a_folder_is_added(tmp_path: Path) -> None:
    root = make_repo(tmp_path, {"alpha": "user", "beta": "repo"})
    write_skill(root, "gamma", "user")
    assert skills_list_problems(root) == [
        "kit-owned-paths.txt is missing gamma",
        "docs/adopt.md copy list is missing gamma",
        "README.md What ships row is missing gamma",
    ]


def test_gate_names_every_list_with_an_extra_skill_when_a_folder_is_deleted(tmp_path: Path) -> None:
    root = make_repo(tmp_path, {"alpha": "user", "beta": "repo"})
    shutil.rmtree(root / SKILLS / "beta")
    assert skills_list_problems(root) == [
        "kit-owned-paths.txt lists beta, with no folder in .claude/skills/",
        "docs/adopt.md copy list lists beta, with no folder in .claude/skills/",
        "README.md What ships row lists beta, with no folder in .claude/skills/",
    ]


def test_gate_names_skills_without_a_valid_scope(tmp_path: Path) -> None:
    root = make_repo(tmp_path, {"alpha": "user", "beta": None, "gamma": "global"})
    assert skills_list_problems(root) == [
        "metadata.agent-kit-scope is missing from beta",
        "metadata.agent-kit-scope is not user or repo in gamma ('global')",
    ]


def test_gate_names_a_skill_whose_frontmatter_is_not_valid_yaml(tmp_path: Path) -> None:
    root = make_repo(tmp_path, {"alpha": "user", "beta": "repo"})
    (root / SKILLS / "beta" / "SKILL.md").write_text("---\nname: beta\ndescription: Foo: bar\n---\n", encoding="utf-8")
    assert skills_list_problems(root) == ["SKILL.md frontmatter is not valid YAML in beta"]


def test_gate_reads_frontmatter_closed_at_the_end_of_the_file(tmp_path: Path) -> None:
    root = make_repo(tmp_path, {"alpha": "user", "beta": "repo"})
    (root / SKILLS / "beta" / "SKILL.md").write_text(
        "---\nname: beta\ndescription: d\nmetadata:\n  agent-kit-scope: repo\n---", encoding="utf-8"
    )
    assert skills_list_problems(root) == []


def test_gate_names_a_skill_listed_twice(tmp_path: Path) -> None:
    root = make_repo(tmp_path, {"alpha": "user", "beta": "repo"})
    with (root / "kit-owned-paths.txt").open("a", encoding="utf-8") as f:
        f.write(".claude/skills/alpha/\n")
    assert skills_list_problems(root) == ["kit-owned-paths.txt lists alpha twice"]


def test_gate_reads_linked_table_cells_and_bom_frontmatter(tmp_path: Path) -> None:
    root = make_repo(tmp_path, {"alpha": "user", "beta": "repo"})
    skill_md = root / SKILLS / "beta" / "SKILL.md"
    skill_md.write_text("﻿" + skill_md.read_text(encoding="utf-8"), encoding="utf-8")
    write_install_table(root, {"[`alpha`](../.claude/skills/alpha/SKILL.md)": "user", "`beta`": "repo"})
    assert skills_list_problems(root) == []


def write_install_table(root: Path, rows: dict[str, str]) -> None:
    # A key already in Markdown (`name` or a [`name`](link)) is written as given.
    body = "".join(f"| {n if n[0] in '[`' else f'`{n}`'} | `{s}` | note |\n" for n, s in rows.items())
    (root / "docs" / "install-skills.md").write_text(
        "# Install individual skills\n\n| Skill | `agent-kit-scope` | Notes |\n| --- | --- | --- |\n"
        f"{body}\n| Command | What |\n| --- | --- |\n| `npx` | `other` |\n",
        encoding="utf-8",
    )


def test_gate_checks_the_install_skills_scope_table_once_it_exists(tmp_path: Path) -> None:
    root = make_repo(tmp_path, {"alpha": "user", "beta": "repo", "gamma": "user"})
    write_install_table(root, {"alpha": "user", "beta": "user", "delta": "repo"})
    assert skills_list_problems(root) == [
        "docs/install-skills.md scope table is missing gamma",
        "docs/install-skills.md scope table lists delta, with no folder in .claude/skills/",
        "docs/install-skills.md scope table says beta is user, but its SKILL.md declares repo",
    ]


def test_every_skill_list_in_this_repository_follows_the_skill_folders() -> None:
    problems = skills_list_problems(ROOT)
    assert not problems, "Skill lists out of step with .claude/skills/:\n- " + "\n- ".join(problems)


def test_adopt_puts_no_count_on_the_shipped_skill_folders() -> None:
    # A count in prose goes stale whenever a skill is added; the gate cannot check it.
    text = (ROOT / "docs" / "adopt.md").read_text(encoding="utf-8")
    counted = re.findall(r"\b(\w+) shipped skill folders", text)
    assert counted and all(word == "the" for word in counted), f"docs/adopt.md counts the skill folders: {counted}"


def test_every_portable_skill_declares_a_valid_scope() -> None:
    for name in skill_names(ROOT):
        scope = declared_scope(ROOT, name)
        assert scope in SCOPES, (
            f".claude/skills/{name}/SKILL.md: metadata.agent-kit-scope is {scope!r}, expected one of {SCOPES}"
        )


if __name__ == "__main__":
    import tempfile

    test_gate_names_every_list_missing_a_skill_when_a_folder_is_added(Path(tempfile.mkdtemp()))
    test_gate_names_every_list_with_an_extra_skill_when_a_folder_is_deleted(Path(tempfile.mkdtemp()))
    test_gate_names_skills_without_a_valid_scope(Path(tempfile.mkdtemp()))
    test_gate_names_a_skill_whose_frontmatter_is_not_valid_yaml(Path(tempfile.mkdtemp()))
    test_gate_reads_frontmatter_closed_at_the_end_of_the_file(Path(tempfile.mkdtemp()))
    test_gate_names_a_skill_listed_twice(Path(tempfile.mkdtemp()))
    test_gate_reads_linked_table_cells_and_bom_frontmatter(Path(tempfile.mkdtemp()))
    test_gate_checks_the_install_skills_scope_table_once_it_exists(Path(tempfile.mkdtemp()))
    test_every_skill_list_in_this_repository_follows_the_skill_folders()
    test_adopt_puts_no_count_on_the_shipped_skill_folders()
    test_every_portable_skill_declares_a_valid_scope()
    print("skills-list contract: ok")
