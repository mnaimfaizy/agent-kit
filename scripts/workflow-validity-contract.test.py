"""Checks GitHub enforces at load time but actionlint does not catch.

A reusable workflow GitHub cannot load fails every Caller with "Invalid
workflow file" and records a 0s failed run on every push to this repository.
"""

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
EXAMPLES = ROOT / "examples"
KIT_REF = re.compile(r"^mnaimfaizy/agent-kit/\.github/workflows/(?P<file>[\w.-]+)@(?P<ref>\S+)$")
SEMVER_TAG = re.compile(r"^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$")
SHA_PIN = re.compile(r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$")
PERMISSION_SCOPES = {
    "actions",
    "artifact-metadata",
    "attestations",
    "checks",
    "contents",
    "deployments",
    "discussions",
    "id-token",
    "issues",
    "models",
    "packages",
    "pages",
    "pull-requests",
    "repository-projects",
    "security-events",
    "statuses",
}


def load(path: Path) -> dict:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    # PyYAML reads the bare `on` key as boolean True.
    if True in data:
        data["on"] = data.pop(True)
    return data


def live_workflows() -> list[Path]:
    return sorted(WORKFLOWS.glob("*.yml"))


def reusable_workflows() -> list[Path]:
    return sorted(WORKFLOWS.glob("*-reusable.yml"))


def callers() -> list[Path]:
    return sorted(EXAMPLES.glob("*.yml")) + sorted(WORKFLOWS.glob("dogfood-*.yml"))


def workflow_call(path: Path) -> dict:
    return load(path)["on"]["workflow_call"] or {}


def all_permission_blocks(data: dict) -> list[dict]:
    blocks = [data.get("permissions")]
    blocks += [job.get("permissions") for job in data.get("jobs", {}).values()]
    return [b for b in blocks if isinstance(b, dict)]


def all_step_uses(data: dict) -> list[str]:
    uses = []
    for job in data.get("jobs", {}).values():
        uses += [step["uses"] for step in job.get("steps", []) if "uses" in step]
    return uses


def test_reusable_secrets_avoid_reserved_names() -> None:
    for path in reusable_workflows():
        for name in workflow_call(path).get("secrets") or {}:
            assert name.lower() != "github_token", f"{path.name}: `{name}` is reserved"
            assert not name.upper().startswith("GITHUB_"), f"{path.name}: `{name}` is reserved"


def test_reusable_secret_references_are_declared() -> None:
    for path in reusable_workflows():
        declared = set(workflow_call(path).get("secrets") or {})
        used = set(re.findall(r"secrets\.(\w+)", path.read_text(encoding="utf-8")))
        assert used <= declared, f"{path.name}: undeclared secrets {sorted(used - declared)}"


def test_permission_scopes_are_valid() -> None:
    for path in live_workflows() + sorted(EXAMPLES.glob("*.yml")):
        for block in all_permission_blocks(load(path)):
            unknown = set(block) - PERMISSION_SCOPES
            assert not unknown, f"{path.name}: unknown permission scopes {sorted(unknown)}"


def test_live_step_actions_are_sha_pinned() -> None:
    for path in live_workflows():
        for uses in all_step_uses(load(path)):
            if uses.startswith("./"):
                continue
            assert SHA_PIN.match(uses), f"{path.name}: `{uses}` is not pinned to a commit SHA"


def test_callers_match_reusable_contract() -> None:
    for path in callers():
        for job_name, job in load(path)["jobs"].items():
            uses = job.get("uses", "")
            if not uses:
                continue
            match = KIT_REF.match(uses)
            if match:
                assert SEMVER_TAG.match(match["ref"]), f"{path.name}:{job_name} pins `{match['ref']}`, not a SemVer tag"
                target = WORKFLOWS / match["file"]
            else:
                assert uses.startswith("./.github/workflows/"), f"{path.name}:{job_name}: unexpected `{uses}`"
                target = ROOT / uses[2:]
            contract = workflow_call(target)
            inputs = contract.get("inputs") or {}
            secrets = contract.get("secrets") or {}
            passed_inputs = set(job.get("with") or {})
            passed_secrets = set(job.get("secrets") or {})
            where = f"{path.name}:{job_name}"
            assert passed_inputs <= set(inputs), f"{where}: unknown inputs {sorted(passed_inputs - set(inputs))}"
            assert passed_secrets <= set(secrets), f"{where}: unknown secrets {sorted(passed_secrets - set(secrets))}"
            for name, spec in inputs.items():
                if spec.get("required") and "default" not in spec:
                    assert name in passed_inputs, f"{where}: missing required input `{name}`"
            for name, spec in secrets.items():
                if spec.get("required"):
                    assert name in passed_secrets, f"{where}: missing required secret `{name}`"


def test_callers_default_to_kill_switch_on() -> None:
    for path in callers():
        for job_name, job in load(path)["jobs"].items():
            if "uses" not in job:
                continue
            kill = str((job.get("with") or {}).get("kill_switch", ""))
            assert re.fullmatch(r"\$\{\{ vars\.\w+_ENABLED != 'true' \}\}", kill), (
                f"{path.name}:{job_name}: kill_switch must read a vars.*_ENABLED repository variable"
            )


def test_callers_read_model_from_repository_variable() -> None:
    for path in callers():
        for job_name, job in load(path)["jobs"].items():
            if "uses" not in job:
                continue
            model = str((job.get("with") or {}).get("model", ""))
            assert re.fullmatch(r"\$\{\{ vars\.CLAUDE_MODEL \|\| '[a-z0-9-]+' \}\}", model), (
                f"{path.name}:{job_name}: model must read vars.CLAUDE_MODEL with a literal fallback"
            )


if __name__ == "__main__":
    test_reusable_secrets_avoid_reserved_names()
    test_reusable_secret_references_are_declared()
    test_permission_scopes_are_valid()
    test_live_step_actions_are_sha_pinned()
    test_callers_match_reusable_contract()
    test_callers_default_to_kill_switch_on()
    test_callers_read_model_from_repository_variable()
    print("workflow-validity-contract tests passed")
