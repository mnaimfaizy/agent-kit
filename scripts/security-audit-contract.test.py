import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import yaml

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
    assert (
        '--disallowedTools "Read(./.git/**),Edit(./.github/agent-runtime/**),Edit(./.claude/**),Edit(./.mcp.json),Bash"'
        in agent
    )
    # Claude Code auto-approves read-only Bash commands that are not on the
    # allowlist; only a deny keeps the auditor off Bash entirely.
    denied = agent.split('--disallowedTools "')[1].split('"')[0].split(",")
    assert "Bash" in denied
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


def test_pr_diff_in_the_brief_ignores_pr_attributes() -> None:
    # A PR's .gitattributes must not blank a hunk as binary or run a textconv.
    data = read(WORKFLOW)
    assert 'git diff --text --no-ext-diff --no-textconv --unified=3 "$BASE_SHA"...HEAD' in data
    assert 'git diff --unified=3 "$BASE_SHA"...HEAD' not in data


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


def test_gate_proves_advisory_write_access_without_repository_state() -> None:
    # A draft count depends on the repository having a draft; the write probe
    # does not. GitHub checks authorization before it validates the body, so an
    # empty body answers 422 to a token that may create advisories and 403/404
    # to one that may not, and can never create one.
    gate = _step(read(WORKFLOW), "Gate")
    assert "state=draft" not in gate
    assert "gh api user --silent" in gate
    assert gate.index("gh api user --silent") < gate.index("--method POST")
    assert "printf '{}' | GH_TOKEN=\"$ADVISORY_TOKEN\" gh api" in gate
    assert '"repos/${GITHUB_REPOSITORY}/security-advisories"' in gate
    assert '[ "$STATUS" = "422" ]' in gate


def test_publish_retries_then_falls_back_to_emailing_the_report() -> None:
    publish = read(PUBLISH)
    assert "for attempt in 1 2 3; do" in publish
    assert "Publish failed after 3 attempts" in publish

    data = read(WORKFLOW)
    fallback = _step(data, "Email report after failed publish")
    assert "failure() && steps.publish.outcome == 'failure' && inputs.notify_email" in fallback
    assert '"$SCRIPT" "$REPORT_PATH" publish-failed' in fallback
    assert "continue-on-error" not in fallback
    # Only the fallback sends the report; the routine notice stays counts-only.
    routine = _step(data, "Optional email notification")
    assert "publish-failed" not in routine

    notifier = read(NOTIFIER)
    assert 'if [[ "${MODE}" == "publish-failed" ]]; then' in notifier
    assert "[publish failed]" in notifier
    assert "Full details are available in the private draft GHSA." in notifier


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
    checked = 0
    for script in sorted((ROOT / ".github").glob("*/*.sh")):
        data = read(script)
        for line in data.splitlines():
            if re.match(r"\s*python3?\b", line):
                checked += 1
                assert re.match(r"\s*python3? -I\b", line), f"{script.name}: {line.strip()}"
    # Guard against the loop silently matching nothing (it once did).
    assert checked, "no python invocation found in .github/*/*.sh; the isolation check ran on nothing"
    notifier = read(NOTIFIER)
    assert notifier.index('cd "${RUNNER_TEMP:-/tmp}"') < notifier.index("python3 -I -")


def test_caller_example_invokes_reusable_job() -> None:
    example = read(CALLER_EXAMPLE)
    assert "uses: mnaimfaizy/agent-kit/.github/workflows/security-audit-reusable.yml@v" in example
    assert "threat_model_path:" in example
    assert "findings_ledger_path:" in example


def test_nothing_creates_the_report_before_the_agent() -> None:
    # Claude Code's Write refuses to overwrite a file the session has not Read,
    # so a pre-created empty report can end a "successful" run with no report.
    data = read(WORKFLOW)
    before_agent = data[: data.index("- name: Run security audit (Claude Code)")]
    assert not re.search(r':\s*>\s*"\$REPORT_PATH"', before_agent)
    assert not re.search(r"(touch|truncate)[^\n]*\$REPORT_PATH", before_agent)
    assert 'mkdir -p "$(dirname "$REPORT_PATH")"' in audit_step("Build audit brief")["run"]


