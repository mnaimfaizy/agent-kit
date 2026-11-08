"""Contract test: the npm CLI package, its publish workflow, and the release cut stay in step.

`@mnaimfaizy/agent-kit` is published from `cli/` on every Release tag (ADR 0001):
code only, no runtime dependencies, a version equal to the tag, and npm trusted
publishing (OIDC, provenance, a protected `npm` environment) with no stored
token. The root package stays private dev tooling.
"""

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from verify_release_snapshot import cli_version_mismatch  # noqa: E402 - needs the sys.path entry above

CLI = ROOT / "cli"
PACKAGE = CLI / "package.json"
PUBLISH = ROOT / ".github" / "workflows" / "publish-cli.yml"
CUT = ROOT / "scripts" / "cut-release.sh"
SNAPSHOT = ROOT / "scripts" / "release-snapshot-manifest.txt"
CHANGELOG = ROOT / "CHANGELOG.md"
VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$")
DEP_FIELDS = ("dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies")


def package() -> dict:
    return json.loads(PACKAGE.read_text(encoding="utf-8"))


def publish_workflow() -> dict:
    data = yaml.safe_load(PUBLISH.read_text(encoding="utf-8"))
    data["on"] = data.pop(True, data.get("on"))
    return data


def test_package_shape() -> None:
    pkg = package()
    assert pkg["name"] == "@mnaimfaizy/agent-kit"
    assert pkg["type"] == "module"
    assert pkg["bin"] == {"agent-kit": "bin/agent-kit.mjs"}
    assert pkg["engines"] == {"node": ">=22"}
    assert pkg.get("private") is not True, "cli/package.json must be publishable"
    assert pkg["publishConfig"] == {"access": "public", "provenance": True}
    # npm provenance checks the repository field against the publishing workflow.
    assert pkg["repository"]["url"] == "git+https://github.com/mnaimfaizy/agent-kit.git"
    assert pkg["repository"]["directory"] == "cli"


def test_package_has_no_runtime_dependencies_or_install_scripts() -> None:
    pkg = package()
    for field in DEP_FIELDS:
        assert not pkg.get(field), f"cli/package.json must not declare {field}"
    for hook in ("preinstall", "install", "postinstall", "prepare", "prepublish", "prepack", "postpack"):
        assert hook not in pkg.get("scripts", {}), f"cli/package.json must not run a {hook} script"
    assert not (CLI / "node_modules").exists()


def test_files_whitelist_is_strict() -> None:
    files = package()["files"]
    assert files == ["bin/agent-kit.mjs", "src/"], f"unexpected files whitelist {files}"
    for entry in files:
        assert (CLI / entry).exists(), f"cli/{entry} is whitelisted but missing"
    # Only code under src/: no kit files bundled into the tarball (ADR 0001).
    for path in (CLI / "src").rglob("*"):
        assert path.is_dir() or path.suffix == ".mjs", f"cli/src/ holds a non-code file: {path}"


def test_root_package_stays_private() -> None:
    root = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert root["private"] is True


def test_version_is_on_the_release_line_and_ahead_of_the_last_release() -> None:
    version = package()["version"]
    assert VERSION.match(version), f"cli/package.json version {version!r} is not a Release-line version"
    released = re.findall(r"^## \[(\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?)\]", CHANGELOG.read_text(encoding="utf-8"), re.M)
    assert released, "CHANGELOG.md has no released sections"
    # Between cuts, the package already carries the next tag's version; on a
    # cut, the newest CHANGELOG section is that same version.
    assert version == released[0] or _key(version) > _key(released[0]), (
        f"cli/package.json version {version} is behind the last release {released[0]}"
    )


def _key(version: str) -> tuple:
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$", version)
    assert m, version
    rank = {"alpha": 0, "beta": 1, "rc": 2, None: 3}[m[4]]
    return (int(m[1]), int(m[2]), int(m[3]), rank, int(m[5] or 0))


GIT_ID = ("-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false")


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(cwd), *GIT_ID, *args],
        check=True,
        capture_output=True,
    )


def test_cut_release_refuses_a_tag_the_package_version_does_not_match() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        _git(repo, "init", "-q")
        (repo / "cli").mkdir()
        package = repo / "cli" / "package.json"
        package.write_text('{"version": "1.0.0-alpha.12"}', encoding="utf-8")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-qm", "x")
        assert cli_version_mismatch("v1.0.0-alpha.12", repo) is None
        assert "does not match" in cli_version_mismatch("v1.0.0-alpha.13", repo)
        # The tag is cut from HEAD: an uncommitted bump is not in it.
        package.write_text('{"version": "1.0.0-alpha.13"}', encoding="utf-8")
        assert "does not match" in cli_version_mismatch("v1.0.0-alpha.13", repo)
        assert "uncommitted" in cli_version_mismatch("v1.0.0-alpha.12", repo)
    text = CUT.read_text(encoding="utf-8")
    assert "cli_version_mismatch(tag)" in text, "cut-release.sh must check the CLI version before tagging"
    assert text.index("cli_version_mismatch(tag)") < text.index('git tag -a "$TAG"')
    # Arguments reach the embedded Python through the environment only.
    assert "<<'PY'" in text and 'tag = "$TAG"' not in text


