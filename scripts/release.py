#!/usr/bin/env python3
"""Prepare and cut an Agent-kit Release, in two steps.

`prepare` runs on a branch, before the release-prep PR: it creates
`chore/release-<tag>` from an up-to-date default branch, bumps every pin of the
previous tag, moves `[Unreleased]` into a dated CHANGELOG section, and writes
`release-notes/<tag>.md` from a template when it is missing.

`cut` runs on the default branch, after that PR is merged: it checks the commit
is ready, then creates (or reuses) the annotated tag and pushes it. The tag push
starts `publish-cli.yml`, which creates the GitHub Release and publishes the npm
CLI. `cut` is safe to re-run after a failure at any point: each run finishes the
steps left or says exactly what is left.

Run them through `scripts/prepare-release.sh` and `scripts/cut-release.sh`,
which find a working Python first. Standard library only. See
docs/cutting-releases.md.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

# pyproject.toml's floor. Checked first, so an older interpreter (macOS's system
# python3 is 3.9) stops before it writes anything, not half-way through prepare.
if sys.version_info < (3, 10):  # noqa: UP036 - the wrappers run whatever python3 is on PATH
    sys.exit(f"Python 3.10 or later is required; this is {sys.version.split()[0]}. Put a newer python3 first on PATH.")

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from verify_release_snapshot import (  # noqa: E402 - needs the sys.path entry above
    cli_version_mismatch,
    notes_required_for_tag,
    parse_tag,
    verify_tree,
)

REMOTE = "origin"
NOREPLY_SUFFIX = "@users.noreply.github.com"
# The `main branch` ruleset requires these checks (CONTRIBUTING.md, Branch protection).
REQUIRED_CHECKS = ("Tests", "Lint and format", "Internal links")
PUBLISH_WORKFLOW = "publish-cli.yml"
NOTES_TEMPLATE = SCRIPTS / "release-notes-template.md"
# A line the release notes template asks the author to replace. Neither a
# commit from `prepare` nor a cut ships notes that still carry one.
NOTES_MARKER = "TODO(release-notes)"
MANIFEST = "scripts/release-snapshot-manifest.txt"
# Paths whose mentions of an older tag are history or fixtures, not pins: never bumped.
# scripts/ holds this tooling and the contract tests, whose example tags must not move.
HISTORY_PATHS = ("CHANGELOG.md", "release-notes/", "docs/adr/", "scripts/")
TEST_FILE = re.compile(r"\.test\.(?:py|mjs)$")
BROKEN_SECTION = "## Broken releases"
# A line that calls a tag broken is history. A whole word, so "unbroken" is not.
BROKEN_WORD = re.compile(r"\bbroken\b", re.IGNORECASE)
# Lockfiles pin dependency versions, which can equal a stable tag's version.
LOCKFILE = re.compile(r"(?:^|/)(?:package-lock\.json|npm-shrinkwrap\.json|uv\.lock|yarn\.lock|pnpm-lock\.yaml)$")
STATUS_LINE = re.compile(r"(\*\*Status:\*\* pre-release \(`)([^`]+)(`\))")
STAGE_RANK = {"alpha": 0, "beta": 1, "rc": 2, "": 3}
STAGE_WORD = {"alpha": "alpha", "beta": "beta", "rc": "release candidate", "": "stable release"}


class ReleaseError(Exception):
    """A refusal. The message says what is wrong and how to fix it."""


# --- git and gh -------------------------------------------------------------


def git(*args: str, check: bool = True) -> str:
    done = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8", check=False)
    if check and done.returncode != 0:
        raise ReleaseError(f"git {' '.join(args)} failed: {done.stderr.strip() or done.stdout.strip()}")
    return done.stdout.strip()


def git_ok(*args: str) -> bool:
    return subprocess.run(["git", *args], capture_output=True, check=False).returncode == 0


def run_gh(args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess:
    """Run gh. Tests replace this function; nothing else calls gh directly."""
    return subprocess.run(["gh", *args], input=stdin, capture_output=True, text=True, encoding="utf-8", check=False)


_GH_READY: bool | None = None


def gh(args: list[str], why: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    """Run gh after checking it is installed and signed in; `why` names what needs it."""
    global _GH_READY
    try:
        if _GH_READY is None:
            _GH_READY = run_gh(["api", "user", "--jq", ".login"]).returncode == 0
        if not _GH_READY:
            raise ReleaseError(f"gh is not signed in, and it is needed to {why}. Run: gh auth login")
        return run_gh(args, stdin)
    except FileNotFoundError:
        raise ReleaseError(
            f"The gh CLI is required to {why}, and it is not on PATH. "
            "Install it from https://cli.github.com, then run: gh auth login"
        ) from None


def repo_slug() -> str:
    """`owner/repo` of the origin remote, for gh's --repo."""
    url = git("remote", "get-url", REMOTE)
    match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$", url)
    if not match:
        raise ReleaseError(f"The {REMOTE} remote is not a GitHub repository: {url}")
    return match.group(1)