# Behavior seams: run a step's real script, or a staged delivery script, with
# fake inputs, and check what reaches stdout (the public log) and what does not.

SECRET = "TRANSCRIPT-SECRET-7f3a"


def audit_step(name: str) -> dict:
    data = yaml.safe_load(read(WORKFLOW))
    return next(s for s in data["jobs"]["security_audit"]["steps"] if s.get("name") == name)


def bash() -> str:
    path = shutil.which("bash")
    assert path, "bash is required to run step scripts"
    return path


def execution_file(tmp_path: Path, final: str) -> Path:
    path = tmp_path / "execution.json"
    messages = [
        {"type": "assistant", "message": {"content": [{"type": "text", "text": SECRET}]}},
        {"type": "result", "subtype": "success", "is_error": False, "result": final},
    ]
    path.write_text(json.dumps(messages), encoding="utf-8")
    return path


def run_collect(tmp_path: Path, report: str | None, execution: Path | None) -> tuple[subprocess.CompletedProcess, str]:
    report_path = tmp_path / ".tmp" / "security-audit-report.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    if report is None:
        # Callers may reuse tmp_path: never inherit a report from an earlier run.
        report_path.unlink(missing_ok=True)
    else:
        report_path.write_text(report, encoding="utf-8")
    github_output = tmp_path / "github_output"
    github_output.touch()
    env = {
        **os.environ,
        "REPORT_PATH": str(report_path),
        "EXECUTION_FILE": str(execution) if execution else "",
        "GITHUB_ENV": str(tmp_path / "github_env"),
        "GITHUB_OUTPUT": str(github_output),
    }
    result = subprocess.run(
        [bash(), "-c", audit_step("Collect transcript")["run"]],
        env=env,
        capture_output=True,
        text=True,
        check=False,
        cwd=tmp_path,
    )
    return result, github_output.read_text(encoding="utf-8")


REPORT = "- **Mode:** full\n- **Finding count:** 0\n\nNo findings.\n"


def test_collect_fails_an_empty_report_and_flags_it_for_private_delivery(tmp_path: Path) -> None:
    result, outputs = run_collect(tmp_path, None, execution_file(tmp_path, "audit complete: 0 findings"))
    assert result.returncode != 0
    assert "Empty report" in result.stdout
    assert "empty_report=true" in outputs
    assert SECRET not in result.stdout + result.stderr


def test_collect_does_not_flag_a_report_that_has_content(tmp_path: Path) -> None:
    result, outputs = run_collect(tmp_path, REPORT, execution_file(tmp_path, "audit complete: 0 findings"))
    assert result.returncode == 0, result.stdout + result.stderr
    assert "empty_report=true" not in outputs


def test_collect_logs_a_matching_final_line_with_its_count(tmp_path: Path) -> None:
    for report in (REPORT, None):
        result, _ = run_collect(tmp_path, report, execution_file(tmp_path, "audit complete: 3 findings"))
        assert "Final line: matched (3 findings)" in result.stdout
        if report is None:
            # Logged before the empty-report exit, not only on success.
            assert "Empty report" in result.stdout
            assert result.returncode != 0


def test_collect_never_logs_a_final_line_outside_the_closed_pattern(tmp_path: Path) -> None:
    for final in (
        f"audit complete: 3 findings {SECRET}",
        f"audit complete: 3 findings\n{SECRET}",
        SECRET,
        "",
    ):
        result, _ = run_collect(tmp_path, None, execution_file(tmp_path, final))
        assert "Final line: (unrecognized)" in result.stdout or "Final line: (absent)" in result.stdout
        assert SECRET not in result.stdout + result.stderr


