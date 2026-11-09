"""Contract test: a Portable skill's own suites run in CI and in `npm test`.

A Portable skill may ship scripts with `*.test.mjs` suites next to them (the
`instruction-drift-audit` skill does). Consumers copy the folder verbatim, so
those suites are the only check its scripts get before a tag ships them.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CI = ROOT / ".github" / "workflows" / "ci.yml"
PACKAGE = ROOT / "package.json"
SKILL_SUITES = ".claude/skills/*/*.test.mjs"


def test_ci_runs_every_skill_suite() -> None:
    assert f"run: node --test {SKILL_SUITES}" in CI.read_text(encoding="utf-8"), (
        f"ci.yml must run `node --test {SKILL_SUITES}` in the Tests job"
    )


def test_npm_test_runs_every_skill_suite() -> None:
    script = json.loads(PACKAGE.read_text(encoding="utf-8"))["scripts"]["test"]
    assert SKILL_SUITES in script, f"package.json `test` must include {SKILL_SUITES}"


def test_skills_with_scripts_ship_suites() -> None:
    for skill in sorted((ROOT / ".claude" / "skills").iterdir()):
        if not skill.is_dir():
            continue
        scripts = [p for p in skill.glob("*.mjs") if not p.name.endswith(".test.mjs")]
        if scripts:
            assert list(skill.glob("*.test.mjs")), f"{skill.name} ships scripts but no *.test.mjs suite"


if __name__ == "__main__":
    test_ci_runs_every_skill_suite()
    test_npm_test_runs_every_skill_suite()
    test_skills_with_scripts_ship_suites()
    print("skill suites contract: ok")