def repo_root() -> Path:
    return Path(git("rev-parse", "--show-toplevel"))


def default_branch() -> str:
    ref = git("symbolic-ref", "--quiet", "--short", f"refs/remotes/{REMOTE}/HEAD", check=False)
    return ref.split("/", 1)[1] if ref.startswith(f"{REMOTE}/") else "main"


def fetch_branch(branch: str) -> str:
    """Fetch `branch` from origin without tags (a fetched tag could clobber a local one); return its commit."""
    git("fetch", "--no-tags", "--quiet", REMOTE, f"+refs/heads/{branch}:refs/remotes/{REMOTE}/{branch}")
    return git("rev-parse", f"refs/remotes/{REMOTE}/{branch}")


def remote_tags() -> dict[str, str]:
    """Every `v*` tag on origin, mapped to the commit it points at (peeled)."""
    tags: dict[str, str] = {}
    for line in git("ls-remote", "--tags", REMOTE, "refs/tags/v*").splitlines():
        sha, _, ref = line.partition("\t")
        name = ref.removeprefix("refs/tags/")
        if name.endswith("^{}"):
            tags[name[:-3]] = sha
        else:
            tags.setdefault(name, sha)
    return tags


def remote_tag_object(tag: str) -> str:
    """The object origin's ref names: the tag object itself for an annotated tag."""
    for line in git("ls-remote", "--tags", REMOTE, f"refs/tags/{tag}").splitlines():
        sha, _, ref = line.partition("\t")
        if ref == f"refs/tags/{tag}":
            return sha
    return ""


@dataclass
class LocalTag:
    annotated: bool
    commit: str
    obj: str
    tagger_email: str


def local_tag(tag: str) -> LocalTag | None:
    fmt = "%(refname)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(taggeremail)"
    for line in git("for-each-ref", f"--format={fmt}", f"refs/tags/{tag}").splitlines():
        ref, kind, obj, peeled, email = line.split("\x00")
        if ref == f"refs/tags/{tag}":
            annotated = kind == "tag"
            return LocalTag(annotated, peeled if annotated else obj, obj, email.strip("<>"))
    return None


# --- tags and versions ------------------------------------------------------


def tag_key(tag: str) -> tuple[int, int, int, int, int]:
    parsed = parse_tag(tag)
    if parsed is None:
        raise ReleaseError(f"Invalid tag: {tag!r}. Use vX.Y.Z or vX.Y.Z-<alpha|beta|rc>.N, e.g. v1.0.0-beta.6")
    return (
        int(parsed["major"]),
        int(parsed["minor"]),
        int(parsed["patch"]),
        STAGE_RANK[str(parsed["stage"])],
        int(parsed["counter"]),
    )


def latest_tag(tags: list[str]) -> str | None:
    valid = [tag for tag in tags if parse_tag(tag)]
    return max(valid, key=tag_key) if valid else None


def order_problem(tag: str, released: dict[str, str]) -> str | None:
    if tag in released:
        return f"{tag} already exists on {REMOTE}. A pushed tag is final; prepare the next tag instead."
    latest = latest_tag(list(released))
    if latest and tag_key(tag) <= tag_key(latest):
        return (
            f"{tag} does not come after the latest tag on {REMOTE}, {latest}. Tags only move forward "
            "(alpha -> beta -> rc -> stable, docs/releases.md)."
        )
    return None


# --- identity ---------------------------------------------------------------


def committer_email(kind: str = "COMMITTER") -> str:
    """The address git will record: GIT_COMMITTER_IDENT (also a tag's tagger) or GIT_AUTHOR_IDENT."""
    match = re.search(r"<([^>]*)>", git("var", f"GIT_{kind}_IDENT"))
    return match.group(1) if match else ""


def email_problem(email: str, whose: str) -> str | None:
    """Why GitHub may refuse a push carrying `email`, or None. Names the domain only, never the address."""
    if email.lower().endswith(NOREPLY_SUFFIX):
        return None
    where = f"an address at {email.rpartition('@')[2]}" if "@" in email else "no usable address"
    return (
        f"{whose} uses {where}, not a {NOREPLY_SUFFIX} address. With email privacy on,"
        " GitHub refuses the push (GH007).\n" + email_fix()
    )


