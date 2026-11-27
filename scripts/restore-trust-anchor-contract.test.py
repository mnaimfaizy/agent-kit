"""Review and PR-mode audit restore their runtime from a commit on the trusted branch.

Whoever opens a pull request picks its base. A pull request into a branch that
holds unreviewed runtime changes must not be judged by that runtime, so both
restore steps use the PR base only when it is on the trusted branch, and the
trusted branch's tip otherwise. These tests run the real step scripts in a
throwaway repository.
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
REVIEW = ROOT / ".github" / "workflows" / "agent-review-reusable.yml"
AUDIT = ROOT / ".github" / "workflows" / "security-audit-reusable.yml"
REVIEW_STEP = "Restore trusted review runtime from PR base"
AUDIT_STEP = "Restore trusted audit runtime from PR base"
HOOK = ".github/agent-runtime/confine-reads-to-workspace.mjs"


def step(workflow: Path, name: str) -> dict:
    data = yaml.safe_load(workflow.read_text(encoding="utf-8"))
    for job in data["jobs"].values():
        for candidate in job.get("steps", []):
            if candidate.get("name") == name:
                return candidate
    raise AssertionError(f"missing step {name}")


def bash() -> str:
    # Not a bare "bash": on Windows, subprocess finds System32's (WSL) first.
    path = shutil.which("bash")
    assert path, "bash is required to run step scripts"
    return path


GIT_ENV = {
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.invalid",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
}


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=repo, env={**os.environ, **GIT_ENV}, capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def commit(repo: Path, files: dict[str, str], message: str) -> str:
    for path, text in files.items():
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def runtime(text: str) -> dict[str, str]:
    return {
        "AGENTS.md": f"{text}\n",
        HOOK: f"// {text}\n",
        ".claude/skills/code-review/SKILL.md": f"{text}\n",
        ".claude/skills/security-audit/SKILL.md": f"{text}\n",
        ".github/security-audit/prompt.md": f"{text}\n",
        "security/threat-model.md": f"{text}\n",
        "security/findings-ledger.md": f"{text}\n",
    }


def repository(tmp: Path) -> tuple[Path, dict[str, str]]:
    """main: A (trusted) -> A2 (trusted, newer). side: A -> B (unreviewed runtime)."""
    repo = tmp / "repo"
    repo.mkdir(parents=True)
    git(repo, "init", "-q", "-b", "main")
    shas = {"A": commit(repo, {**runtime("trusted"), "src.txt": "1\n"}, "A")}
    shas["A2"] = commit(repo, runtime("trusted-newer"), "A2")
    git(repo, "update-ref", "refs/remotes/origin/main", shas["A2"])
    git(repo, "checkout", "-q", "-b", "side", shas["A"])
    shas["B"] = commit(repo, runtime("unreviewed"), "B")
    git(repo, "update-ref", "refs/remotes/origin/side", shas["B"])
    return repo, shas


def pr_head(repo: Path, base: str, name: str) -> None:
    """A PR head on `base` that also rewrites the runtime, as any PR may."""
    git(repo, "checkout", "-q", "--detach", base)
    commit(repo, {**runtime(f"pr-{name}"), "src.txt": f"{name}\n"}, f"head {name}")


def run_restore(workflow: Path, name: str, repo: Path, base_sha: str, base_ref: str, trusted: str):
    out = repo.parent / "github_output"
    out.write_text("", encoding="utf-8")
    env = {
        **os.environ,
        **GIT_ENV,
        "BASE_SHA": base_sha,
        "BASE_BRANCH": base_ref,
        "TRUSTED_BRANCH": trusted,
        "SKILL_PATH": ".claude/skills/code-review",
        "SKILL_DIR": ".claude/skills/security-audit",
        "AUDIT_PROMPT_PATH": ".github/security-audit/prompt.md",
        "THREAT_MODEL_PATH": "security/threat-model.md",
        "FINDINGS_LEDGER_PATH": "security/findings-ledger.md",
        "GITHUB_OUTPUT": str(out),
    }
    with tempfile.TemporaryDirectory() as scripts:
        script = Path(scripts) / "step.sh"
        script.write_text(step(workflow, name)["run"], encoding="utf-8", newline="\n")
        result = subprocess.run(
            [bash(), script.as_posix()], cwd=repo, env=env, capture_output=True, text=True, check=False
        )
    return result, out.read_text(encoding="utf-8")


CASES = ((REVIEW, REVIEW_STEP), (AUDIT, AUDIT_STEP))


def text(repo: Path, path: str) -> str:
    return (repo / path).read_text(encoding="utf-8")


def test_a_base_off_the_trusted_branch_restores_from_its_tip(tmp_path: Path) -> None:
    for at, (workflow, name) in enumerate(CASES):
        repo, shas = repository(tmp_path / str(at))
        pr_head(repo, shas["B"], "stacked")
        result, outputs = run_restore(workflow, name, repo, shas["B"], "side", "main")
        assert result.returncode == 0, result.stdout + result.stderr
        assert f"is not on main; restoring the runtime from main at {shas['A2']}" in result.stdout
        assert text(repo, "AGENTS.md") == "trusted-newer\n", name
        assert text(repo, HOOK) == "// trusted-newer\n", name
        assert text(repo, "src.txt") == "stacked\n", f"{name}: the PR's own files stay"
        if workflow == AUDIT:
            assert f"runtime_sha={shas['A2']}" in outputs
            assert text(repo, ".github/security-audit/prompt.md") == "trusted-newer\n"


def test_a_base_on_the_trusted_branch_restores_from_the_base(tmp_path: Path) -> None:
    for at, (workflow, name) in enumerate(CASES):
        repo, shas = repository(tmp_path / str(at))
        pr_head(repo, shas["A"], "direct")
        result, outputs = run_restore(workflow, name, repo, shas["A"], "main", "main")
        assert result.returncode == 0, result.stdout + result.stderr
        assert "is not on main" not in result.stdout
        assert text(repo, "AGENTS.md") == "trusted\n", name
        assert text(repo, HOOK) == "// trusted\n", name
        if workflow == AUDIT:
            assert f"runtime_sha={shas['A']}" in outputs


def test_the_trusted_branch_is_the_one_the_caller_names(tmp_path: Path) -> None:
    # With `side` named trusted, its unreviewed-looking tip is what the Caller chose.
    for at, (workflow, name) in enumerate(CASES):
        repo, shas = repository(tmp_path / str(at))
        pr_head(repo, shas["B"], "named")
        result, _ = run_restore(workflow, name, repo, shas["B"], "side", "side")
        assert result.returncode == 0, result.stdout + result.stderr
        assert text(repo, "AGENTS.md") == "unreviewed\n", name


def test_no_trusted_branch_fails_closed(tmp_path: Path) -> None:
    for at, (workflow, name) in enumerate(CASES):
        repo, shas = repository(tmp_path / str(at))
        pr_head(repo, shas["B"], "none")
        for trusted in ("", "-bad..name"):
            result, _ = run_restore(workflow, name, repo, shas["B"], "side", trusted)
            assert result.returncode != 0, (name, trusted)
            assert text(repo, "AGENTS.md") == "pr-none\n", f"{name}: nothing restored before refusing"


def test_both_workflows_take_the_trusted_branch_input() -> None:
    for workflow, name in CASES:
        data = yaml.safe_load(workflow.read_text(encoding="utf-8"))
        inputs = data[True]["workflow_call"]["inputs"] if True in data else data["on"]["workflow_call"]["inputs"]
        assert inputs["trusted_branch"]["required"] is False
        assert inputs["trusted_branch"]["default"] == ""
        env = step(workflow, name)["env"]
        assert env["TRUSTED_BRANCH"] == "${{ inputs.trusted_branch || github.event.repository.default_branch }}"


if __name__ == "__main__":
    test_a_base_off_the_trusted_branch_restores_from_its_tip(Path(tempfile.mkdtemp()))
    test_a_base_on_the_trusted_branch_restores_from_the_base(Path(tempfile.mkdtemp()))
    test_the_trusted_branch_is_the_one_the_caller_names(Path(tempfile.mkdtemp()))
    test_no_trusted_branch_fails_closed(Path(tempfile.mkdtemp()))
    test_both_workflows_take_the_trusted_branch_input()
    print("restore trust anchor contract tests passed")
