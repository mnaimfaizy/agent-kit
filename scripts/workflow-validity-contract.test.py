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


# ADR 0009 and 0022: every Stage setting is AGENT_KIT_<STAGE>_<SETTING>.
STAGE = {
    "agent-plan-reusable.yml": "PLAN",
    "agent-implement-reusable.yml": "IMPLEMENT",
    "agent-review-reusable.yml": "REVIEW",
    "agent-review-response-reusable.yml": "REVIEW_RESPONSE",
    "security-audit-reusable.yml": "SECURITY_AUDIT",
    "deep-scan-reusable.yml": "DEEP_SCAN",
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
            expected = (
                f"${{{{ vars.AGENT_KIT_AGENT_FLOW_ENABLED != 'true' || vars.AGENT_KIT_{stage}_ENABLED == 'false' }}}}"
            )
        else:
            expected = f"${{{{ vars.AGENT_KIT_{stage}_ENABLED != 'true' }}}}"
        assert kill == expected, f"{path.name}:{job_name}: kill_switch must be {expected}"


# Each Stage has its own harness, model and effort variable, so one can change
# without the others; the shared AGENT_KIT_HARNESS / _MODEL / _EFFORT apply to
# any Stage whose own variable is unset. An empty model takes the harness's
# default in the reusable workflow; no effort at all leaves --effort off.
CHAINS = {"harness": ("HARNESS", "claude-code"), "model": ("MODEL", ""), "effort": ("EFFORT", "")}


def test_callers_resolve_harness_model_and_effort_from_repository_variables() -> None:
    for path, job_name, stage, inputs in caller_jobs():
        called = WORKFLOWS / next(name for name, token in STAGE.items() if token == stage)
        for key, (setting, default) in CHAINS.items():
            assert key in (workflow_call(called).get("inputs") or {}), f"{called.name} takes a {key} input"
            expected = f"${{{{ vars.AGENT_KIT_{stage}_{setting} || vars.AGENT_KIT_{setting} || '{default}' }}}}"
            assert inputs.get(key) == expected, f"{path.name}:{job_name}: {key} must be {expected}"


PROVIDER_SECRETS = (
    "claude_code_oauth_token",
    "anthropic_api_key",
    "openai_api_key",
    "gemini_api_key",
    "cursor_api_key",
)


# ADR 0030: a Stage changes harness by one variable and one secret, never by a
# Caller edit. The Deep scan keeps secrets of its own.
def test_callers_pass_every_provider_secret() -> None:
    for path in callers():
        for job_name, job in load(path)["jobs"].items():
            if "uses" not in job:
                continue
            prefix = "AGENT_KIT_DEEP_SCAN_" if "deep-scan-reusable.yml" in job["uses"] else ""
            for name in PROVIDER_SECRETS:
                expected = f"${{{{ secrets.{prefix}{name.upper()} }}}}"
                assert job.get("secrets", {}).get(name) == expected, f"{path.name}:{job_name}: pass {name}: {expected}"


# The names a Consumer may set, wherever they are read: the old ones are gone,
# while the names that configure Claude Code itself stay (ADR 0022).
OLD_SETTING = re.compile(r"\bCLAUDE_(?!CODE_)(?:[A-Z_]+_)?(?:ENABLED|MODEL|EFFORT|MODE)\b|\bCLAUDE_MODEL_[A-Z_]+\b")


def test_no_workflow_or_caller_names_a_setting_under_its_old_name() -> None:
    for path in live_workflows() + example_callers():
        found = sorted(set(OLD_SETTING.findall(path.read_text(encoding="utf-8"))))
        assert not found, f"{path.name}: {found}"


# The reusable workflows' inputs and secrets as released in v1.0.0-beta.13: an
# old Caller keeps working against a new tag only while each stays declared, with
# the same type and no stricter requirement (`?` marks an optional one).
RELEASED_INPUTS = {
    "agent-plan-reusable.yml": (
        "kill_switch:boolean? allowlist_actors:string? trigger_label:string? issue_number:string "
        "planner_marker:string? model:string? effort:string?"
    ),
    "agent-implement-reusable.yml": (
        "kill_switch:boolean? allowlist_actors:string? trigger_label:string? issue_number:string "
        "planner_marker:string? trusted_plan_author:string? base_branch:string? branch_prefix:string? "
        "branch_name_template:string? verify_commands:string? setup_commands:string? "
        "extra_allowed_tools:string? model:string? effort:string?"
    ),
    "agent-review-reusable.yml": (
        "kill_switch:boolean? allowlist_actors:string? trigger_label:string? pr_number:string head_sha:string "
        "base_sha:string base_ref:string trusted_branch:string? is_fork:boolean? issue_number:string? "
        "planner_marker:string? trusted_plan_author:string? trusted_spec_authors:string? skill_path:string? "
        "model:string? effort:string? response_mode:string? response_workflow:string? "
        "response_allowlist_actors:string? response_reviewer_logins:string?"
    ),
    "agent-review-response-reusable.yml": (
        "kill_switch:boolean? allowlist_actors:string? trigger_label:string? pr_number:string "
        "reviewer_logins:string? extra_protected_paths:string? setup_commands:string? verify_commands:string? "
        "format_commands:string? ci_workflow:string? response_mode:string? model:string? effort:string?"
    ),
    "security-audit-reusable.yml": (
        "mode:string? kill_switch:boolean? allowlist_actors:string? threat_model_path:string "
        "findings_ledger_path:string audit_prompt_path:string? skill_dir:string? report_path:string? "
        "scan_command:string? pr_number:string? head_sha:string? base_sha:string? base_ref:string? "
        "trusted_branch:string? model:string? effort:string? trigger_label:string? notify_email:boolean?"
    ),
    "deep-scan-reusable.yml": (
        "kill_switch:boolean? model:string? effort:string? setup_minutes:number? scan_minutes:number? "
        "max_turns:number? max_tokens:number?"
    ),
}
RELEASED_SECRETS = {
    "agent-plan-reusable.yml": "claude_code_oauth_token",
    "agent-implement-reusable.yml": "claude_code_oauth_token",
    "agent-review-reusable.yml": "claude_code_oauth_token",
    "agent-review-response-reusable.yml": "claude_code_oauth_token",
    "security-audit-reusable.yml": (
        "advisories_token claude_code_oauth_token dependabot_alerts_token notify_email_to notify_email_from "
        "notify_email_smtp_host notify_email_smtp_port notify_email_smtp_username notify_email_smtp_password"
    ),
    "deep-scan-reusable.yml": (
        "anthropic_api_key claude_code_oauth_token advisories_token notify_email_to notify_email_from "
        "notify_email_smtp_host notify_email_smtp_port notify_email_smtp_username notify_email_smtp_password"
    ),
}


def test_an_old_caller_keeps_working() -> None:
    for name, spec in RELEASED_INPUTS.items():
        contract = workflow_call(WORKFLOWS / name)
        released = {}
        for item in spec.split():
            input_name, kind = item.split(":")
            released[input_name] = (kind.rstrip("?"), not kind.endswith("?"))
        inputs = contract.get("inputs") or {}
        for input_name, (kind, required) in released.items():
            assert input_name in inputs, f"{name}: input {input_name} is gone"
            assert inputs[input_name]["type"] == kind, f"{name}: input {input_name} changed type"
            assert bool(inputs[input_name].get("required")) <= required, f"{name}: {input_name} became required"
        for input_name in set(inputs) - set(released):
            assert not inputs[input_name].get("required"), f"{name}: new input {input_name} must be optional"
        secrets = contract.get("secrets") or {}
        for secret in RELEASED_SECRETS[name].split():
            assert secret in secrets, f"{name}: secret {secret} is gone"
        for secret, body in secrets.items():
            if (body or {}).get("required"):
                assert secret == "advisories_token", f"{name}: {secret} must be optional"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("workflow-validity-contract tests passed")