def email_fix() -> str:
    lines = [
        "  Fix: set your GitHub noreply address for this repository, then re-run:",
        """    git config user.email "$(gh api user --jq '"\\(.id)+\\(.login)@users.noreply.github.com"')\"""",
        "  Check what git will use: git var GIT_COMMITTER_IDENT",
    ]
    overrides = [name for name in ("GIT_COMMITTER_EMAIL", "EMAIL") if os.environ.get(name)]
    if overrides:
        lines.append(f"  {' and '.join(overrides)} is set in your environment and can win over git config: unset it.")
    else:
        lines.append("  Environment variables such as GIT_COMMITTER_EMAIL (or EMAIL) override git config if set.")
    lines.append("  Only if your account allows pushes with that address: re-run with --allow-private-email.")
    return "\n".join(lines)


# --- prepare ----------------------------------------------------------------


def write_file(path: Path, text: str) -> None:
    """Write UTF-8 with LF line ends, whatever the platform."""
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def bump_pattern(old_tag: str) -> re.Pattern[str]:
    """A pin of `old_tag`: `v0.9.0-beta.2` or `0.9.0-beta.2`, but not `10.9.0-beta.2`, `0.9.0-beta.20`,
    or (for a stable `v0.9.0`) the pre-release `v0.9.0-rc.1`.

    A stable `X.Y.Z` is common in prose and fixtures ("the `1.0.0` line", "starts at `v1.0.0`",
    `"refs/tags/v1.0.0"`, a `"1.0.0"` dependency), so for a stable old tag only pin shapes move:
    `@vX.Y.Z` and `#vX.Y.Z` (uses: and skills pins), `--tag vX.Y.Z`, `TAG=vX.Y.Z`, `` e.g. `vX.Y.Z` ``,
    `` for example `vX.Y.Z` ``, `` from tag `vX.Y.Z` ``, `@X.Y.Z` (npm) and `"version": "X.Y.Z"`.
    `prepare` lists the mentions it left for the author to check.
    """
    version = re.escape(old_tag[1:])
    end = r"(?![0-9A-Za-z]|-[0-9A-Za-z])"
    if parse_tag(old_tag) and parse_tag(old_tag)["stage"]:
        return re.compile(r"(?<![\w.])(v?)" + version + end)
    tagged = "|".join(f"(?<={before})" for before in ("@", "#", "--tag ", "TAG=", r"e\.g\. `", "example `", "tag `"))
    bare = "|".join(f"(?<={before})" for before in ("@", r'"version": "'))
    return re.compile(f"(?:(?:{tagged})(v)|(?:{bare})())" + version + end)


def is_history(path: str) -> bool:
    if TEST_FILE.search(path) or LOCKFILE.search(path):
        return True
    return any(path == p or path.startswith(p) for p in HISTORY_PATHS)


def bump_text(text: str, old_tag: str, new_tag: str) -> tuple[str, int]:
    """Rewrite pins of `old_tag` to `new_tag`. Lines about broken tags are history and stay."""
    pattern = bump_pattern(old_tag)
    out: list[str] = []
    count = 0
    in_broken = False
    for line in text.splitlines(keepends=True):
        if line.startswith("## "):
            in_broken = line.rstrip() == BROKEN_SECTION
        if in_broken or BROKEN_WORD.search(line):
            out.append(line)
            continue
        new_line, n = pattern.subn(lambda m: "".join(g for g in m.groups() if g) + new_tag[1:], line)
        out.append(new_line)
        count += n
    return "".join(out), count


def bump_pins(old_tag: str, new_tag: str) -> list[str]:
    changed = []
    found = git("-c", "core.quotePath=false", "grep", "-z", "-l", "-I", "-F", old_tag[1:], check=False)
    for path in filter(None, found.split("\x00")):
        if is_history(path):
            continue
        file = Path(path)
        with file.open(encoding="utf-8", newline="") as handle:
            text = handle.read()
        new_text, count = bump_text(text, old_tag, new_tag)
        if count:
            with file.open("w", encoding="utf-8", newline="") as handle:
                handle.write(new_text)
            changed.append(f"{path} ({count})")
    return changed


def bump_status_line(text: str, new_tag: str) -> tuple[str, str | None]:
    """Move the README Status line to the new stage. Returns the text and a note for the author, if any."""
    parsed = parse_tag(new_tag)
    assert parsed is not None
    match = STATUS_LINE.search(text)
    if not parsed["stage"]:
        if match:
            return text, (
                "README.md: a stable release drops the pre-release Status line; keep the broken-tags warning"
                " as its own sentence (scripts/readme-freshness-contract.test.py checks it)."
            )
        return text, None
    want = f"{parsed['major']}.{parsed['minor']}.{parsed['patch']}-{parsed['stage']}"
    if match is None or match.group(2) == want:
        return text, None
    return STATUS_LINE.sub(lambda m: m.group(1) + want + m.group(3), text, count=1), None