def test_collect_reports_an_absent_final_line_without_an_execution_file(tmp_path: Path) -> None:
    result, _ = run_collect(tmp_path, None, None)
    assert "Final line: (absent)" in result.stdout


def fake_gh(tmp_path: Path) -> tuple[dict, Path]:
    """A `gh` on PATH that records the advisory request instead of sending it."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    captured = tmp_path / "gh-request.json"
    gh = bin_dir / "gh"
    gh.write_text(
        "#!/usr/bin/env bash\n"
        f'cat > "{captured.as_posix()}"\n'
        """printf '{"ghsa_id":"GHSA-test-test-test"}'\n""",
        encoding="utf-8",
    )
    gh.chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "GITHUB_REPOSITORY": "owner/repo",
        "SECURITY_AUDIT_RUN_URL": "https://github.com/owner/repo/actions/runs/1",
        "RUNNER_TEMP": str(tmp_path),
        "GITHUB_OUTPUT": str(tmp_path / "publish_output"),
    }
    return env, captured


def test_publisher_files_a_failed_run_advisory_with_the_transcript(tmp_path: Path) -> None:
    env, captured = fake_gh(tmp_path)
    session = tmp_path / "security-audit-session.md"
    session.write_text(f"transcript {SECRET}", encoding="utf-8")
    missing_report = tmp_path / "security-audit-report.md"
    result = subprocess.run(
        [bash(), str(PUBLISH), str(missing_report), "", str(session), "empty-report"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    request = json.loads(captured.read_text(encoding="utf-8"))
    assert "failed run" in request["summary"].lower()
    assert "empty report" in request["summary"].lower()
    assert "finding" not in request["summary"].lower()
    assert SECRET in request["description"]
    assert "https://github.com/owner/repo/actions/runs/1" in request["description"]
    assert SECRET not in result.stdout + result.stderr


def test_publisher_still_requires_a_report_outside_the_failed_run_mode(tmp_path: Path) -> None:
    env, captured = fake_gh(tmp_path)
    result = subprocess.run(
        [bash(), str(PUBLISH), str(tmp_path / "missing.md")],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert not captured.exists()


def run_notifier(tmp_path: Path, *args: str) -> tuple[subprocess.CompletedProcess, Path]:
    """Run notify-email.sh with a `python3` on PATH that records the message."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    message = tmp_path / "message.txt"
    python = bin_dir / "python3"
    python.write_text(
        "#!/usr/bin/env bash\n"
        "cat > /dev/null\n"
        # The body must arrive as a file: an environment string over 128 KiB
        # makes execve fail on Linux, and the transcript is often that large.
        f'printf "%s\\n---\\n" "$SUBJECT" > "{message.as_posix()}"\n'
        f'cat "$BODY_FILE" >> "{message.as_posix()}"\n'
        f'printf "%s" "${{BODY:-}}" > "{(tmp_path / "body-env.txt").as_posix()}"\n',
        encoding="utf-8",
    )
    python.chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "NOTIFY_EMAIL_TO": "maintainer@example.com",
        "NOTIFY_EMAIL_FROM": "audit@example.com",
        "RUNNER_TEMP": str(tmp_path),
    }
    result = subprocess.run([bash(), str(NOTIFIER), *args], env=env, capture_output=True, text=True, check=False)
    return result, message


def test_notifier_emails_the_transcript_after_an_empty_report(tmp_path: Path) -> None:
    session = tmp_path / "security-audit-session.md"
    session.write_text(f"transcript {SECRET}", encoding="utf-8")
    result, message = run_notifier(tmp_path, str(session), "empty-report")
    assert result.returncode == 0, result.stdout + result.stderr
    subject, body = message.read_text(encoding="utf-8").split("\n---\n", 1)
    assert "empty report" in subject.lower()
    assert "finding" not in subject.lower()
    assert SECRET in body
    assert SECRET not in result.stdout + result.stderr


