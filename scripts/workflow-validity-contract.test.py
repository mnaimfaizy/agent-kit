"""Checks GitHub enforces at load time but actionlint does not catch.

A reusable workflow GitHub cannot load fails every Caller with "Invalid
workflow file" and records a 0s failed run on every push to this repository.
"""

import re
import subprocess
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


def example_callers() -> list[Path]:
    # Caller templates are named `*-caller.yml`; other YAML under examples/
    # (such as `qa.config.yml`) is not a workflow.
    return sorted(EXAMPLES.glob("*-caller.yml"))


def callers() -> list[Path]:
    return example_callers() + sorted(WORKFLOWS.glob("dogfood-*.yml"))


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
    for path in live_workflows() + example_callers():
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


PERMISSION_LEVEL = {"none": 0, "read": 1, "write": 2}
NAMES = {level: name for name, level in PERMISSION_LEVEL.items()}


def called_workflow(uses: str) -> Path:
    match = KIT_REF.match(uses)
    return WORKFLOWS / match["file"] if match else ROOT / uses[2:]


def granted_scopes(block: object) -> dict[str, int]:
    """A permissions block as levels; `read-all` / `write-all` cover every scope."""
    if isinstance(block, str):
        level = {"read-all": 1, "write-all": 2}.get(block, 0)
        return {scope: level for scope in PERMISSION_SCOPES}
    return {scope: PERMISSION_LEVEL[level] for scope, level in (block or {}).items()}


def test_callers_grant_what_the_called_jobs_request() -> None:
    # GitHub refuses a called workflow whose job asks for more than its Caller
    # grants, whether or not that job would run ("The nested job ... is
    # requesting ..., but is only allowed ..."). A job-level grant replaces the
    # Caller's top-level one for that job.
    for path in callers():
        caller = load(path)
        for job_name, job in caller["jobs"].items():
            uses = job.get("uses", "")
            if not uses:
                continue
            block = job["permissions"] if "permissions" in job else caller.get("permissions")
            assert block is not None, f"{path.name}:{job_name}: grant permissions explicitly"
            granted = granted_scopes(block)
            called = called_workflow(uses)
            target = load(called)
            # `read-all` and `write-all` blocks too, which all_permission_blocks skips.
            blocks = [target.get("permissions")] + [j.get("permissions") for j in target.get("jobs", {}).values()]
            for requested in [b for b in blocks if b is not None]:
                for scope, level in granted_scopes(requested).items():
                    assert granted.get(scope, 0) >= level, (
                        f"{path.name}:{job_name}: grant `{scope}: {NAMES[level]}`, which {called.name} requests"
                    )


# ADR 0009: every Stage setting is CLAUDE_<STAGE>_<SETTING>.
STAGE = {
    "agent-plan-reusable.yml": "PLAN",
    "agent-implement-reusable.yml": "IMPLEMENT",
    "agent-review-reusable.yml": "REVIEW",
    "agent-review-response-reusable.yml": "REVIEW_RESPONSE",
    "security-audit-reusable.yml": "SECURITY_AUDIT",
}
# The Agent flow's Stages run only when the master switch is exactly true and
# their own Stage switch is not false. The other flows have one switch each.
AGENT_FLOW_STAGES = {"PLAN", "IMPLEMENT", "REVIEW"}


def caller_jobs():
    for path in callers():
        for job_name, job in load(path)["jobs"].items():
            if "uses" in job:
                stage = STAGE[job["uses"].split("/")[-1].split("@")[0]]
                yield path, job_name, stage, job.get("with") or {}


def test_callers_default_to_kill_switch_on() -> None:
    for path, job_name, stage, inputs in caller_jobs():
        kill = str(inputs.get("kill_switch", ""))
        if stage in AGENT_FLOW_STAGES:
            expected = f"${{{{ vars.CLAUDE_AGENT_FLOW_ENABLED != 'true' || vars.CLAUDE_{stage}_ENABLED == 'false' }}}}"
        else:
            expected = f"${{{{ vars.CLAUDE_{stage}_ENABLED != 'true' }}}}"
        assert kill == expected, f"{path.name}:{job_name}: kill_switch must be {expected}"


# Each Stage has its own model and effort variable, so one can change without
# the others; the shared CLAUDE_MODEL / CLAUDE_EFFORT apply to any Stage whose
# own variable is unset. No effort at all leaves --effort off.
def test_callers_read_model_and_effort_from_repository_variables() -> None:
    for path, job_name, stage, inputs in caller_jobs():
        model = str(inputs.get("model", ""))
        assert re.fullmatch(
            rf"\$\{{\{{ vars\.CLAUDE_{stage}_MODEL \|\| vars\.CLAUDE_MODEL \|\| '[a-z0-9-]+' \}}\}}", model
        ), f"{path.name}:{job_name}: model must read vars.CLAUDE_{stage}_MODEL, then vars.CLAUDE_MODEL, then a literal"
        effort = str(inputs.get("effort", ""))
        assert effort == f"${{{{ vars.CLAUDE_{stage}_EFFORT || vars.CLAUDE_EFFORT || '' }}}}", (
            f"{path.name}:{job_name}: effort must read vars.CLAUDE_{stage}_EFFORT, then vars.CLAUDE_EFFORT, then ''"
        )


# ADR 0009 dropped these with no fallback.
REMOVED_VARIABLES = (
    "CLAUDE_PIPELINE_ENABLED",
    "CLAUDE_MODEL_PLAN",
    "CLAUDE_MODEL_IMPLEMENT",
    "CLAUDE_MODEL_REVIEW",
    "CLAUDE_MODEL_REVIEW_RESPONSE",
    "CLAUDE_MODEL_AUDIT",
)


def test_no_old_variable_names_outside_the_release_notes() -> None:
    files = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    # History, the ADR that records the rename, the tests, and doctor's rename map.
    allowed = (
        "release-notes/",
        "CHANGELOG.md",
        ".github/workflows-archive/",
        "docs/adr/",
        "scripts/",
        "cli/src/checks/secrets-and-variables.mjs",
    )
    for rel in files:
        if rel.startswith(allowed):
            continue
        path = ROOT / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError):
            continue
        for name in REMOVED_VARIABLES:
            assert not re.search(rf"\b{name}\b", text), f"{rel}: still names {name}"


if __name__ == "__main__":
    test_reusable_secrets_avoid_reserved_names()
    test_reusable_secret_references_are_declared()
    test_permission_scopes_are_valid()
    test_live_step_actions_are_sha_pinned()
    test_callers_match_reusable_contract()
    test_callers_grant_what_the_called_jobs_request()
    test_callers_default_to_kill_switch_on()
    test_callers_read_model_and_effort_from_repository_variables()
    test_no_old_variable_names_outside_the_release_notes()
    print("workflow-validity-contract tests passed")