def move_unreleased(text: str, version: str, date: str) -> tuple[str, bool]:
    """Move `[Unreleased]` into `## [version] - date`. Returns (text, moved); False when already moved."""
    if re.search(rf"^## \[{re.escape(version)}\]", text, re.MULTILINE):
        return text, False
    heading = re.search(r"^## \[Unreleased\][^\n]*\n", text, re.MULTILINE)
    if heading is None:
        raise ReleaseError("CHANGELOG.md has no '## [Unreleased]' heading.")
    rest = text[heading.end() :]
    following = re.search(r"^## \[", rest, re.MULTILINE)
    body = rest[: following.start()] if following else rest
    tail = rest[following.start() :] if following else ""
    if not body.strip():
        raise ReleaseError(
            "CHANGELOG.md's [Unreleased] section is empty, so there is nothing to release. "
            "Add the entries for this release under [Unreleased] first."
        )
    section = f"## [{version}] - {date}\n\n{body.strip(chr(10))}\n"
    return text[: heading.end()] + "\n" + section + ("\n" + tail if tail else ""), True


def notes_from_template(tag: str) -> str:
    parsed = parse_tag(tag)
    assert parsed is not None
    text = NOTES_TEMPLATE.read_text(encoding="utf-8")
    for key, value in {
        "{{TAG}}": tag,
        "{{VERSION}}": tag[1:],
        "{{STAGE}}": STAGE_WORD[str(parsed["stage"])],
    }.items():
        text = text.replace(key, value)
    # The template's first lines explain it to whoever edits it; they are not notes.
    return text.split("<!-- template-end -->\n", 1)[-1].lstrip("\n")


def previous_tag(new_tag: str, released: dict[str, str], override: str | None) -> str:
    if override:
        tag_key(override)
        return override
    version = json.loads(Path("cli/package.json").read_text(encoding="utf-8"))["version"]
    from_package = f"v{version}"
    if from_package != new_tag:
        tag_key(from_package)
        return from_package
    latest = latest_tag(list(released))
    if latest is None:
        raise ReleaseError("cli/package.json already names the new tag and origin has no v* tag. Pass --from <tag>.")
    return latest


