"""Contract test: CI installs lychee from a pinned, checksum-verified download that retries.

lycheeverse/lychee-action downloaded lychee with one curl call and no retry,
which failed intermittently on GitHub-hosted runners (curl exit code 22). Both
link-check workflows now run scripts/install-lychee.sh instead.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "scripts" / "install-lychee.sh"
WORKFLOWS = [ROOT / ".github" / "workflows" / name for name in ("ci.yml", "links.yml")]


def test_installer_pins_version_and_checksum() -> None:
    text = INSTALLER.read_text(encoding="utf-8")
    assert re.search(r'^LYCHEE_VERSION="\d+\.\d+\.\d+"$', text, re.MULTILINE), "pin an exact lychee version"
    assert re.search(r'^LYCHEE_SHA256="[0-9a-f]{64}"$', text, re.MULTILINE), "pin the archive's SHA-256"
    # Verify before extracting: the check must come before tar.
    check = text.find("sha256sum --check --strict")
    extract = text.find("tar -xzf")
    assert check != -1 and extract != -1 and check < extract, "verify the archive before extracting it"


def test_installer_retries_transient_download_errors() -> None:
    text = INSTALLER.read_text(encoding="utf-8")
    for flag in ("--fail", "--retry ", "--retry-all-errors", "--retry-max-time"):
        assert flag in text, f"the download must use curl {flag.strip()}"


def test_installer_downloads_through_the_api_then_falls_back() -> None:
    # github.com's release download path has returned 504 for minutes while api.github.com worked.
    text = INSTALLER.read_text(encoding="utf-8")
    assert re.search(r'^LYCHEE_ASSET_ID="\d+"$', text, re.MULTILINE), "pin the release asset id"
    assert "https://api.github.com/repos/lycheeverse/lychee/releases/assets/" in text
    assert "https://github.com/lycheeverse/lychee/releases/download/" in text
    api = text.find("if download_via_api")
    web = text.find("elif download_via_web")
    assert api != -1 and web != -1 and api < web, "try the API first, then fall back to github.com"
    # The token goes to curl on stdin (--config -), never on its command line.
    assert "--config -" in text
    assert not re.search(r"--header\s+\"?Authorization", text), "never pass the token as a curl argument"


def test_link_workflows_pass_only_the_job_token_to_the_installer() -> None:
    for workflow in WORKFLOWS:
        text = workflow.read_text(encoding="utf-8")
        assert "GH_TOKEN: ${{ github.token }}" in text, f"{workflow.name}: give the installer the job token"
        assert "secrets." not in text.split("bash scripts/install-lychee.sh", 1)[0].rsplit("- name:", 1)[1], (
            f"{workflow.name}: the install step needs no secret beyond the job token"
        )


def test_installer_is_text_and_strict() -> None:
    raw = INSTALLER.read_bytes()
    assert b"\r" not in raw, "LF line endings only; CRLF breaks bash on the runner"
    assert "set -euo pipefail" in raw.decode("utf-8")


def test_link_workflows_use_the_installer_not_the_action() -> None:
    for workflow in WORKFLOWS:
        text = workflow.read_text(encoding="utf-8")
        assert "lycheeverse/lychee-action" not in text, f"{workflow.name}: use scripts/install-lychee.sh"
        assert "bash scripts/install-lychee.sh" in text, f"{workflow.name}: install lychee with the pinned script"
        install = text.find("bash scripts/install-lychee.sh")
        run = text.find("lychee --")
        assert run != -1 and install < run, f"{workflow.name}: install lychee before running it"


if __name__ == "__main__":
    test_installer_pins_version_and_checksum()
    test_installer_retries_transient_download_errors()
    test_installer_downloads_through_the_api_then_falls_back()
    test_link_workflows_pass_only_the_job_token_to_the_installer()
    test_installer_is_text_and_strict()
    test_link_workflows_use_the_installer_not_the_action()
    print("ci-tooling contract: ok")
