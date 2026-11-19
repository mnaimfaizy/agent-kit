"""Contract test: the `deep` mode of `security-audit`, as skill text.

A Deep scan (GLOSSARY.md, ADRs 0016 to 0018) builds, runs and probes the
repository's own code inside a sandbox. Its procedure lives in `DEEP.md`, read
only in `deep` mode, and its report additions in `report-format.md`. These tests
pin the hard rules those files state: never deliver, the Observation boundary,
the `Reproduced` values, web tools off, and never scanning from the host.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDIT_DIR = ROOT / ".claude" / "skills" / "security-audit"
AUDIT_SKILL = AUDIT_DIR / "SKILL.md"
DEEP = AUDIT_DIR / "DEEP.md"
REPORT_FORMAT = AUDIT_DIR / "report-format.md"
CI_PROMPT = ROOT / ".github" / "security-audit" / "prompt.md"
TRIAGE_DIR = ROOT / ".claude" / "skills" / "security-finding-triage"
TRIAGE_SKILL = TRIAGE_DIR / "SKILL.md"
TRIAGE_OUTCOME = TRIAGE_DIR / "OUTCOME-FORMAT.md"
DOC = ROOT / "docs" / "security-audit.md"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def markdown_section(text: str, heading: str, level: str = "##") -> str:
    """The body under `<level> <heading>`, up to the next heading of the same level."""
    marker = f"\n{level} {heading}\n"
    assert marker in text, f"missing heading {level} {heading}"
    return text.split(marker, 1)[1].split(f"\n{level} ", 1)[0]


def mode_bullets(skill_md: str) -> dict[str, str]:
    """Each `- \\`<mode>\\`: …` bullet under `## Modes`, keyed by the mode."""
    body = markdown_section(skill_md, "Modes")
    return {m.group(1): m.group(0) for m in re.finditer(r"^- `(\w+)`:.*$", body, re.M)}


def numbered_steps(body: str) -> list[str]:
    """The numbered items in `body`, each with its indented sub-bullets."""
    return [step.strip() for step in re.split(r"\n(?=\d+\. )", body.strip()) if re.match(r"\d+\. ", step)]


def test_skill_lists_deep_and_links_its_procedure() -> None:
    assert DEEP.is_file(), "the deep procedure must live in DEEP.md inside the skill"
    modes = mode_bullets(read(AUDIT_SKILL))
    assert set(modes) == {"full", "pr", "deep"}, f"SKILL.md must list full, pr and deep: {sorted(modes)}"
    assert "[DEEP.md](DEEP.md)" in modes["deep"], f"the deep mode must link DEEP.md: {modes['deep']!r}"
    assert "only in `deep` mode" in modes["deep"], f"say DEEP.md is read only in deep mode: {modes['deep']!r}"


def test_full_and_pr_never_reference_the_deep_procedure() -> None:
    # The reusable workflow inlines SKILL.md into every full and pr brief (ADR 0017),
    # so only the deep mode's own bullet may name DEEP.md.
    skill = read(AUDIT_SKILL)
    modes = mode_bullets(skill)
    for mode in ("full", "pr"):
        assert "DEEP" not in modes[mode], f"the {mode} mode must not reference DEEP.md: {modes[mode]!r}"
    assert skill.count("DEEP.md") == modes["deep"].count("DEEP.md"), "only the deep bullet may name DEEP.md"
    assert "DEEP" not in read(CI_PROMPT), "the static CI prompt must not reference DEEP.md"


# The ADR 0016 boundary: what an Observation names, and what it never holds.
OBSERVATION_NAMES = ("location", "attacker's position", "kind of input in words", "effect seen")
OBSERVATION_NEVER = ("payload values", "encoded strings", "exact requests", "command sequences", "timing tricks")


def deep_steps() -> list[str]:
    return numbered_steps(markdown_section(read(DEEP), "Procedure"))


def test_never_deliver_is_a_hard_rule_of_every_mode() -> None:
    rules = markdown_section(read(AUDIT_SKILL), "Contract rules")
    rule = next((line for line in rules.splitlines() if "Never deliver" in line), "")
    assert rule, "SKILL.md's contract rules must hold the never-deliver rule (ADR 0016)"
    for needed in ("report", "draft advisory", "not even privately"):
        assert needed in rule, f"the never-deliver rule must say {needed!r}: {rule!r}"
    # The report format's attack-path reminder stays as the field-level form of the same rule.
    assert "(no exploit payload)" in read(REPORT_FORMAT)


def test_deep_never_scans_from_the_host() -> None:
    first = deep_steps()[0]
    assert first.startswith("1. Confirm you are inside the launcher's sandbox"), first
    for needed in ("agent-kit deep-scan", "stop", "on the host", "Never trust a check of your own"):
        assert needed in first, f"DEEP.md step 1 must say {needed!r}: {first}"


def test_deep_follows_the_procedure_in_order() -> None:
    steps = deep_steps()
    expected = (
        "Confirm you are inside the launcher's sandbox",
        "Read the Threat pack and the Scan recipe",
        "Run the `full` walk",
        "Attempt a Reproduction",
        "Probe further",
        "Write the report early",
    )
    heads = [re.sub(r"^\d+\. ", "", step) for step in steps]
    assert len(heads) == len(expected), heads
    for head, start in zip(heads, expected):
        assert head.startswith(start), f"expected a step starting {start!r}, got {head!r}"
    recipe = steps[1]
    for needed in ("entry points", "fixtures", "grounding"):
        assert needed in recipe, f"the reading step must name the recipe's {needed}: {recipe}"
    probe = steps[4]
    assert "attack paths" in probe and "only against the Scan recipe's entry points" in probe, probe
    assert "Never probe" in probe and "deployed" in probe and "third-party" in probe, probe


def test_deep_hard_rules() -> None:
    rules = markdown_section(read(DEEP), "Hard rules")
    for needed in ("Never deliver", "Nothing runnable leaves", "WebFetch", "WebSearch", "Only the report leaves"):
        assert needed in rules, f"DEEP.md's hard rules must say {needed!r}"
    for needed in OBSERVATION_NAMES + OBSERVATION_NEVER:
        assert needed in rules, f"DEEP.md must state the Observation boundary: missing {needed!r}"
    assert "never changes severity" in rules and "Medium floor" in rules


def test_deep_states_the_ledger_interplay() -> None:
    ledger = markdown_section(read(DEEP), "Findings ledger")
    for needed in (
        "concept id",
        "open",
        "skip",
        "whether it reproduced",
        "`rejected`",
        "`accepted-risk`",
        "only when reproduced",
        "regression",
        "public findings ledger gains nothing",
    ):
        assert needed in ledger, f"DEEP.md's ledger section must say {needed!r}: {ledger}"


def test_deep_runs_on_the_trusted_ref_only() -> None:
    scope = markdown_section(read(DEEP), "Scope")
    for needed in ("default branch", "path or attack path", "never a pull request head", "Verification run"):
        assert needed in scope, f"DEEP.md's scope must say {needed!r}: {scope}"


def test_report_format_keeps_severity_and_adds_the_deep_mode() -> None:
    text = read(REPORT_FORMAT)
    assert "- **Mode:** full | pr | deep\n" in text, "the header's Mode line must offer deep"
    # Reproduction never changes severity: the scale and the Medium floor are as before.
    assert "- **Severity:** Critical | High | Medium\n" in text
    assert "- **Max severity:** none | medium | high | critical\n" in text


def test_report_format_defines_the_deep_additions() -> None:
    deep = markdown_section(read(REPORT_FORMAT), "`deep` additions")
    assert "- **Reproduced:** yes | no | not attempted" in deep, "deep findings carry the three Reproduced values"
    assert "- **Observation:**" in deep and "one-line reason" in deep
    for needed in OBSERVATION_NAMES + OBSERVATION_NEVER:
        assert needed in deep, f"the Observation line must follow the ADR 0016 boundary: missing {needed!r}"
    assert "### Open questions" in deep, "deep reports carry an Open questions section"
    assert "- **Stopped:** wall clock | turns | tokens" in deep, "the Stopped: header line and its limits"
    assert "The launcher adds it" in deep and "The agent never writes this line" in deep, "only the launcher writes Stopped:"
    assert "Medium floor" in deep and "A reproduced Low is still dropped" in deep
    assert "entry point" in deep and "not pinned down" in deep, "the Location fallback when tracing fails"


def test_report_format_defines_the_verification_run_variant() -> None:
    variant = markdown_section(read(REPORT_FORMAT), "Verification-run variant")
    assert "- **Mode:** deep (Verification run)" in variant
    assert "- **Reproduced:** yes | no" in variant and "not attempted" not in variant, "a verify answer is yes or no"
    assert "the fix does not hold" in variant and "the fix holds" in variant
    assert "no new findings" in variant.lower()



def test_triage_reads_reproduction_as_evidence_and_stays_static() -> None:
    evidence = markdown_section(read(TRIAGE_OUTCOME), "Evidence", "###")
    for needed in ("`Reproduced`", "Observation", "`yes`", "`no`", "`not attempted`"):
        assert needed in evidence, f"triage's Evidence section must read {needed!r}: {evidence}"
    skill = read(TRIAGE_SKILL)
    # Triage keeps its own "never produce" rule; ADR 0016 changes only security-audit's.
    assert "1. Never produce weaponized exploit instructions or PoCs.\n" in markdown_section(skill, "Hard rules")
    process = markdown_section(skill, "Process")
    assert "`Reproduced`" in process and "Observation" in process, "triage's process must read the Reproduction"
    assert "never build, run or probe" in process, "triage stays static (ADR 0017)"
    assert "Verification run" in process, "a re-check of a Reproduction is a Verification run, not triage"


def test_docs_describe_the_deep_mode_and_what_its_report_never_contains() -> None:
    deep = markdown_section(read(DOC), "Deep mode")
    for needed in ("DEEP.md", "agent-kit deep-scan", "sandbox", "`Reproduced`", "Observation", "Verification run"):
        assert needed in deep, f"the docs' Deep mode section must say {needed!r}"
    never = deep.split("A deep report never contains", 1)
    assert len(never) == 2, "the docs must say what a deep report never contains"
    for needed in OBSERVATION_NEVER + ("script",):
        assert needed in never[1], f"say a deep report never contains {needed!r}"
    assert "WebFetch" in deep and "WebSearch" in deep


if __name__ == "__main__":
    test_skill_lists_deep_and_links_its_procedure()
    test_full_and_pr_never_reference_the_deep_procedure()
    test_never_deliver_is_a_hard_rule_of_every_mode()
    test_deep_never_scans_from_the_host()
    test_deep_follows_the_procedure_in_order()
    test_deep_hard_rules()
    test_deep_states_the_ledger_interplay()
    test_deep_runs_on_the_trusted_ref_only()
    test_report_format_keeps_severity_and_adds_the_deep_mode()
    test_report_format_defines_the_deep_additions()
    test_report_format_defines_the_verification_run_variant()
    test_triage_reads_reproduction_as_evidence_and_stays_static()
    test_docs_describe_the_deep_mode_and_what_its_report_never_contains()