def prepare(args: argparse.Namespace) -> int:
    tag = args.tag
    tag_key(tag)
    parsed = parse_tag(tag)
    assert parsed is not None
    os.chdir(repo_root())
    base = default_branch()
    branch = f"chore/release-{tag}"
    released = remote_tags()
    problem = order_problem(tag, released)
    if problem:
        raise ReleaseError(problem)
    if local_tag(tag):
        raise ReleaseError(
            f"A local tag {tag} exists (not on {REMOTE}), likely left by an earlier cut. Prepare runs before the"
            f" tag exists. Delete it, then re-run: git tag -d {tag}"
        )
    base_sha = fetch_branch(base)

    if git("branch", "--show-current") == branch:
        if not git_ok("merge-base", "--is-ancestor", f"refs/remotes/{REMOTE}/{base}", "HEAD"):
            raise ReleaseError(f"{branch} is behind {REMOTE}/{base}. Rebase it first: git rebase {REMOTE}/{base}")
        print(f"On {branch} already; re-running the prepare steps.")
    else:
        if git("status", "--porcelain"):
            raise ReleaseError("The working tree has changes. Commit or stash them, then re-run.")
        if git_ok("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"):
            raise ReleaseError(
                f"Branch {branch} exists. Switch to it to re-run there (git switch {branch}),"
                f" or delete it (git branch -D {branch})."
            )
        if git("ls-remote", "--heads", REMOTE, f"refs/heads/{branch}"):
            raise ReleaseError(
                f"{branch} exists on {REMOTE} already (pushed from another clone?). Continue it there:"
                f" git switch --track {REMOTE}/{branch} (after git fetch {REMOTE}), then re-run."
            )
        # Refuse an empty [Unreleased] before writing anything, the branch included.
        move_unreleased(git("show", f"{base_sha}:CHANGELOG.md"), tag[1:], "check")
        git("switch", "--quiet", "--no-track", "-c", branch, base_sha)
        print(f"Created {branch} from {REMOTE}/{base} ({base_sha[:12]}).")

    old = previous_tag(tag, released, args.from_tag)
    notes_for_author: list[str] = []

    changed = bump_pins(old, tag) if old != tag else []
    print(f"Pins: {old} -> {tag}: " + (", ".join(changed) if changed else "nothing left to bump."))
    if old != tag and not parse_tag(old)["stage"]:
        left = git("-c", "core.quotePath=false", "grep", "-n", "-I", "-w", "-F", old, check=False)
        left_lines = [line for line in left.splitlines() if not is_history(line.split(":", 1)[0])]
        if left_lines:
            # A list to read, not a blocker: most of these are prose and fixtures.
            print(f"{old} is stable, so only pin-shaped mentions moved. Check these, and bump any that are pins:")
            for line in left_lines:
                print(f"  {line[:160]}")

    readme = Path("README.md")
    if readme.is_file():
        text = readme.read_text(encoding="utf-8")
        new_text, note = bump_status_line(text, tag)
        if new_text != text:
            write_file(readme, new_text)
            print("README.md: Status line moved to the new stage.")
        if note:
            notes_for_author.append(note)

    changelog = Path("CHANGELOG.md")
    date = args.date or datetime.date.today().isoformat()
    new_text, moved = move_unreleased(changelog.read_text(encoding="utf-8"), tag[1:], date)
    if moved:
        write_file(changelog, new_text)
        print(f"CHANGELOG.md: [Unreleased] moved into [{tag[1:]}] - {date}.")
    else:
        print(f"CHANGELOG.md: [{tag[1:]}] exists already; left as is.")

    notes = Path(f"release-notes/{tag}.md")
    if notes.is_file():
        print(f"{notes.as_posix()}: exists; left as is.")
    elif notes_required_for_tag(tag):
        notes.parent.mkdir(exist_ok=True)
        write_file(notes, notes_from_template(tag))
        print(f"{notes.as_posix()}: written from the template. Replace every {NOTES_MARKER} line.")
    else:
        print(f"{notes.as_posix()}: optional for alpha; not written.")
    if notes.is_file() and NOTES_MARKER in notes.read_text(encoding="utf-8"):
        notes_for_author.append(f"{notes.as_posix()}: replace every {NOTES_MARKER} line.")

    missing = verify_tree(Path.cwd(), Path(MANIFEST))
    if missing:
        raise ReleaseError("Release snapshot check failed. Missing paths:\n" + "\n".join(f"  - {p}" for p in missing))
    print("Release snapshot check passed.")

    title = f"chore: prepare changelog and release notes for {tag}"
    if args.commit or args.push or args.open_pr:
        if notes_for_author:
            raise ReleaseError("Not committing, because these are left for you:\n" + "\n".join(notes_for_author))
        for kind in ("AUTHOR", "COMMITTER"):
            problem = (
                None if args.allow_private_email else email_problem(committer_email(kind), f"The commit {kind.lower()}")
            )
            if problem:
                raise ReleaseError(problem)
        # Tracked changes (the bumps, README, CHANGELOG) and the notes, never a stray untracked file.
        git("add", "--update")
        if notes.is_file():
            git("add", "--", notes.as_posix())
        stray = git("ls-files", "--others", "--exclude-standard")
        if stray:
            print(
                "Not committed (untracked, not written by prepare):\n" + "\n".join(f"  {p}" for p in stray.split("\n"))
            )
        staged = git("diff", "--cached", "--name-only").splitlines()
        expected = {"CHANGELOG.md", "README.md", notes.as_posix()}
        unrelated = [
            path
            for path in staged
            if path not in expected and tag[1:] not in git("diff", "--cached", "-U0", "--", path)
        ]
        if unrelated:
            git("reset", "--quiet")
            raise ReleaseError(
                "Not committing: these staged changes do not look like release prep (no new tag in their diff):\n"
                + "\n".join(f"  {path}" for path in unrelated)
                + "\nCommit them separately, or move them off this branch, then re-run."
            )
        if staged:
            git("commit", "--quiet", "-m", title)
            print(f"Committed: {title}")
    if args.push or args.open_pr:
        git("push", "--quiet", "--set-upstream", REMOTE, f"refs/heads/{branch}")
        print(f"Pushed {branch}.")
    if args.open_pr:
        existing = gh(
            [
                "pr",
                "view",
                branch,
                "--repo",
                repo_slug(),
                "--json",
                "url,state",
                "--jq",
                'select(.state == "OPEN") | .url',
            ],
            "check for an open pull request",
        )
        if existing.returncode == 0 and existing.stdout.strip():
            print(f"A pull request is open already: {existing.stdout.strip()}")
            return 0
        body = (
            f"Release prep for `{tag}`, written by `scripts/prepare-release.sh`.\n\n"
            f"- Pins move from `{old}` to `{tag}`.\n"
            f"- `CHANGELOG.md`: `[Unreleased]` moved into `[{tag[1:]}]`.\n"
            f"- `release-notes/{tag}.md`: the Release body.\n\n"
            "After merge (Admin bypass, once CI is green), from an up-to-date main:\n\n"
            f"```bash\nbash scripts/cut-release.sh --tag {tag}\n"
            f"bash scripts/cut-release.sh --tag {tag} --apply --publish\n```\n"
        )
        done = gh(
            [
                "pr",
                "create",
                "--repo",
                repo_slug(),
                "--base",
                base,
                "--head",
                branch,
                "--title",
                title,
                "--body-file",
                "-",
            ],
            "open the pull request",
            stdin=body,
        )
        if done.returncode != 0:
            raise ReleaseError(f"gh pr create failed: {done.stderr.strip()}")
        print(f"Opened {done.stdout.strip()}")
        return 0

    if notes_for_author:
        print("\nLeft for you:")
    for note in notes_for_author:
        print(f"  - {note}")
    if not (args.push or args.open_pr):
        print("\nNext, once you have reviewed `git diff`:")
        if not args.commit:
            print(f'  git add --update && git add {notes.as_posix()} && git commit -m "{title}"')
        print(f"  git push --set-upstream {REMOTE} {branch}")
        print(f'  gh pr create --base {base} --title "{title}" --fill')
        print("  (or re-run with --open-pr to commit, push and open it in one go)")
        print(f"After the PR merges (Admin bypass, once CI is green): bash scripts/cut-release.sh --tag {tag}")
    return 0


