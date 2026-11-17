"""Contract test: every finding of the kit's reviewer is a thread (ADR 0011).

docs/adr/0011-every-review-finding-is-a-thread.md. The review job of
agent-review-reusable.yml:

- lists the reviewer's open threads, with their latest Verdict, before the
  reviewer runs, from a read-only copy of the trusted thread script;
- briefs the reviewer to post every finding as an inline thread, with
  `confirmed: true`, and to write the tracking comment as the Review report,
  an index of thread links under the three axes;
- after the reviewer, fails the job (so the Handoff does not start) when a
  report entry links no thread the reviewer started on this pull request;
- then posts the reviewer's replies on threads whose Verdict it disputes.

The script's own logic is covered by review-threads-contract.test.mjs; this
file pins the wiring, and runs the report step's real script on fixture API
data.
"""

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
REVIEW = ROOT / ".github" / "workflows" / "agent-review-reusable.yml"
SCRIPT = ROOT / ".github" / "agent-runtime" / "review-threads.mjs"
LIST_STEP = "List the reviewer's open threads"
BRIEF_STEP = "Build review brief"
AGENT_STEP = "Run code review (Claude Code)"
REPORT_STEP = "Fail if the review report was not posted"
REPLIES_STEP = "Post the reviewer's replies"


def workflow() -> dict:
    data = yaml.safe_load(REVIEW.read_text(encoding="utf-8"))
    data["on"] = data.pop(True)
    return data


def review_steps() -> list[dict]:
    return workflow()["jobs"]["review"]["steps"]


def step(name: str) -> dict:
    found = [s for s in review_steps() if s.get("name") == name]
    assert len(found) == 1, f"expected one step named {name!r}"
    return found[0]


def index(name: str) -> int:
    return review_steps().index(step(name))


def flat(text: str) -> str:
    return " ".join(text.split())


def test_open_threads_are_listed_from_a_staged_copy_before_the_brief() -> None:
    listing = step(LIST_STEP)
    assert index("Restore trusted review runtime from PR base") < index(LIST_STEP) < index(BRIEF_STEP)
    run = listing["run"]
    assert 'cp "$SRC" "$STAGED/review-threads.mjs"' in run
    assert 'chmod 444 "$STAGED/review-threads.mjs"' in run
    assert 'node "$STAGED/review-threads.mjs" open-threads --pr "$PR" > "$STAGED/open-threads.md"' in run
    assert listing["env"]["GH_TOKEN"] == "${{ github.token }}"
    # The brief requires the list, and carries it.
    brief = step(BRIEF_STEP)
    assert brief["env"]["OPEN_THREADS"] == "${{ runner.temp }}/review-threads/open-threads.md"
    assert 'if [ ! -s "$OPEN_THREADS" ]; then' in brief["run"]
    assert 'cat "$OPEN_THREADS"' in brief["run"]


def test_the_brief_makes_every_finding_a_thread() -> None:
    brief = flat(step(BRIEF_STEP)["run"])
    for needle in [
        "Every finding is an inline review thread",
        "all three axes, nits included",
        "A finding never goes in a top-level comment",
        "mcp__github_inline_comment__create_inline_comment, passing confirmed: true on every call",
        "Anchor a finding on the changed line that causes it.",
        "make the first sentence name the real location",
        "anchor it on the first changed line of the most relevant changed file",
    ]:
        assert needle in brief, f"the brief must say {needle!r}"
    assert "where a specific line is at fault" not in brief


def test_the_brief_describes_the_review_report_as_an_index() -> None:
    brief = flat(step(BRIEF_STEP)["run"])
    for needle in [
        "Your tracking comment is the Review report: an index of the threads, holding no finding of its own.",
        "Under each of ## Standards, ## Spec and ## Correctness, write one top-level list item per thread",
        "- [path:line](<the thread's html_url>) — one-line summary",
        "An axis with no findings says so in a sentence, not a list item.",
        "What you checked or confirmed, and anything else that is not a thread, "
        "goes in prose under those headings, never as a list item",
        "do not rerank across them",
    ]:
        assert needle in brief, f"the brief must say {needle!r}"


