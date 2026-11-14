"""Contract test: every agent job installs a pinned, verified Bun before claude-code-action.

claude-code-action installs Bun itself from the GitHub release CDN, with three
attempts over about 30 seconds. That CDN returned 5xx for over an hour on
2026-11-08 and failed every agent run in a Consumer (#86). The reusable
workflows now install the same Bun themselves (npm registry first, the GitHub
release through api.github.com as the fallback, each checked against a pinned
SHA-256) and pass the path in through `path_to_bun_executable`, which makes the
action skip its own install.
"""

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = [
    ROOT / ".github" / "workflows" / f"{name}-reusable.yml"
    for name in ("agent-implement", "agent-plan", "agent-review", "agent-review-response", "security-audit")
]
ACTION = "anthropics/claude-code-action@"

# The Bun version each claude-code-action pin installs: `bun-version` in that
# commit's action.yml. When you bump the action pin, read the new action.yml,
# add its SHA here with its Bun version, and if the version changed, update
# BUN_VERSION and both SHA-256 pins (and the release asset id) in every
# workflow above. A Bun that does not match the action can break it.
BUN_FOR_ACTION = {
    "8cf3482550831fb35a4fc3fbf7ca139cf8028b4c": "1.3.14",  # v1.0.233
}


def _agent_steps() -> list[tuple[str, list[dict], int]]:
    found = []
    for workflow in WORKFLOWS:
        data = yaml.safe_load(workflow.read_text(encoding="utf-8"))
        for job in data["jobs"].values():
            steps = job.get("steps", [])
            for i, step in enumerate(steps):
                if str(step.get("uses", "")).startswith(ACTION):
                    found.append((workflow.name, steps, i))
    return found


def _bun_step(steps: list[dict], agent_index: int) -> dict:
    before = [s for s in steps[:agent_index] if s.get("id") == "bun"]
    assert len(before) == 1, "install Bun in a step with id `bun` before claude-code-action"
    return before[0]


def test_every_agent_step_gets_the_installed_bun() -> None:
    agents = _agent_steps()
    assert len(agents) == len(WORKFLOWS), "one claude-code-action step per reusable workflow"
    for name, steps, i in agents:
        agent = steps[i]
        bun = _bun_step(steps, i)
        assert agent["with"].get("path_to_bun_executable") == "${{ steps.bun.outputs.path }}", (
            f"{name}: pass the installed Bun to the action so it skips its own download"
        )
        # A gated agent step needs the same gate on the install, or the install
        # is skipped while the agent runs (or downloads Bun on a skipped run).
        assert bun.get("if") == agent.get("if"), f"{name}: the Bun step must share the agent step's `if`"
        assert bun["env"] == {"GH_TOKEN": "${{ github.token }}"}, f"{name}: the Bun step gets only the job token"


def test_the_install_scripts_are_identical() -> None:
    scripts = {name: _bun_step(steps, i)["run"] for name, steps, i in _agent_steps()}
    assert len(set(scripts.values())) == 1, f"keep the Bun install identical in {sorted(scripts)}"


def test_bun_version_matches_the_action_pin() -> None:
    for name, steps, i in _agent_steps():
        sha = steps[i]["uses"].removeprefix(ACTION).split()[0]
        assert sha in BUN_FOR_ACTION, (
            f"{name}: claude-code-action@{sha} has no Bun version recorded; see BUN_FOR_ACTION in this test"
        )
        script = _bun_step(steps, i)["run"]
        m = re.search(r'^BUN_VERSION="([^"]+)"$', script, re.MULTILINE)
        assert m, f"{name}: pin BUN_VERSION"
        assert m.group(1) == BUN_FOR_ACTION[sha], f"{name}: the action pin installs Bun {BUN_FOR_ACTION[sha]}"
        assert "bun-linux-x64-${BUN_VERSION}.tgz" in script, f"{name}: download the pinned version from npm"


def test_both_downloads_are_verified_before_use() -> None:
    script = _bun_step(*_agent_steps()[0][1:])["run"]
    assert re.search(r'^NPM_SHA256="[0-9a-f]{64}"$', script, re.MULTILINE), "pin the npm tarball's SHA-256"
    assert re.search(r'^RELEASE_SHA256="[0-9a-f]{64}"$', script, re.MULTILINE), "pin the release zip's SHA-256"
    assert re.search(r"releases/assets/\d+\"$", script, re.MULTILINE), "pin the release asset id"
    for archive, extract in (('"$NPM_SHA256" "$work/bun.tgz"', "tar -xzf"), ('"$RELEASE_SHA256"', "unzip")):
        check = script.find(f"verified {archive}")
        assert check != -1 and check < script.find(extract), f"verify before {extract}"
    assert "sha256sum --check --strict" in script
    assert script.find("from_npm; then") < script.find("from_release; then"), "npm first, the release second"
    for flag in ("--fail", "--retry ", "--retry-all-errors", "--retry-max-time"):
        assert flag in script, f"the downloads must use curl {flag.strip()}"
    # The job token goes to curl on stdin, never as an argument other
    # processes on the runner could read.
    assert "--config -" in script
    assert not re.search(r'--header "Authorization', script)
    # A failed install says Bun, not a later `bun: command not found`.
    assert "::error title=Bun install failed::" in script
    assert '"$installed" != "$BUN_VERSION"' in script, "check the installed binary reports the pinned version"


if __name__ == "__main__":
    test_every_agent_step_gets_the_installed_bun()
    test_the_install_scripts_are_identical()
    test_bun_version_matches_the_action_pin()
    test_both_downloads_are_verified_before_use()
    print("bun-install contract: ok")