# --- cut --------------------------------------------------------------------


def ci_problem(sha: str) -> str | None:
    done = gh(
        [
            "api",
            f"repos/{repo_slug()}/commits/{sha}/check-runs?per_page=100",
            "--paginate",
            "--jq",
            # Only GitHub Actions' checks count, as in the ruleset: another app could report the same name.
            '.check_runs[] | select(.app.slug == "github-actions")'
            ' | [.name, .status, (.conclusion // ""), (.started_at // "")] | @tsv',
        ],
        "check CI on the commit",
    )
    if done.returncode != 0:
        return f"Could not read CI checks for {sha[:12]}: {done.stderr.strip()}"
    # A commit can carry several runs of one check (a pull_request run and a push run on the same
    # SHA, or a re-run). The newest one is CI's current answer.
    newest: dict[str, tuple[str, str, str]] = {}
    for line in done.stdout.splitlines():
        name, status, conclusion, started = (line.split("\t") + ["", "", ""])[:4]
        if name not in newest or started >= newest[name][0]:
            newest[name] = (started, status, conclusion)
    runs = {name: (status, conclusion) for name, (_, status, conclusion) in newest.items()}
    problems = []
    for name in REQUIRED_CHECKS:
        status, conclusion = runs.get(name, ("", ""))
        if not status:
            problems.append(f"'{name}' has not reported")
        elif status != "completed":
            problems.append(f"'{name}' is {status}")
        elif conclusion != "success":
            problems.append(f"'{name}' concluded {conclusion or 'without a result'}")
    if problems:
        return f"CI on {sha[:12]} is not green: {'; '.join(problems)}. Wait for it (or fix it), then re-run."
    return None


def head_file(path: str) -> str | None:
    done = subprocess.run(
        ["git", "show", f"HEAD:{path}"], capture_output=True, text=True, encoding="utf-8", check=False
    )
    return done.stdout if done.returncode == 0 else None


def content_problems(tag: str) -> list[str]:
    """What the tagged commit must hold: the snapshot, the CLI version, the CHANGELOG section and notes."""
    problems = []
    missing = verify_tree(Path.cwd(), Path(MANIFEST))
    if missing:
        problems.append("Release snapshot paths missing: " + ", ".join(missing))
    mismatch = cli_version_mismatch(tag, Path.cwd())
    if mismatch:
        problems.append(mismatch)
    if notes_required_for_tag(tag):
        changelog = head_file("CHANGELOG.md") or ""
        if not re.search(rf"^## \[{re.escape(tag[1:])}\]", changelog, re.MULTILINE):
            problems.append(f"CHANGELOG.md has no '## [{tag[1:]}]' section; beta, rc and stable require one.")
        notes = head_file(f"release-notes/{tag}.md")
        if notes is None:
            problems.append(
                f"release-notes/{tag}.md is not committed; beta, rc and stable require it. Run prepare-release.sh."
            )
        elif NOTES_MARKER in notes:
            problems.append(f"release-notes/{tag}.md still has {NOTES_MARKER} lines; fill them in on a PR first.")
    return problems