def test_the_brief_sets_the_re_review_rules() -> None:
    brief = flat(step(BRIEF_STEP)["run"])
    for needle in [
        "Never post a new thread for a finding one of them already holds, resolved or not.",
        "verdict null has not been answered yet: leave it alone, with no reply.",
        "A thread whose verdict you agree with: stay silent.",
        "A thread whose verdict you disagree with: say why in the report's Replies section",
        "A thread with resolved true is settled: ignore it.",
        "## Replies",
    ]:
        assert needle in brief, f"the brief must say {needle!r}"


def test_the_brief_keeps_fixed_threads_out_of_the_report_lists() -> None:
    # Run 44169512125 (PR #276): a re-review found its seven unanswered
    # threads fixed and listed each one as an unlinked list item, so the
    # report check failed the job. A fixed thread is said in prose.
    brief = flat(step(BRIEF_STEP)["run"])
    for needle in [
        "List it in the report if the head still has its finding.",
        "If the head fixed it, leave it out of the lists: say so in one sentence of prose, "
        "never as a list item per fixed thread.",
    ]:
        assert needle in brief, f"the brief must say {needle!r}"


def test_the_reviewer_gains_no_tool() -> None:
    # Replies are posted by the trusted step, so the grant is unchanged: no
    # `gh api`, no comment command.
    args = step(AGENT_STEP)["with"]["claude_args"]
    allowed = args.split('--allowedTools "', 1)[1].split('"', 1)[0].split(",")
    assert set(allowed) == {
        "Read",
        "Glob",
        "Grep",
        "Task",
        "Agent",
        "Bash(gh pr diff:*)",
        "Bash(gh pr view:*)",
        "mcp__github_inline_comment__create_inline_comment",
    }


def test_the_report_check_fails_the_job_before_the_handoff() -> None:
    report = step(REPORT_STEP)
    run = report["run"]
    check = 'node "$STAGED/review-threads.mjs" check-report --pr "$PR" --report "$STAGED/review-report.md"'
    assert check in run
    assert run.index("for heading in") < run.index(check), "the existing checks stay, first"
    assert f"{check} ||" not in run
    assert report["env"]["SCRIPT_SHA256"] == "${{ steps.threads.outputs.script_sha256 }}"
    handoff = workflow()["jobs"]["handoff"]
    assert handoff["needs"] == "review"
    assert "needs.review.result == 'success'" in handoff["if"]


def test_replies_are_posted_after_a_passing_check_only() -> None:
    replies = step(REPLIES_STEP)
    assert index(REPORT_STEP) < index(REPLIES_STEP)
    assert "always()" not in replies["if"]
    assert (
        'node "$STAGED/review-threads.mjs" post-replies --pr "$PR" --report "$STAGED/review-report.md"'
        in replies["run"]
    )


def test_the_script_is_a_kit_owned_runtime_file() -> None:
    owned = (ROOT / "kit-owned-paths.txt").read_text(encoding="utf-8").splitlines()
    assert ".github/agent-runtime/" in owned
    assert "review-threads.mjs" in (ROOT / "docs" / "adopt.md").read_text(encoding="utf-8")


# Behavior seam: run the report step's real script on fixture API data.

FAKE_GH = """#!/usr/bin/env bash
path=""; expr=""; slurp=0
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) expr="$2"; shift 2 ;;
    --slurp) slurp=1; shift ;;
    repos/*) path="$1"; shift ;;
    *) shift ;;
  esac
done
case "$path" in
  */issues/*/comments) file="$FIXTURES/issue-comments.json" ;;
  */pulls/*/comments) file="$FIXTURES/review-comments.json" ;;
  *) echo "unexpected gh call: $path" >&2; exit 1 ;;
esac
if [ -n "$expr" ]; then jq -r "$expr" "$file"
elif [ "$slurp" = 1 ]; then jq -s . "$file"
else cat "$file"; fi
"""

RUN_ID = "4242"
PR = "7"
THREAD = "https://github.com/o/r/pull/7#discussion_r"


def bash() -> str:
    # The bash on PATH. Not a bare "bash": on Windows, subprocess finds
    # System32's (WSL) before Git bash.
    path = shutil.which("bash")
    assert path, "bash is required to run step scripts"
    return path


