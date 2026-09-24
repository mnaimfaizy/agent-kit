import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "security-audit-reusable.yml"
NOTIFIER = ROOT / ".github" / "security-audit" / "notify-email.sh"
PUBLISH = ROOT / ".github" / "security-audit" / "publish-draft-advisory.sh"
COMMENT = ROOT / ".github" / "security-audit" / "comment-pr-counts.sh"
SECURITY_AUDIT_DOC = ROOT / "docs" / "security-audit.md"
CALLER_EXAMPLE = ROOT / "examples" / "security-audit-caller.yml"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_reusable_job_surface() -> None:
    data = read(WORKFLOW)
    assert "workflow_call:" in data
    assert "Publish draft GHSA (required private delivery)" in data
    assert "sha256sum -c" in data
    assert "STAGED_DIR" in data
    assert "./.github/security-audit/publish-draft-advisory.sh" not in data
    assert "PR comment (counts only)" in data
    assert "steps.finding_count.outputs.count != '0'" in data
    assert "inputs.mode == 'pr'" in data


def test_public_log_rule_no_artifact_upload() -> None:
    data = read(WORKFLOW)
    assert "upload-artifact" not in data
    assert 'cat "$REPORT_PATH"' not in data


def test_private_delivery_sink_present() -> None:
    publish = read(PUBLISH)
    assert "/security-advisories" in publish
    assert "vulnerabilities" in publish
    assert "Draft advisory created" in publish


def test_counts_only_comment() -> None:
    comment = read(COMMENT)
    assert "Medium+ finding(s)" in comment
    assert "private draft advisory" in comment


def test_private_org_docs_use_same_job() -> None:
    doc = read(SECURITY_AUDIT_DOC)
    assert "same job applies to public, private, and org repositories" in doc
    assert "enable Advisories first" in doc


def test_caller_contract_ownership_documented() -> None:
    doc = read(SECURITY_AUDIT_DOC)
    assert "The Caller owns:" in doc
    assert "Threat pack paths" in doc
    assert "allowlist policy" in doc
    assert "advisories token secret" in doc


CLAUDE_ACTION_SHA = "8cf3482550831fb35a4fc3fbf7ca139cf8028b4c"


def _step(data: str, name: str) -> str:
    marker = f"- name: {name}\n"
    start = data.index(marker)
    rest = data[start + len(marker) :]
    next_step = rest.find("\n      - ")
    return rest if next_step < 0 else rest[:next_step]


def test_audit_agent_cannot_see_the_advisory_token_or_widen_tools() -> None:
    data = read(WORKFLOW)
    agent_at = data.index("Run security audit (Claude Code)")
    publish_at = data.index("Publish draft GHSA (required private delivery)")
    assert agent_at < publish_at
    agent = _step(data, "Run security audit (Claude Code)")
    assert "advisories_token" not in agent
    assert "github_token:" in agent
    assert '--allowedTools "${{ steps.tools.outputs.allowed }}"' in agent
    assert agent.count("--allowedTools") == 1
    assert "--max-turns 100" in agent
    assert '--disallowedTools "Read(./.git/**),Edit(./.github/agent-runtime/**)"' in agent
    assert "read-confinement.settings.json" in agent
    assert "--dangerously-skip-permissions" not in data
    assert f"anthropics/claude-code-action@{CLAUDE_ACTION_SHA}" in data
    assert "id-token:" not in data
    assert "persist-credentials: false" in data
    assert re.search(r"actions/checkout@[0-9a-f]{40} # v7", data)
    assert "actions/checkout@v" not in data
    assert 'echo "allowed=Read,Glob,Grep,Write"' in data
    assert "gh api user" in data
    assert "upload-artifact" not in data


def test_audit_restores_runtime_and_stages_scripts_from_a_trusted_commit() -> None:
    data = read(WORKFLOW)
    restore = _step(data, "Restore trusted audit runtime from PR base")
    assert 'git cat-file -e "$BASE_SHA^{commit}"' in restore
    assert 'git fetch --no-tags origin "$BASE_BRANCH"' in restore
    assert 'origin "$BASE_SHA"' not in restore
    assert "git ls-files -z" in restore
    assert 'git ls-tree -r -z --name-only "$BASE_SHA"' in restore
    assert ".github/agent-runtime" in restore
    assert ".github/security-audit/prompt.md" in restore
    stage = _step(data, "Stage trusted audit scripts outside the agent workspace")
    assert "publish-draft-advisory.sh" in stage
    assert "RUNNER_TEMP" in stage


def test_full_mode_never_checks_out_a_caller_named_head() -> None:
    # Full mode has no restore from a base: a Caller-named head would supply
    # its own prompt, instructions, and hook, and scan_command would run on it.
    data = read(WORKFLOW)
    gate = _step(data, "Gate")
    assert 'elif [ -n "$HEAD_SHA" ] || [ -n "$BASE_SHA" ]; then' in gate
    checkout = _step(data, "Checkout")
    assert "ref: ${{ inputs.mode == 'pr' && inputs.head_sha || github.sha }}" in checkout
    assert "inputs.head_sha != ''" not in data
    assert "inputs.mode == 'full'" in _step(data, "Optional consumer scanner command")
    assert "inputs.mode == 'pr'" in _step(data, "Restore trusted audit runtime from PR base")


def test_email_notifier_verifies_the_smtp_server_before_login() -> None:
    # starttls() without a context falls back to the stdlib's unverified
    # context, so the SMTP password would go to an unauthenticated server.
    notifier = read(NOTIFIER)
    assert "tls = ssl.create_default_context()" in notifier
    assert "smtp.starttls(context=tls)" in notifier
    assert "smtp.starttls()" not in notifier
    assert "_create_unverified_context" not in notifier
    assert "CERT_NONE" not in notifier
    assert "check_hostname = False" not in notifier


def test_credentialed_scripts_run_python_isolated_outside_the_workspace() -> None:
    # A stdin script puts the current directory first on sys.path, and these
    # scripts run in the audited workspace with secrets in the environment.
    for script in sorted((ROOT / ".github").glob("*/*.sh")):
        data = read(script)
        for line in data.splitlines():
            if re.match(r"\s*python3?", line):
                assert re.match(r"\s*python3? -I", line), f"{script.name}: {line.strip()}"
    notifier = read(NOTIFIER)
    assert notifier.index('cd "${RUNNER_TEMP:-/tmp}"') < notifier.index("python3 -I -")


def test_caller_example_invokes_reusable_job() -> None:
    example = read(CALLER_EXAMPLE)
    assert "uses: mnaimfaizy/agent-kit/.github/workflows/security-audit-reusable.yml@v" in example
    assert "threat_model_path:" in example
    assert "findings_ledger_path:" in example


if __name__ == "__main__":
    test_reusable_job_surface()
    test_public_log_rule_no_artifact_upload()
    test_private_delivery_sink_present()
    test_counts_only_comment()
    test_private_org_docs_use_same_job()
    test_caller_contract_ownership_documented()
    test_caller_example_invokes_reusable_job()
    test_audit_agent_cannot_see_the_advisory_token_or_widen_tools()
    test_audit_restores_runtime_and_stages_scripts_from_a_trusted_commit()
    print("security-audit contract seam tests passed")
