"""Contract test: each Pattern guide keeps the shape ADR 0012 gives it.

A Pattern guide is a page under `docs/patterns/` and a skeleton under
`examples/patterns/<pattern>/` that a Consumer copies and edits. This checks:

- every page has a skeleton folder of the same name, and every skeleton a page;
- every skeleton holds an agent body (`*.agent.md`), a `SKILL.md` and a runner
  stub (`*.sh`, or `*.mjs` where the runner is a decision core and its shell),
  and the page links every file in it. A pattern with no agent in it is listed
  in NO_AGENT_BODY, and its page must say so. A pattern whose steps are all
  Companion skills is listed in TEMPLATES_ONLY: its skeleton holds templates
  and none of the three parts, and its page must say so;
- every page has the five sections the ADR lists;
- no page or skeleton names the repository the patterns were designed from, or
  its commands. A skeleton marks a placeholder where a host would be named.

Whether a page's reasoning is right is prose, and a reviewer judges it.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGES = ROOT / "docs" / "patterns"
SKELETONS = ROOT / "examples" / "patterns"
SECTIONS = ("## The problem", "## The moving parts", "## Failure modes", "## Adopting it")
RUNNER_SUFFIXES = (".sh", ".mjs")
RULES_SECTION = re.compile(r"^## The rules, and why", re.MULTILINE)
# Patterns where nothing drafts or judges, so a skeleton agent body would be
# invented for the test. The page must say it has none, in these words.
NO_AGENT_BODY = {"external-skills-registry"}
NO_AGENT_SENTENCE = "This skeleton has no agent body."
# Patterns whose every step is a Companion skill, so the skeleton holds only
# the templates passed between the steps. An agent body, a SKILL.md or a runner
# in it would restate the Companion library. The page must say so in these
# words.
TEMPLATES_ONLY = {"planning-chain"}
TEMPLATES_ONLY_SENTENCE = "This skeleton is templates only."
# Names from the source repository that a guide must not carry over. A generic
# pattern name (such as "merge train", ADR 0012 guide 8) is not listed: a guide
# must be able to name itself.
HOST_NAMES = re.compile(
    r"myorganiser|corepack yarn|yarn ai:|ai:commit|ai:create-pr|PrAuthor"
    r"|Surface Label|fix:attribution|github-labels\.json|Introduced in #|\bADR 0(?:025|100)\b"
    r"|merge:train|Merge Danger|Standalone Run|finish-standalone-runs|Sign-off Issue|review:(?:auto|agent|human)"
    r"|Sandcastle|Component(?:Builder|Reviewer)|TestScaffold|gate:(?:mechanical|standard|full)"
    r"|sync-subagents|sync-agent-models|audit-agent-model-catalog|agents:(?:sync|models)|agent-model-policy"
    r"|agent-tool-map|agent-tool-grants|harness-sections|sub-agent-sync-workflow|CodeExplorer"
    r"|check-skill-map|skills:map|skill-atlas|EXTERNAL_SKILLS|Upstream-Owned|upstream-brief|ask-matt"
    r"|mattpocock|modern-web-guidance|\bADR 0(?:030|031|032|081|084)\b"
    r"|\bExplore (?:Request|Summary)\b|repository-conventions|command-reference|nextjs-agent-rules|composer-2\.5"
    r"|one-instruction-file|IssueCreator|PrismaWriter|ApiWriter|StorybookCurator|\bto-(?:prd|issues)\b"
    r"|dispatch-(?:agents|waves)|type:(?:afk|hitl)|status:(?:blocked|done|in-progress)|complexity:(?:low|medium|high)"
    r"|\[(?:PRD|Slice)\]|OUTSTANDING:|HANDOFF:|Pipeline Incident|Gated Pipeline|\bADR 0(?:017|020|045|111)\b",
    re.IGNORECASE,
)


def pages() -> dict[str, Path]:
    return {page.stem: page for page in sorted(PAGES.glob("*.md"))}


def skeletons() -> dict[str, Path]:
    return {folder.name: folder for folder in sorted(SKELETONS.iterdir()) if folder.is_dir()}


def skeleton_problems(name: str, folder: Path) -> list[str]:
    if name in TEMPLATES_ONLY:
        parts = [p.name for p in folder.iterdir() if p.name.endswith(".agent.md") or p.name == "SKILL.md"]
        parts += [p.name for p in folder.iterdir() if p.suffix in RUNNER_SUFFIXES]
        return [f"examples/patterns/{name}/ is templates only but holds {part}" for part in sorted(parts)]
    problems = []
    if name not in NO_AGENT_BODY and not list(folder.glob("*.agent.md")):
        problems.append(f"examples/patterns/{name}/ has no *.agent.md agent body")
    if not (folder / "SKILL.md").is_file():
        problems.append(f"examples/patterns/{name}/ has no SKILL.md")
    if not any(path.suffix in RUNNER_SUFFIXES for path in folder.iterdir()):
        problems.append(f"examples/patterns/{name}/ has no runner stub ({' or '.join(RUNNER_SUFFIXES)})")
    return problems


def page_problems(name: str, page: Path, folder: Path) -> list[str]:
    text = page.read_text(encoding="utf-8")
    problems = [f"docs/patterns/{page.name} has no '{heading}' section" for heading in SECTIONS if heading not in text]
    if name in NO_AGENT_BODY and NO_AGENT_SENTENCE not in text:
        problems.append(f"docs/patterns/{page.name} has no agent body but does not say '{NO_AGENT_SENTENCE}'")
    if name in TEMPLATES_ONLY and TEMPLATES_ONLY_SENTENCE not in text:
        problems.append(f"docs/patterns/{page.name} is templates only but does not say '{TEMPLATES_ONLY_SENTENCE}'")
    if not RULES_SECTION.search(text):
        problems.append(f"docs/patterns/{page.name} has no '## The rules, and why ...' section")
    for path in sorted(folder.iterdir()):
        link = f"../../examples/patterns/{name}/{path.name}"
        if f"]({link})" not in text:
            problems.append(f"docs/patterns/{page.name} does not link {link}")
    return problems


def host_problems() -> list[str]:
    files = sorted(PAGES.glob("*.md")) + sorted(p for p in SKELETONS.rglob("*") if p.is_file())
    problems = []
    for path in files:
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            match = HOST_NAMES.search(line)
            if match:
                problems.append(f"{path.relative_to(ROOT)}:{number} names the source repository: {match.group(0)!r}")
    return problems


def test_every_page_has_a_skeleton_and_every_skeleton_a_page() -> None:
    assert pages(), "docs/patterns/ has no Pattern guide"
    assert sorted(pages()) == sorted(skeletons()), (
        f"pages {sorted(pages())} and skeletons {sorted(skeletons())} must pair one to one"
    )


def test_every_skeleton_holds_its_three_parts() -> None:
    stale = sorted((NO_AGENT_BODY | TEMPLATES_ONLY) - set(skeletons()))
    assert stale == [], f"NO_AGENT_BODY or TEMPLATES_ONLY names {stale}, which has no skeleton"
    both = sorted(NO_AGENT_BODY & TEMPLATES_ONLY)
    assert both == [], f"{both} is in both NO_AGENT_BODY and TEMPLATES_ONLY; TEMPLATES_ONLY already has no agent body"
    problems = [p for name, folder in skeletons().items() for p in skeleton_problems(name, folder)]
    assert problems == [], "\n".join(problems)


def test_every_page_has_its_sections_and_links_its_skeleton() -> None:
    folders = skeletons()
    problems = [
        p for name, page in pages().items() if name in folders for p in page_problems(name, page, folders[name])
    ]
    assert problems == [], "\n".join(problems)


def test_no_guide_names_the_source_repository() -> None:
    problems = host_problems()
    assert problems == [], "\n".join(problems)


if __name__ == "__main__":
    test_every_page_has_a_skeleton_and_every_skeleton_a_page()
    test_every_skeleton_holds_its_three_parts()
    test_every_page_has_its_sections_and_links_its_skeleton()
    test_no_guide_names_the_source_repository()