def report_published(tag: str, commit: str) -> int:
    """The tag is on origin: final. Say what is done and what is left; never push, move or delete it."""
    print(f"{tag} is on {REMOTE} at {commit[:12]}. A tag on {REMOTE} is final: this script never moves,")
    print("deletes or re-pushes it. If it is broken, cut the next tag (docs/cutting-releases.md).")
    mine = local_tag(tag)
    if mine and mine.obj != remote_tag_object(tag):
        print(f"\nYour local {tag} differs from {REMOTE}'s. Replace it with {REMOTE}'s (local only):")
        print(f"  git tag -d {tag} && git fetch {REMOTE} refs/tags/{tag}:refs/tags/{tag}")
    try:
        slug = repo_slug()
        release = gh(
            ["release", "view", tag, "--repo", slug, "--json", "url", "--jq", ".url"],
            "check the GitHub Release",
        )
        runs = gh(
            [
                "run",
                "list",
                "--repo",
                slug,
                "--workflow",
                PUBLISH_WORKFLOW,
                "--limit",
                "50",
                "--json",
                "databaseId,headBranch,status,conclusion,url",
            ],
            "check the Publish CLI run",
        )
    except ReleaseError as err:
        print(f"\n{err}\nCheck by hand: the GitHub Release for {tag} and its Publish CLI run in Actions.")
        return 0
    left = []
    if release.returncode == 0:
        print(f"\nGitHub Release: {release.stdout.strip()}")
    elif "not found" in (release.stderr + release.stdout).lower():
        print("\nGitHub Release: not created yet. The Publish CLI workflow creates it from the tag.")
        left.append("Release")
    else:
        print(f"\nGitHub Release: could not check ({release.stderr.strip()}).")
        left.append("Release")
    mine_runs = (
        [r for r in json.loads(runs.stdout or "[]") if r.get("headBranch") == tag] if runs.returncode == 0 else []
    )
    if not mine_runs:
        print(f"Publish CLI: no run found for {tag} yet. Pushing a tag starts it; check Actions in a minute.")
        left.append("npm publish")
    else:
        run = mine_runs[0]
        state = run.get("conclusion") or run.get("status")
        print(f"Publish CLI run: {state} ({run.get('url')})")
        if run.get("status") == "waiting":
            left.append("npm publish")
            print("  It is waiting for you: open the run, Review deployments, Approve and deploy (npm).")
        elif run.get("status") != "completed":
            left.append("npm publish")
            print("  Still running; re-run this script later to check.")
        elif run.get("conclusion") != "success":
            left.append("npm publish")
            print(f"  It failed. Read the log, fix the cause, then: gh run rerun {run.get('databaseId')} --failed")
    if left:
        print(f"\nLeft: {', '.join(left)}. Nothing is left for this script to do locally.")
    else:
        print(
            f"\nDone: {tag} is tagged, released and published. Check npm: "
            f"npm view @mnaimfaizy/agent-kit@{tag[1:]} version"
        )
    return 0