def test_notifier_routine_notice_stays_counts_only(tmp_path: Path) -> None:
    report = tmp_path / "security-audit-report.md"
    report.write_text(f"- **Finding count:** 2\n\n{SECRET}\n", encoding="utf-8")
    result, message = run_notifier(tmp_path, str(report))
    assert result.returncode == 0, result.stdout + result.stderr
    subject, body = message.read_text(encoding="utf-8").split("\n---\n", 1)
    assert "(2 findings)" in subject
    assert SECRET not in body


EMPTY = "steps.collect.outputs.empty_report == 'true'"


def test_an_empty_report_files_a_failed_run_draft_through_the_staged_publisher() -> None:
    data = read(WORKFLOW)
    assert data.index("- name: Collect transcript") < data.index("- name: Publish failed-run draft after empty report")
    step = audit_step("Publish failed-run draft after empty report")
    assert step["if"] == f"${{{{ failure() && {EMPTY} }}}}"
    assert step["env"]["GH_TOKEN"] == "${{ secrets.advisories_token }}"
    assert step["env"]["GH_CONFIG_DIR"] == "${{ runner.temp }}/gh-empty-config"
    assert step["env"]["SCRIPT_SHA256"] == "${{ steps.stage.outputs.publisher_sha256 }}"
    run = step["run"]
    assert 'SCRIPT="$STAGED_DIR/publish-draft-advisory.sh"' in run
    call = '"$SCRIPT" "$REPORT_PATH" "$cli_log" "$session" empty-report'
    assert call in run
    assert run.index("sha256sum -c") < run.index(call)


def test_an_empty_report_emails_the_transcript_only_when_email_is_on() -> None:
    step = audit_step("Email transcript after empty report")
    assert step["if"] == f"${{{{ failure() && {EMPTY} && inputs.notify_email }}}}"
    assert step["env"]["SCRIPT_SHA256"] == "${{ steps.stage.outputs.notifier_sha256 }}"
    run = step["run"]
    assert 'SCRIPT="$STAGED_DIR/notify-email.sh"' in run
    call = '"$SCRIPT" "$session" empty-report'
    assert call in run
    assert run.index("sha256sum -c") < run.index(call)


def test_no_step_prints_the_transcript_to_the_log() -> None:
    data = read(WORKFLOW)
    for name in ("session", "SESSION", "cli_log", "CLI_LOG"):
        assert f'cat "${name}"' not in data
        assert f'head -c 200000 "${name}"' not in data


def large_transcript(path: Path) -> Path:
    # Init first, the decisive last turns at the end, like an execution file.
    path.write_text("TRANSCRIPT-START " + "x" * 300_000 + f" {SECRET} TRANSCRIPT-END", encoding="utf-8")
    return path


