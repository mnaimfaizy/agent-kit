"""Contract test: the two-step release tooling refuses what broke past cuts.

`scripts/release.py` (run as `prepare-release.sh` and `cut-release.sh`) is
exercised against throwaway git repositories with a bare `origin`, never the
real remote. `gh` is replaced by a fake, so no test reaches GitHub. Each cut
of the 1.0.0 line hit one of these:

- a stale local tag from an earlier `--apply` stopped a later `--apply --publish`;
- the tag carried a private tagger email, and GitHub refused the push (GH007);
- the dry run refused off `main`, where release prep happens.

The workflow half: `publish-cli.yml` creates the GitHub Release from
`release-notes/<tag>.md` before it publishes to npm.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
PUBLISH = ROOT / ".github" / "workflows" / "publish-cli.yml"
CI = ROOT / ".github" / "workflows" / "ci.yml"

_spec = importlib.util.spec_from_file_location("agent_kit_release", SCRIPTS / "release.py")
release = importlib.util.module_from_spec(_spec)
# dataclasses look the module up by name while it loads.
sys.modules[_spec.name] = release
_spec.loader.exec_module(release)

NOREPLY = "1+maintainer@users.noreply.github.com"
PRIVATE = "maintainer@example.com"
GIT_ENV_DROP = ("GIT_COMMITTER_EMAIL", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_AUTHOR_NAME", "EMAIL", "GIT_DIR")

SEED = {
    "cli/package.json": '{\n  "name": "x",\n  "version": "1.0.0-beta.1"\n}\n',
    "README.md": (
        "> **Status:** pre-release (`1.0.0-beta`). `v1.0.0-alpha.1` is **broken**; use v1.0.0-alpha.3.\n\n"
        "## Quickstart\n\n```bash\nnpx @mnaimfaizy/agent-kit init --tag v1.0.0-beta.1\n```\n"
    ),
    "examples/audit-caller.yml": "uses: o/agent-kit/.github/workflows/audit.yml@v1.0.0-beta.1\n",
    "docs/releases.md": (
        "Published as (`v1.0.0-beta.1` → `1.0.0-beta.1`).\n\n"
        "## Broken releases\n\n| `v1.0.0-beta.1` | Broken | why | `v1.0.0-beta.2` |\n\n"
        "## Other\n\nNot pins: v11.0.0-beta.1, v1.0.0-beta.10, 1.0.0-beta.1x.\n"
    ),
    "docs/adr/0001-x.md": "Decided at v1.0.0-beta.1.\n",
    "CHANGELOG.md": (
        "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A new thing.\n\n"
        "## [1.0.0-beta.1] - 2026-01-01\n\n- Shipped in v1.0.0-beta.1.\n"
    ),
    "release-notes/v1.0.0-beta.1.md": "Notes for v1.0.0-beta.1.\n",
    "scripts/release-snapshot-manifest.txt": "README.md\nCHANGELOG.md\ncli/package.json\n",
}


def g(*args: str, env: dict | None = None) -> str:
    done = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8", env=env, check=False)
    assert done.returncode == 0, f"git {' '.join(args)}: {done.stderr}"
    return done.stdout.strip()


def write(path: str, text: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding="utf-8", newline="")


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


class FakeGh:
    """Stands in for `gh`: green CI, no Release, no runs, unless a test says otherwise."""

    def __init__(self) -> None:
        self.installed = True
        self.signed_in = True
        self.checks = {name: ("completed", "success") for name in release.REQUIRED_CHECKS}
        self.release_url: str | None = None
        self.runs: list[dict] = []
        # Extra check runs as (name, status, conclusion, started_at), beside the green ones above.
        self.extra_checks: list[tuple[str, str, str, str]] = []
        self.open_pr: str | None = None
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess:
        if not self.installed:
            raise FileNotFoundError("gh")
        self.calls.append(args)

        def done(code: int, out: str = "", err: str = "") -> subprocess.CompletedProcess:
            return subprocess.CompletedProcess(["gh", *args], code, out, err)

        if args[:2] == ["api", "user"]:
            return done(0, "maintainer") if self.signed_in else done(1, err="not logged in")
        if args[0] == "api" and "check-runs" in args[1]:
            rows = [(n, s, c, "2026-11-14T10:00:00Z") for n, (s, c) in self.checks.items()] + self.extra_checks
            return done(0, "".join("\t".join(row) + "\n" for row in rows))
        if args[:2] == ["release", "view"]:
            return done(0, self.release_url) if self.release_url else done(1, err="release not found")
        if args[:2] == ["run", "list"]:
            return done(0, json.dumps(self.runs))
        if args[:2] == ["pr", "view"]:
            return done(0, self.open_pr) if self.open_pr else done(1, err="no pull requests found")
        if args[:2] == ["pr", "create"]:
            return done(0, "https://github.com/o/r/pull/1")
        raise AssertionError(f"unexpected gh call: {args}")


@contextlib.contextmanager
def sandbox() -> Iterator[FakeGh]:
    """A repo cloned from a bare `origin` holding tag v1.0.0-beta.1; cwd is the clone."""
    saved_env, saved_cwd = dict(os.environ), os.getcwd()
    saved_gh, saved_slug = release.run_gh, release.repo_slug
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        try:
            base = Path(tmp)
            config = base / "gitconfig"
            config.write_text(
                f"[user]\n\tname = Maintainer\n\temail = {NOREPLY}\n[init]\n\tdefaultBranch = main\n"
                "[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n",
                encoding="utf-8",
            )
            for name in GIT_ENV_DROP:
                os.environ.pop(name, None)
            os.environ["GIT_CONFIG_GLOBAL"] = str(config)
            os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
            g("init", "-q", "--bare", str(base / "origin.git"))
            seed = base / "seed"
            g("init", "-q", str(seed))
            os.chdir(seed)
            for path, text in SEED.items():
                write(path, text)
            g("add", "-A")
            g("commit", "-qm", "seed")
            g("tag", "-a", "v1.0.0-beta.1", "-m", "Release v1.0.0-beta.1")
            g("push", "-q", str(base / "origin.git"), "main", "v1.0.0-beta.1")
            os.chdir(base)
            g("clone", "-q", str(base / "origin.git"), "work")
            os.chdir(base / "work")
            fake = FakeGh()
            release.run_gh = fake
            release.repo_slug = lambda: "o/r"
            yield fake
        finally:
            os.chdir(saved_cwd)
            os.environ.clear()
            os.environ.update(saved_env)
            release.run_gh, release.repo_slug = saved_gh, saved_slug


def run(*argv: str) -> tuple[int, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = release.main(list(argv))
    return code, out.getvalue() + err.getvalue()


def origin_tag(tag: str) -> str:
    return g("ls-remote", "--tags", "origin", f"refs/tags/{tag}")


def ready_main(tag: str = "v1.0.0-beta.2") -> str:
    """Run prepare, fill in the notes, and merge the branch to main on origin, as the PR would."""
    code, out = run("prepare", "--tag", tag, "--date", "2026-11-14")
    assert code == 0, out
    write(f"release-notes/{tag}.md", f"Real notes for {tag}.\n")
    g("add", "-A")
    g("commit", "-qm", f"chore: prepare {tag}")
    g("switch", "-q", "main")
    g("merge", "-q", "--ff-only", f"chore/release-{tag}")
    g("push", "-q", "origin", "main")
    return g("rev-parse", "HEAD")


# --- prepare ----------------------------------------------------------------


def test_prepare_writes_the_release_prep_branch_and_pushes_nothing() -> None:
    with sandbox():
        before = {path: read(path) for path in ("release-notes/v1.0.0-beta.1.md", "docs/adr/0001-x.md")}
        code, out = run("prepare", "--tag", "v1.0.0-beta.2", "--date", "2026-11-14")
        assert code == 0, out
        assert g("branch", "--show-current") == "chore/release-v1.0.0-beta.2"
        # Every pin of the previous tag moves, found by search, not from a list of files.
        assert json.loads(read("cli/package.json"))["version"] == "1.0.0-beta.2"
        assert "--tag v1.0.0-beta.2" in read("README.md")
        assert "@v1.0.0-beta.2" in read("examples/audit-caller.yml")
        releases = read("docs/releases.md")
        assert releases.startswith("Published as (`v1.0.0-beta.2` → `1.0.0-beta.2`).")
        # History stays: broken-tag rows, other versions, ADRs and older notes.
        assert "| `v1.0.0-beta.1` | Broken |" in releases
        assert "v11.0.0-beta.1, v1.0.0-beta.10, 1.0.0-beta.1x" in releases
        assert "`v1.0.0-alpha.1` is **broken**; use v1.0.0-alpha.3" in read("README.md")
        assert {path: read(path) for path in before} == before
        # [Unreleased] moves into a dated section and is left empty.
        changelog = read("CHANGELOG.md")
        assert "## [Unreleased]\n\n## [1.0.0-beta.2] - 2026-11-14\n\n### Added\n\n- A new thing.\n\n" in changelog
        assert "## [1.0.0-beta.1] - 2026-01-01\n\n- Shipped in v1.0.0-beta.1.\n" in changelog
        # Notes come from the template, tag filled in, marked for the author.
        notes = read("release-notes/v1.0.0-beta.2.md")
        assert release.NOTES_MARKER in notes and "upgrade --tag v1.0.0-beta.2" in notes
        assert "{{" not in notes and "template-end" not in notes
        assert "Release snapshot check passed." in out
        # Nothing reached origin; the commands are printed instead.
        assert g("ls-remote", "--heads", "origin", "chore/release-v1.0.0-beta.2") == ""
        assert "git push --set-upstream origin chore/release-v1.0.0-beta.2" in out
        assert "gh pr create --base main" in out


def test_prepare_is_safe_to_re_run_and_never_overwrites_notes() -> None:
    with sandbox():
        assert run("prepare", "--tag", "v1.0.0-beta.2", "--date", "2026-11-14")[0] == 0
        write("release-notes/v1.0.0-beta.2.md", "Written by hand.\n")
        files = {path: read(path) for path in ("CHANGELOG.md", "README.md", "cli/package.json")}
        code, out = run("prepare", "--tag", "v1.0.0-beta.2", "--date", "2026-11-15")
        assert code == 0, out
        assert "re-running" in out and "exists already" in out
        assert {path: read(path) for path in files} == files
        assert read("release-notes/v1.0.0-beta.2.md") == "Written by hand.\n"


def test_prepare_commits_only_finished_notes_and_can_open_the_pr() -> None:
    with sandbox() as fake:
        assert run("prepare", "--tag", "v1.0.0-beta.2")[0] == 0
        code, out = run("prepare", "--tag", "v1.0.0-beta.2", "--commit")
        assert code == 1 and "Not committing" in out and release.NOTES_MARKER in out
        write("release-notes/v1.0.0-beta.2.md", "Real notes.\n")
        # GitHub refuses a pushed commit with a private address (GH007) too.
        g("config", "user.email", PRIVATE)
        code, out = run("prepare", "--tag", "v1.0.0-beta.2", "--commit")
        assert code == 1 and "The commit author uses an address at example.com" in out and PRIVATE not in out
        g("config", "--unset", "user.email")
        write("scratch-secret.txt", "not for the PR\n")
        code, out = run("prepare", "--tag", "v1.0.0-beta.2", "--open-pr")
        assert code == 0, out
        assert "scratch-secret.txt" not in g("show", "--name-only", "--format=", "HEAD")
        assert "Not committed (untracked, not written by prepare)" in out
        assert "release-notes/v1.0.0-beta.2.md" in g("show", "--name-only", "--format=", "HEAD")
        assert g("log", "-1", "--format=%s") == "chore: prepare changelog and release notes for v1.0.0-beta.2"
        assert g("ls-remote", "--heads", "origin", "chore/release-v1.0.0-beta.2") != ""
        (create,) = [call for call in fake.calls if call[:2] == ["pr", "create"]]
        assert create[create.index("--base") + 1] == "main"
        fake.open_pr = "https://github.com/o/r/pull/1"
        code, out = run("prepare", "--tag", "v1.0.0-beta.2", "--open-pr")
        assert code == 0 and "open already" in out
        assert len([call for call in fake.calls if call[:2] == ["pr", "create"]]) == 1


def test_prepare_refuses_a_branch_that_exists_only_on_origin() -> None:
    with sandbox():
        g("push", "-q", "origin", "main:refs/heads/chore/release-v1.0.0-beta.2")
        code, out = run("prepare", "--tag", "v1.0.0-beta.2")
        assert code == 1 and "exists on origin already" in out
        assert "git switch --track origin/chore/release-v1.0.0-beta.2" in out
        assert g("branch", "--show-current") == "main"


def test_bump_leaves_pre_releases_prose_and_tooling_of_a_stable_tag_alone() -> None:
    # A stable old tag moves only where it is pin-shaped.
    pins = (
        "uses: o/r/.github/workflows/a.yml@v1.0.0 #v1.0.0 --tag v1.0.0 TAG=v1.0.0 e.g. `v1.0.0`"
        ' for example `v1.0.0` from tag `v1.0.0` agent-kit@1.0.0 "version": "1.0.0"\n'
    )
    bumped, count = release.bump_text(pins, "v1.0.0", "v1.0.1")
    assert bumped == pins.replace("1.0.0", "1.0.1") and count == 9
    prose = (
        'starts at `v1.0.0`; the `1.0.0` line; "refs/tags/v1.0.0"; "1.0.0" dep; v1.0.0-beta.1, v1.0.0-rc.1;'
        " the 1.0.0 line; v1.0.0.md\n"
    )
    assert release.bump_text(prose, "v1.0.0", "v1.0.1") == (prose, 0)
    bumped, _ = release.bump_text(
        "v1.0.0-beta.5 @1.0.0-beta.5 v1.0.0-beta.50 v1.0.0-beta.5-x\n", "v1.0.0-beta.5", "v1.0.0-beta.6"
    )
    assert bumped == "v1.0.0-beta.6 @1.0.0-beta.6 v1.0.0-beta.50 v1.0.0-beta.5-x\n"
    # "broken" as a word marks history; "unbroken" does not.
    bumped, _ = release.bump_text(
        "unbroken @v1.0.0-beta.5\nis broken: @v1.0.0-beta.5\n", "v1.0.0-beta.5", "v1.0.0-beta.6"
    )
    assert bumped == "unbroken @v1.0.0-beta.6\nis broken: @v1.0.0-beta.5\n"
    # Tooling, contract tests and lockfiles carry example tags or dependency versions, not pins.
    for path in (
        "scripts/release.py",
        "scripts/release-notes-template.md",
        ".claude/skills/qa-plan/x.test.mjs",
        "package-lock.json",
        "cli/uv.lock",
    ):
        assert release.is_history(path), path
    assert not release.is_history("docs/getting-started.md")


def test_prepare_lists_the_stable_mentions_it_left() -> None:
    with sandbox():
        write("cli/package.json", '{\n  "name": "x",\n  "version": "1.0.0"\n}\n')
        write("docs/notes.md", "The `1.0.0` line starts at `v1.0.0`. Install: --tag v1.0.0\n")
        g("add", "-A")
        g("commit", "-qm", "stable")
        g("tag", "-a", "v1.0.0", "-m", "Release v1.0.0")
        g("push", "-q", "origin", "main", "v1.0.0")
        code, out = run("prepare", "--tag", "v1.0.1")
        assert code == 0, out
        assert read("docs/notes.md") == "The `1.0.0` line starts at `v1.0.0`. Install: --tag v1.0.1\n"
        assert json.loads(read("cli/package.json"))["version"] == "1.0.1"
        assert "only pin-shaped mentions moved" in out and "docs/notes.md:1:" in out


def test_prepare_does_not_commit_unrelated_tracked_edits_on_a_re_run() -> None:
    with sandbox():
        assert run("prepare", "--tag", "v1.0.0-beta.2")[0] == 0
        write("release-notes/v1.0.0-beta.2.md", "Real notes.\n")
        write("docs/adr/0001-x.md", "An unrelated edit.\n")
        code, out = run("prepare", "--tag", "v1.0.0-beta.2", "--commit")
        assert code == 1 and "do not look like release prep" in out and "docs/adr/0001-x.md" in out
        assert g("log", "-1", "--format=%s") == "seed", "nothing committed"
        assert g("diff", "--cached", "--name-only") == "", "and nothing left staged"


def test_release_tool_stops_on_python_before_3_10() -> None:
    text = (SCRIPTS / "release.py").read_text(encoding="utf-8")
    guard = text.index("if sys.version_info < (3, 10):")
    assert guard < text.index("from verify_release_snapshot import"), "check the version before anything runs"
    assert "write_text(" not in text.replace("NOTES_TEMPLATE.read_text", ""), "Path.write_text(newline=) needs 3.10"


def test_prepare_refuses_backward_existing_and_invalid_tags() -> None:
    with sandbox():
        for tag, why in (
            ("v1.0.0-alpha.9", "does not come after"),
            ("v1.0.0-beta.1", "already exists on origin"),
            ("1.0.0-beta.2", "Invalid tag"),
        ):
            code, out = run("prepare", "--tag", tag)
            assert code == 1 and why in out, (tag, out)
        g("tag", "-a", "v1.0.0-beta.2", "-m", "stale")
        code, out = run("prepare", "--tag", "v1.0.0-beta.2")
        assert code == 1 and "git tag -d v1.0.0-beta.2" in out
        assert g("branch", "--show-current") == "main"


def test_prepare_refuses_an_empty_unreleased_section_before_writing() -> None:
    with sandbox():
        write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n## [1.0.0-beta.1] - 2026-01-01\n\n- Old.\n")
        g("commit", "-qam", "empty")
        g("push", "-q", "origin", "main")
        code, out = run("prepare", "--tag", "v1.0.0-beta.2")
        assert code == 1 and "[Unreleased] section is empty" in out
        assert g("branch", "--show-current") == "main"
        assert g("branch", "--list", "chore/*") == ""
        write("x.txt", "dirty\n")
        code, out = run("prepare", "--tag", "v1.0.0-beta.2")
        assert code == 1 and "working tree has changes" in out


def test_prepare_moves_the_status_line_on_a_stage_change() -> None:
    with sandbox():
        code, out = run("prepare", "--tag", "v1.0.0-rc.1")
        assert code == 0, out
        assert "**Status:** pre-release (`1.0.0-rc`)" in read("README.md")
        assert "--tag v1.0.0-rc.1" in read("README.md")
    with sandbox():
        code, out = run("prepare", "--tag", "v1.0.0")
        assert code == 0, out
        assert "a stable release drops the pre-release Status line" in out


# --- cut --------------------------------------------------------------------


def test_cut_refuses_off_main_dirty_or_behind() -> None:
    with sandbox():
        ready_main()
        g("switch", "-q", "chore/release-v1.0.0-beta.2")
        code, out = run("cut", "--tag", "v1.0.0-beta.2")
        assert code == 1 and "Refusing to cut from 'chore/release-v1.0.0-beta.2'" in out
        assert "prepare-release.sh" in out
        g("switch", "-q", "main")
        write("stray.txt", "x\n")
        code, out = run("cut", "--tag", "v1.0.0-beta.2")
        assert code == 1 and "working tree" in out
        os.remove("stray.txt")
        g("commit", "-q", "--allow-empty", "-m", "local only")
        code, out = run("cut", "--tag", "v1.0.0-beta.2")
        assert code == 1 and "is not origin/main" in out


def test_cut_dry_run_passes_on_a_ready_main_and_writes_nothing() -> None:
    with sandbox():
        head = ready_main()
        code, out = run("cut", "--tag", "v1.0.0-beta.2")
        assert code == 0, out
        assert f"Dry run OK for v1.0.0-beta.2 at {head[:12]}" in out
        assert g("tag", "--list", "v1.0.0-beta.2") == "" and origin_tag("v1.0.0-beta.2") == ""


def test_cut_requires_green_ci_and_a_working_gh() -> None:
    with sandbox() as fake:
        ready_main()
        fake.checks["Tests"] = ("in_progress", "")
        fake.checks["Lint and format"] = ("completed", "failure")
        del fake.checks["Internal links"]
        code, out = run("cut", "--tag", "v1.0.0-beta.2")
        assert code == 1
        for phrase in ("'Tests' is in_progress", "'Lint and format' concluded failure", "'Internal links' has not"):
            assert phrase in out, out
        fake.checks = {name: ("completed", "success") for name in release.REQUIRED_CHECKS}
        fake.extra_checks = [("Tests", "completed", "failure", "2026-11-14T09:00:00Z")]
        assert run("cut", "--tag", "v1.0.0-beta.2")[0] == 0, "an older failed run does not count"
        fake.extra_checks = [("Tests", "completed", "failure", "2026-11-14T11:00:00Z")]
        code, out = run("cut", "--tag", "v1.0.0-beta.2")
        assert code == 1 and "'Tests' concluded failure" in out, "a newer failed run does"
        fake.extra_checks = []
        fake.installed = False
        code, out = run("cut", "--tag", "v1.0.0-beta.2")
        assert code == 1 and "gh CLI is required to check CI" in out and "cli.github.com" in out
        fake.installed, fake.signed_in = True, False
        code, out = run("cut", "--tag", "v1.0.0-beta.2")
        assert code == 1 and "gh auth login" in out


def test_cut_requires_the_version_changelog_and_finished_notes() -> None:
    with sandbox():
        ready_main()
        code, out = run("cut", "--tag", "v1.0.0-beta.3")
        assert code == 1
        assert "does not match tag v1.0.0-beta.3" in out
        assert "no '## [1.0.0-beta.3]' section" in out
        assert "release-notes/v1.0.0-beta.3.md is not committed" in out
        write("release-notes/v1.0.0-beta.2.md", f"{release.NOTES_MARKER}: x\n")
        g("commit", "-qam", "unfinished notes")
        g("push", "-q", "origin", "main")
        code, out = run("cut", "--tag", "v1.0.0-beta.2")
        assert code == 1 and "still has TODO(release-notes) lines" in out
        code, out = run("cut", "--tag", "v1.0.0-beta.2", "--notes-file", "elsewhere.md")
        assert code == 1 and "--notes-file must be release-notes/v1.0.0-beta.2.md" in out


def test_cut_refuses_a_private_tagger_email_without_printing_it() -> None:
    with sandbox():
        ready_main()
        g("config", "user.email", PRIVATE)
        code, out = run("cut", "--tag", "v1.0.0-beta.2")
        assert code == 1
        assert "an address at example.com" in out and "GH007" in out
        assert PRIVATE not in out, "never print the address itself"
        assert "users.noreply.github.com" in out and "git var GIT_COMMITTER_IDENT" in out
        assert "GIT_COMMITTER_EMAIL" in out and "--allow-private-email" in out
        assert run("cut", "--tag", "v1.0.0-beta.2", "--allow-private-email")[0] == 0
        # The environment beats git config, and the message says so.
        g("config", "user.email", NOREPLY)
        os.environ["GIT_COMMITTER_EMAIL"] = PRIVATE
        code, out = run("cut", "--tag", "v1.0.0-beta.2")
        assert code == 1 and "GIT_COMMITTER_EMAIL is set in your environment" in out


def test_cut_apply_then_publish_reuses_the_unpushed_tag() -> None:
    with sandbox() as fake:
        head = ready_main()
        code, out = run("cut", "--tag", "v1.0.0-beta.2", "--apply")
        assert code == 0, out
        tag = release.local_tag("v1.0.0-beta.2")
        assert tag and tag.annotated and tag.commit == head and tag.tagger_email == NOREPLY
        assert origin_tag("v1.0.0-beta.2") == "", "--apply alone pushes nothing"
        # The failure from the beta.5 cut: a later --apply --publish found the local tag.
        code, out = run("cut", "--tag", "v1.0.0-beta.2", "--apply", "--publish")
        assert code == 0, out
        assert "Reusing the local annotated tag" in out
        assert origin_tag("v1.0.0-beta.2").startswith(tag.obj)
        assert "Release: not created yet" in out and "Publish CLI workflow" in out
        # The Release is the workflow's job: the cut never creates one.
        assert not [call for call in fake.calls if call[:2] == ["release", "create"]]


def test_cut_refuses_an_unusable_local_tag_and_replaces_it_only_on_request() -> None:
    with sandbox():
        head = ready_main()
        g("tag", "-a", "v1.0.0-beta.2", "-m", "stale", "HEAD~1")
        code, out = run("cut", "--tag", "v1.0.0-beta.2", "--apply", "--publish")
        assert code == 1 and "points at" in out and "git tag -d v1.0.0-beta.2" in out
        assert "--replace-local-tag" in out
        assert release.local_tag("v1.0.0-beta.2").commit != head, "kept without the flag"
        assert origin_tag("v1.0.0-beta.2") == ""
        g("tag", "-d", "v1.0.0-beta.2")
        g("tag", "v1.0.0-beta.2")
        code, out = run("cut", "--tag", "v1.0.0-beta.2", "--apply")
        assert code == 1 and "lightweight" in out
        code, out = run("cut", "--tag", "v1.0.0-beta.2", "--apply", "--replace-local-tag")
        assert code == 0, out
        tag = release.local_tag("v1.0.0-beta.2")
        assert tag.annotated and tag.commit == head


def test_cut_refuses_to_push_a_local_tag_with_a_private_tagger() -> None:
    with sandbox():
        ready_main()
        env = {**os.environ, "GIT_COMMITTER_EMAIL": PRIVATE}
        g("tag", "-a", "v1.0.0-beta.2", "-m", "Release v1.0.0-beta.2", env=env)
        code, out = run("cut", "--tag", "v1.0.0-beta.2", "--apply", "--publish")
        assert code == 1 and "tagger address is not a noreply address" in out
        assert PRIVATE not in out
        assert origin_tag("v1.0.0-beta.2") == ""
        code, out = run("cut", "--tag", "v1.0.0-beta.2", "--apply", "--publish", "--replace-local-tag")
        assert code == 0, out
        assert release.local_tag("v1.0.0-beta.2").tagger_email == NOREPLY


def test_cut_treats_a_tag_on_origin_as_final() -> None:
    with sandbox() as fake:
        ready_main()
        # Someone pushed the tag at another commit; a stale local copy differs too.
        g("tag", "-a", "v1.0.0-beta.2", "-m", "elsewhere", "HEAD~1")
        g("push", "-q", "origin", "v1.0.0-beta.2")
        pushed = origin_tag("v1.0.0-beta.2")
        g("tag", "-d", "v1.0.0-beta.2")
        g("tag", "-a", "v1.0.0-beta.2", "-m", "local")
        fake.release_url = "https://github.com/o/r/releases/tag/v1.0.0-beta.2"
        fake.runs = [
            {"databaseId": 7, "headBranch": "v1.0.0-beta.2", "status": "waiting", "conclusion": "", "url": "u"}
        ]
        code, out = run("cut", "--tag", "v1.0.0-beta.2", "--apply", "--publish", "--replace-local-tag")
        assert code == 0, out
        assert "is final" in out and "differs from origin's" in out
        assert "GitHub Release: https://github.com/o/r/releases/tag/v1.0.0-beta.2" in out
        assert "Review deployments" in out
        assert origin_tag("v1.0.0-beta.2") == pushed, "a tag on origin is never moved or re-pushed"
        assert release.local_tag("v1.0.0-beta.2") is not None, "nor is the local copy deleted"
        fake.runs[0].update(status="completed", conclusion="failure")
        assert "gh run rerun 7 --failed" in run("cut", "--tag", "v1.0.0-beta.2")[1]


def test_cut_and_prepare_wrappers_find_a_working_python() -> None:
    for name, command in (("cut-release.sh", "cut"), ("prepare-release.sh", "prepare")):
        text = (SCRIPTS / name).read_text(encoding="utf-8")
        # #29: on Windows `python3` can be the Microsoft Store stub, which exists but fails.
        assert "for candidate in python3 python; do" in text
        assert """if "$candidate" -c 'import sys'""" in text
        assert f'exec "$PYTHON" scripts/release.py {command} "$@"' in text
    if shutil.which("bash"):
        done = subprocess.run(
            ["bash", "scripts/cut-release.sh", "--help"], cwd=ROOT, capture_output=True, text=True, check=False
        )
        assert done.returncode == 0 and "--replace-local-tag" in done.stdout, done.stderr
    manifest = (SCRIPTS / "release-snapshot-manifest.txt").read_text(encoding="utf-8").split()
    for path in ("scripts/release.py", "scripts/prepare-release.sh", "scripts/release-notes-template.md"):
        assert path in manifest, f"release-snapshot-manifest.txt must list {path}"


def test_required_checks_are_the_ci_job_names() -> None:
    jobs = yaml.safe_load(CI.read_text(encoding="utf-8"))["jobs"]
    assert set(release.REQUIRED_CHECKS) == {job["name"] for job in jobs.values()}
    # Like the ruleset, count only GitHub Actions' checks: another app could report the same name.
    assert 'select(.app.slug == "github-actions")' in (SCRIPTS / "release.py").read_text(encoding="utf-8")


# --- the Release workflow ---------------------------------------------------


def publish_workflow() -> dict:
    data = yaml.safe_load(PUBLISH.read_text(encoding="utf-8"))
    data["on"] = data.pop(True, data.get("on"))
    return data


def test_the_tag_push_creates_the_release_before_npm_publishes() -> None:
    wf = publish_workflow()
    assert wf["on"] == {"push": {"tags": ["v*"]}}
    assert wf["permissions"] == {}
    jobs = wf["jobs"]
    assert set(jobs) == {"release", "publish"}
    rel, pub = jobs["release"], jobs["publish"]
    # Least privilege: only the release job writes, only the publish job mints an OIDC token.
    assert rel["permissions"] == {"contents": "write"}
    assert "environment" not in rel
    assert pub["permissions"] == {"contents": "read", "id-token": "write"}
    assert pub["environment"] == "npm"
    assert pub["needs"] == "release", "npm publishes after the Release exists"
    names = [step.get("name", "") for step in rel["steps"]]
    create = names.index("Create the Release from release-notes/<tag>.md")
    assert names.index("Check the tagged commit is on main") < create
    step = rel["steps"][create]
    assert step["env"] == {"GH_TOKEN": "${{ github.token }}", "TAG": "${{ github.ref_name }}"}
    script = step["run"]
    assert "${{" not in script, "the tag reaches the script through env:, never interpolated"
    # Idempotent: an existing Release is left alone, and no tag is ever created.
    assert script.index('gh release view "$TAG"') < script.index('gh release create "$TAG"')
    assert "--verify-tag" in script
    assert '*"release not found"*' in script, "any other gh release view error stops the job"
    assert 'notes="release-notes/$TAG.md"' in script and '--notes-file "$notes"' in script
    assert "*-alpha.* | *-beta.* | *-rc.*) args+=(--prerelease)" in script
    # Notes are optional for alpha only.
    assert re.search(r'elif \[\[ "\$TAG" == \*-alpha\.\* \]\]; then\s+args\+=\(--notes "Pre-release \$TAG"\)', script)
    assert "beta, rc and stable Releases require notes" in script
    # Unfinished notes are refused here too, not only by the cut.
    assert "grep -q 'TODO(release-notes)' \"$notes\"" in script
    assert script.index("TODO(release-notes)") < script.index('gh release create "$TAG"')
    for job in jobs.values():
        runs = "\n".join(s.get("run", "") for s in job["steps"])
        assert 'git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main' in runs
        for s in job["steps"]:
            if "uses" in s:
                assert re.match(r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$", s["uses"]), s["uses"]
            if "actions/checkout" in s.get("uses", ""):
                assert s["with"]["persist-credentials"] is False


def test_cutting_doc_describes_the_two_step_flow() -> None:
    doc = (ROOT / "docs" / "cutting-releases.md").read_text(encoding="utf-8")
    for phrase in (
        "scripts/prepare-release.sh --tag",
        "scripts/cut-release.sh --tag",
        "--replace-local-tag",
        "--allow-private-email",
        "GIT_COMMITTER_EMAIL",
        "users.noreply.github.com",
        "GH007",
        "release-notes/<tag>.md",
        "Create the GitHub Release",
    ):
        assert phrase in doc, f"cutting-releases.md must mention {phrase!r}"
    contributing = (ROOT / "CONTRIBUTING.md").read_text(encoding="utf-8")
    assert "scripts/prepare-release.sh --tag" in contributing


if __name__ == "__main__":
    test_prepare_writes_the_release_prep_branch_and_pushes_nothing()
    test_prepare_is_safe_to_re_run_and_never_overwrites_notes()
    test_prepare_commits_only_finished_notes_and_can_open_the_pr()
    test_prepare_refuses_a_branch_that_exists_only_on_origin()
    test_bump_leaves_pre_releases_prose_and_tooling_of_a_stable_tag_alone()
    test_prepare_lists_the_stable_mentions_it_left()
    test_prepare_does_not_commit_unrelated_tracked_edits_on_a_re_run()
    test_release_tool_stops_on_python_before_3_10()
    test_prepare_refuses_backward_existing_and_invalid_tags()
    test_prepare_refuses_an_empty_unreleased_section_before_writing()
    test_prepare_moves_the_status_line_on_a_stage_change()
    test_cut_refuses_off_main_dirty_or_behind()
    test_cut_dry_run_passes_on_a_ready_main_and_writes_nothing()
    test_cut_requires_green_ci_and_a_working_gh()
    test_cut_requires_the_version_changelog_and_finished_notes()
    test_cut_refuses_a_private_tagger_email_without_printing_it()
    test_cut_apply_then_publish_reuses_the_unpushed_tag()
    test_cut_refuses_an_unusable_local_tag_and_replaces_it_only_on_request()
    test_cut_refuses_to_push_a_local_tag_with_a_private_tagger()
    test_cut_treats_a_tag_on_origin_as_final()
    test_cut_and_prepare_wrappers_find_a_working_python()
    test_required_checks_are_the_ci_job_names()
    test_the_tag_push_creates_the_release_before_npm_publishes()
    test_cutting_doc_describes_the_two_step_flow()
    print("release tooling contract: ok")