def cut(args: argparse.Namespace) -> int:
    tag = args.tag
    tag_key(tag)
    os.chdir(repo_root())
    notes_path = Path(f"release-notes/{tag}.md")
    if args.notes_file and Path(args.notes_file).resolve() != notes_path.resolve():
        raise ReleaseError(
            f"--notes-file must be {notes_path.as_posix()}: the Publish CLI workflow creates the Release from that"
            " file on the tag. Move your notes there in the release-prep PR."
        )

    released = remote_tags()
    if tag in released:
        return report_published(tag, released[tag])

    base = default_branch()
    branch = git("branch", "--show-current")
    if branch != base:
        raise ReleaseError(
            f"Refusing to cut from '{branch or 'a detached HEAD'}'; the cut runs on '{base}'. Release prep runs on a"
            f" branch: bash scripts/prepare-release.sh --tag {tag}. After its PR merges: git switch {base} && git pull"
        )
    if git("status", "--porcelain"):
        raise ReleaseError("The working tree has changes or untracked files. The tag is cut from a clean checkout.")
    head = git("rev-parse", "HEAD")
    upstream = fetch_branch(base)
    if head != upstream:
        raise ReleaseError(
            f"HEAD ({head[:12]}) is not {REMOTE}/{base} ({upstream[:12]}). Run: git pull --ff-only"
            f" (or drop local commits), then re-run."
        )

    problems = []
    order = order_problem(tag, released)
    if order:
        problems.append(order)
    problems += content_problems(tag)
    try:
        ci = ci_problem(head)
    except ReleaseError as err:
        ci = str(err)
    if ci:
        problems.append(ci)

    existing = local_tag(tag)
    replace = False
    if existing:
        issues = []
        if not existing.annotated:
            issues.append("it is a lightweight tag, not an annotated one")
        if existing.commit != head:
            issues.append(f"it points at {existing.commit[:12]}, not HEAD {head[:12]}")
        tagger = None if args.allow_private_email else email_problem(existing.tagger_email, f"Its tagger ({tag})")
        if tagger:
            issues.append("its tagger address is not a noreply address")
        if issues and args.replace_local_tag:
            replace = True
            print(f"Will replace the unpushed local tag {tag}: {'; '.join(issues)}.")
        elif issues:
            problems.append(
                f"A local tag {tag} exists but cannot be pushed as is: {'; '.join(issues)}.\n"
                f"  It is not on {REMOTE}, so it was never published and is safe to delete. Either:\n"
                f"    git tag -d {tag}   then re-run\n"
                f"  or re-run with --replace-local-tag to delete and recreate it." + (f"\n{tagger}" if tagger else "")
            )
    if not existing or replace:
        identity = None if args.allow_private_email else email_problem(committer_email(), "The tagger git will use")
        if identity:
            problems.append(identity)

    if problems:
        print(f"Not ready to cut {tag}:", file=sys.stderr)
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1

    reuse = existing is not None and not replace
    if not args.apply:
        action = "reuse the local tag" if reuse else "create an annotated tag"
        print(f"Dry run OK for {tag} at {head[:12]} on {base}: CI is green; would {action} and push it.")
        print(f"Next: bash scripts/cut-release.sh --tag {tag} --apply --publish")
        if args.publish:
            print("Note: --publish does nothing without --apply.")
        return 0

    if replace:
        git("tag", "-d", tag)
    if reuse:
        print(f"Reusing the local annotated tag {tag} at {head[:12]}.")
    else:
        git("tag", "-a", tag, "-m", f"Release {tag}", head)
        created = local_tag(tag)
        tagger = None if args.allow_private_email else email_problem(created.tagger_email if created else "", "The tag")
        if tagger:
            git("tag", "-d", tag)
            raise ReleaseError(f"Deleted the tag just created, because:\n{tagger}")
        print(f"Created the annotated tag {tag} at {head[:12]}.")

    if not args.publish:
        print(
            f"Push it (the push starts the Release and npm publish): bash scripts/cut-release.sh --tag {tag} --apply"
            " --publish"
        )
        return 0

    pushed = subprocess.run(
        ["git", "push", REMOTE, f"refs/tags/{tag}"], capture_output=True, text=True, encoding="utf-8", check=False
    )
    if pushed.returncode != 0:
        err = pushed.stderr.strip()
        hint = ""
        if "GH007" in err:
            hint = "\nGitHub refused the tagger email (GH007).\n" + email_fix()
        elif "rule" in err.lower() or "protected" in err.lower():
            hint = "\nThe `release tags` ruleset lets only the Admin role create v* tags: push as the maintainer."
        raise ReleaseError(f"Pushing {tag} failed; it is still local only, so re-running is safe.\n{err}{hint}")
    print(f"Pushed {tag}. The Publish CLI workflow now creates the GitHub Release and publishes the npm CLI.")
    return report_published(tag, head)


# --- entry point ------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    top = argparse.ArgumentParser(prog="release.py", description=__doc__.split("\n\n")[0])
    sub = top.add_subparsers(dest="command", required=True)

    prep = sub.add_parser("prepare", help="write the release-prep branch (run before the PR)")
    prep.add_argument("--tag", required=True, help="the tag to prepare, e.g. v1.0.0-beta.6")
    prep.add_argument(
        "--from", dest="from_tag", help="the previous tag whose pins to bump (default: from cli/package.json)"
    )
    prep.add_argument("--date", help="the CHANGELOG date, YYYY-MM-DD (default: today)")
    prep.add_argument("--commit", action="store_true", help="commit the changes")
    prep.add_argument("--push", action="store_true", help="commit and push the branch")
    prep.add_argument("--open-pr", action="store_true", help="commit, push and open the pull request (needs gh)")
    prep.add_argument("--allow-private-email", action="store_true", help="commit with a non-noreply address")

    cutp = sub.add_parser("cut", help="tag the default branch and push the tag (run after the PR merges)")
    cutp.add_argument("--tag", required=True, help="the tag to cut, e.g. v1.0.0-beta.6")
    cutp.add_argument("--apply", action="store_true", help="create the annotated tag locally (or reuse a valid one)")
    cutp.add_argument("--publish", action="store_true", help="with --apply: push the tag, which starts the Release")
    cutp.add_argument("--notes-file", help="accepted for compatibility; must be release-notes/<tag>.md")
    cutp.add_argument(
        "--replace-local-tag",
        action="store_true",
        help="delete and recreate an unpushed local tag that cannot be reused",
    )
    cutp.add_argument("--allow-private-email", action="store_true", help="tag with a non-noreply address")
    return top


def main(argv: list[str] | None = None) -> int:
    global _GH_READY
    _GH_READY = None
    args = parser().parse_args(argv)
    try:
        return prepare(args) if args.command == "prepare" else cut(args)
    except ReleaseError as err:
        print(str(err), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