def test_publisher_keeps_the_start_and_end_of_a_large_transcript(tmp_path: Path) -> None:
    env, captured = fake_gh(tmp_path)
    session = large_transcript(tmp_path / "security-audit-session.md")
    result = subprocess.run(
        [bash(), str(PUBLISH), str(tmp_path / "missing.md"), "", str(session), "empty-report"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    description = json.loads(captured.read_text(encoding="utf-8"))["description"]
    assert "TRANSCRIPT-START" in description
    assert "TRANSCRIPT-END" in description
    assert "bytes omitted" in description
    assert len(description.encode("utf-8")) <= 65000


def test_notifier_sends_a_large_transcript_through_a_private_file(tmp_path: Path) -> None:
    session = large_transcript(tmp_path / "security-audit-session.md")
    result, message = run_notifier(tmp_path, str(session), "empty-report")
    assert result.returncode == 0, result.stdout + result.stderr
    body = message.read_text(encoding="utf-8")
    assert "TRANSCRIPT-START" in body
    assert "TRANSCRIPT-END" in body
    assert "bytes omitted" in body
    assert (tmp_path / "body-env.txt").read_text(encoding="utf-8") == ""
    assert not list(tmp_path.glob("security-audit-email-body.*")), "body file left behind"


def test_notifier_says_when_an_empty_report_transcript_was_not_emailed(tmp_path: Path) -> None:
    # If the failed-run draft also failed, this email is the transcript's only
    # copy, so a skipped email must say so and fail the step.
    session = tmp_path / "security-audit-session.md"
    session.write_text(f"transcript {SECRET}", encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith("NOTIFY_EMAIL_")}
    env["RUNNER_TEMP"] = str(tmp_path)
    result = subprocess.run(
        [bash(), str(NOTIFIER), str(session), "empty-report"], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode != 0
    assert "session transcript was not delivered by email" in result.stdout
    assert SECRET not in result.stdout + result.stderr
    # The SMTP-host check inside Python must say the same. With a mailbox but no
    # host, the real python3 returns before it opens any SMTP connection.
    env.update(NOTIFY_EMAIL_TO="maintainer@example.com", NOTIFY_EMAIL_FROM="audit@example.com")
    result = subprocess.run(
        [bash(), str(NOTIFIER), str(session), "empty-report"], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode == 1, result.stdout + result.stderr
    assert "SMTP host is not configured" in result.stdout
    assert "session transcript was not delivered by email" in result.stdout
    assert SECRET not in result.stdout + result.stderr


if __name__ == "__main__":
    import tempfile

    test_reusable_job_surface()
    test_public_log_rule_no_artifact_upload()
    test_private_delivery_sink_present()
    test_counts_only_comment()
    test_private_org_docs_use_same_job()
    test_caller_contract_ownership_documented()
    test_audit_agent_cannot_see_the_advisory_token_or_widen_tools()
    test_audit_restores_runtime_and_stages_scripts_from_a_trusted_commit()
    test_pr_diff_in_the_brief_ignores_pr_attributes()
    test_full_mode_never_checks_out_a_caller_named_head()
    test_gate_proves_advisory_write_access_without_repository_state()
    test_publish_retries_then_falls_back_to_emailing_the_report()
    test_email_notifier_verifies_the_smtp_server_before_login()
    test_credentialed_scripts_run_python_isolated_outside_the_workspace()
    test_caller_example_invokes_reusable_job()
    test_nothing_creates_the_report_before_the_agent()
    test_collect_fails_an_empty_report_and_flags_it_for_private_delivery(Path(tempfile.mkdtemp()))
    test_collect_does_not_flag_a_report_that_has_content(Path(tempfile.mkdtemp()))
    test_collect_logs_a_matching_final_line_with_its_count(Path(tempfile.mkdtemp()))
    test_collect_never_logs_a_final_line_outside_the_closed_pattern(Path(tempfile.mkdtemp()))
    test_collect_reports_an_absent_final_line_without_an_execution_file(Path(tempfile.mkdtemp()))
    test_publisher_files_a_failed_run_advisory_with_the_transcript(Path(tempfile.mkdtemp()))
    test_publisher_still_requires_a_report_outside_the_failed_run_mode(Path(tempfile.mkdtemp()))
    test_notifier_emails_the_transcript_after_an_empty_report(Path(tempfile.mkdtemp()))
    test_notifier_routine_notice_stays_counts_only(Path(tempfile.mkdtemp()))
    test_an_empty_report_files_a_failed_run_draft_through_the_staged_publisher()
    test_an_empty_report_emails_the_transcript_only_when_email_is_on()
    test_no_step_prints_the_transcript_to_the_log()
    test_publisher_keeps_the_start_and_end_of_a_large_transcript(Path(tempfile.mkdtemp()))
    test_notifier_sends_a_large_transcript_through_a_private_file(Path(tempfile.mkdtemp()))
    test_notifier_says_when_an_empty_report_transcript_was_not_emailed(Path(tempfile.mkdtemp()))
    print("security-audit contract seam tests passed")