def test_publish_workflow_uses_trusted_publishing() -> None:
    wf = publish_workflow()
    assert wf["on"] == {"push": {"tags": ["v*"]}}, "publish only on Release tags"
    assert wf["permissions"] == {}, "no default permissions"
    (job,) = wf["jobs"].values()
    assert job["environment"] == "npm", "publish behind the protected npm environment"
    assert job["permissions"] == {"contents": "read", "id-token": "write"}
    runs = "\n".join(step.get("run", "") for step in job["steps"])
    assert "npm publish --provenance --access public" in runs
    assert re.search(r'"v\$version" != "\$TAG"', runs), "check the tag equals the package version before publishing"
    for step in job["steps"]:
        if "uses" in step:
            assert re.match(r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$", step["uses"]), step["uses"]
        if "actions/checkout" in step.get("uses", ""):
            assert step["with"]["persist-credentials"] is False
    # Publish only commits that are on main, checked before the publish step.
    names = [step.get("name", "") for step in job["steps"]]
    ancestry = names.index("Check the tagged commit is on main")
    assert ancestry < names.index("Publish")
    assert 'git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main' in runs


def test_publish_workflow_stores_no_token() -> None:
    text = PUBLISH.read_text(encoding="utf-8")
    assert "secrets." not in text, "trusted publishing needs no stored secret"
    assert "NPM_TOKEN" not in text
    assert "NODE_AUTH_TOKEN" not in text
    assert "${{ github.ref_name }}" not in "\n".join(
        line for line in text.splitlines() if line.strip().startswith(("run:", "echo", "if "))
    ), "pass the tag through env:, never interpolate it into a script"


def test_release_snapshot_ships_the_cli_and_its_workflow() -> None:
    entries = {line.strip() for line in SNAPSHOT.read_text(encoding="utf-8").splitlines() if line.strip()}
    for path in (".github/workflows/publish-cli.yml", "cli/package.json", "cli/bin/agent-kit.mjs", "cli/src/"):
        assert path in entries, f"release-snapshot-manifest.txt must list {path}"


def test_cutting_releases_documents_the_manual_first_publish() -> None:
    text = (ROOT / "docs" / "cutting-releases.md").read_text(encoding="utf-8")
    assert "## Publishing the CLI to npm" in text
    section = text.split("## Publishing the CLI to npm", 1)[1].split("\n## ", 1)[0]
    for phrase in (
        "npm login",
        "npm logout",
        "trusted publish",
        "`npm` environment",
        "required reviewer",
        "Prevent self-review",
        "Allow administrators to bypass",
        "Allowed actions",
        "2 days",
        "--provenance",
    ):
        assert phrase.lower() in section.lower(), f"cutting-releases.md npm section must mention {phrase!r}"
    # The first publish uses the maintainer's own login: no access token is created or stored.
    assert "_authToken" not in section, "the first publish must not write an npm token to a file"
    # A manual publish outside CI must turn off the provenance publishConfig asks for, or npm stops with EUSAGE.
    assert "publishConfig" in json.dumps(package()) and package()["publishConfig"].get("provenance") is True
    assert "npm publish --access public --tag latest --provenance=false" in section, (
        "the manual first publish must pass --provenance=false"
    )
    # npm waits for browser 2FA only on a real console; Git Bash's mintty gives it pipes.
    for phrase in ("winpty", "real console", "npm stage publish"):
        assert phrase.lower() in section.lower(), f"cutting-releases.md npm section must mention {phrase!r}"


if __name__ == "__main__":
    test_package_shape()
    test_package_has_no_runtime_dependencies_or_install_scripts()
    test_files_whitelist_is_strict()
    test_root_package_stays_private()
    test_version_is_on_the_release_line_and_ahead_of_the_last_release()
    test_cut_release_refuses_a_tag_the_package_version_does_not_match()
    test_publish_workflow_uses_trusted_publishing()
    test_publish_workflow_stores_no_token()
    test_release_snapshot_ships_the_cli_and_its_workflow()
    test_cutting_releases_documents_the_manual_first_publish()
    print("cli-package contract: ok")