def run_bash(script: str, **kwargs) -> subprocess.CompletedProcess:
    # From a file, not `bash -c`: Git-for-Windows bash cuts a `-c` argument
    # near 8,190 characters.
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "step.sh"
        path.write_text(script, encoding="utf-8", newline="\n")
        return subprocess.run([bash(), path.as_posix()], **kwargs)


def tracking_comment(standards: str) -> dict:
    body = "\n".join(
        [
            f"**Claude finished** —— [View job](https://github.com/o/r/actions/runs/{RUN_ID})",
            "## Standards",
            standards,
            "## Spec",
            "No findings.",
            "## Correctness",
            "No findings.",
        ]
    )
    return {"user": {"login": "github-actions[bot]"}, "body": body}


def run_report_step(standards: str) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        fixtures = tmp_path / "fixtures"
        fixtures.mkdir()
        (fixtures / "issue-comments.json").write_text(json.dumps([tracking_comment(standards)]), encoding="utf-8")
        (fixtures / "review-comments.json").write_text(
            json.dumps(
                [
                    {"id": 11, "user": {"login": "github-actions[bot]"}},
                    {"id": 12, "user": {"login": "mallory"}},
                ]
            ),
            encoding="utf-8",
        )
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        gh = bin_dir / "gh"
        gh.write_text(FAKE_GH, encoding="utf-8")
        gh.chmod(0o755)
        staged = tmp_path / "runner" / "review-threads"
        staged.mkdir(parents=True)
        shutil.copy(SCRIPT, staged / "review-threads.mjs")
        env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "FIXTURES": str(fixtures),
            # Forward slashes: GNU sha256sum escapes a name with a backslash
            # (a Windows path), which breaks the step's hash check.
            "RUNNER_TEMP": (tmp_path / "runner").as_posix(),
            "GITHUB_RUN_ID": RUN_ID,
            "GITHUB_REPOSITORY": "o/r",
            "GITHUB_SERVER_URL": "https://github.com",
            "GH_TOKEN": "unused",
            "PR": PR,
            "SCRIPT_SHA256": hashlib.sha256(SCRIPT.read_bytes()).hexdigest(),
        }
        return run_bash(step(REPORT_STEP)["run"], env=env, capture_output=True, text=True, check=False)


def test_the_report_step_passes_when_every_entry_links_its_thread() -> None:
    result = run_report_step(f"- [src/a.ts:1]({THREAD}11) — drift")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "1 entries, each linking its thread" in result.stdout


def test_the_report_step_passes_a_report_with_no_entries() -> None:
    result = run_report_step("No findings.")
    assert result.returncode == 0, result.stdout + result.stderr


def test_the_report_step_fails_naming_an_entry_without_a_thread() -> None:
    result = run_report_step(
        f"- [src/a.ts:1]({THREAD}11) — drift\n- The README is stale.\n- [src/b.ts:2]({THREAD}12) — theirs"
    )
    assert result.returncode != 0
    assert '"The README is stale." links no review thread' in result.stdout
    assert "links a comment by another author (mallory)" in result.stdout
    assert "drift" not in result.stdout.split("::error", 1)[1].split("\n")[0]


def test_a_re_review_with_its_earlier_findings_fixed_passes() -> None:
    # The shape the brief asks for once earlier threads are fixed: the new
    # finding is an entry, the fixed threads are one sentence of prose.
    result = run_report_step(
        f"- [src/a.ts:1]({THREAD}11) — new drift\n\n"
        "I checked the two earlier threads against the head: both are fixed, so neither is listed."
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "1 entries, each linking its thread" in result.stdout


def test_a_re_review_listing_its_fixed_findings_unlinked_fails() -> None:
    # Run 44169512125: each fixed finding as a list item with no thread link.
    result = run_report_step(
        f"- [src/a.ts:1]({THREAD}11) — new drift\n\n"
        "I checked the earlier threads against the head:\n"
        "- The id is now the next unused suffix."
    )
    assert result.returncode != 0
    assert '"The id is now the next unused suffix." links no review thread' in result.stdout


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("ok")
