"""Contract test: the `setup_commands` presets stay plain bash and the docs list each one.

Each file under `examples/setup-presets/` is the single source for one preset: the
docs link it, and the future `init --preset` inlines it verbatim into a Caller's
`setup_commands: |` block. That block runs as one `shell: bash` step, so a preset
must be plain bash: no `uses:` (an action cannot run inside a shell step) and no
`${{ }}` (it would be evaluated in the Caller's workflow, not left as shell).
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRESETS_DIR = ROOT / "examples" / "setup-presets"
GETTING_STARTED = ROOT / "docs" / "getting-started.md"
CALLER_EXAMPLE = ROOT / "examples" / "plan-implement-review-caller.yml"
MANIFEST = ROOT / "scripts" / "release-snapshot-manifest.txt"

REQUIRED_PRESETS = {"python.sh", "node.sh", "mixed.sh"}
USES_LINE = re.compile(r"^\s*(?:-\s*)?uses\s*:", re.MULTILINE)


def presets() -> list[Path]:
    return sorted(PRESETS_DIR.glob("*.sh"))


def test_required_presets_exist() -> None:
    names = {path.name for path in presets()}
    missing = REQUIRED_PRESETS - names
    assert not missing, f"missing presets in examples/setup-presets/: {sorted(missing)}"
    services = [path for path in presets() if "docker run" in path.read_text(encoding="utf-8")]
    assert services, "no service-container preset (one that starts a container with `docker run`)"


def test_every_preset_is_plain_bash() -> None:
    for path in presets():
        raw = path.read_bytes()
        text = raw.decode("utf-8")
        name = path.name
        assert text.startswith("#!/usr/bin/env bash\n"), f"{name}: must start with a bash shebang"
        assert b"\r" not in raw, f"{name}: CRLF line endings break bash on the runner"
        assert not USES_LINE.search(text), f"{name}: `uses:` cannot run inside the setup_commands shell step"
        assert "${{" not in text, f"{name}: `${{{{ }}}}` would be evaluated in the Caller's workflow"
        assert "set -euo pipefail" in text, f"{name}: must fail fast with `set -euo pipefail`"


def test_presets_never_download_a_toolchain() -> None:
    # Versions come from the runner tool cache, not a download or a setup action.
    # Comment lines may name the setup actions to explain why they aren't used.
    for path in presets():
        lines = path.read_text(encoding="utf-8").splitlines()
        text = "\n".join(line for line in lines if not line.lstrip().startswith("#"))
        for banned in ("curl ", "wget ", "setup-python", "setup-node", "pyenv install", "nvm install"):
            assert banned not in text, f"{path.name}: uses `{banned.strip()}`; pick a version from the tool cache"


def test_presets_are_safe_to_inline_into_a_yaml_block() -> None:
    # `init --preset` indents each line under `setup_commands: |`; a heredoc's
    # terminator would then no longer start its line.
    for path in presets():
        assert "<<" not in path.read_text(encoding="utf-8"), f"{path.name}: no heredocs"


def test_docs_list_every_preset() -> None:
    getting_started = GETTING_STARTED.read_text(encoding="utf-8")
    caller = CALLER_EXAMPLE.read_text(encoding="utf-8")
    for path in presets():
        link = f"../examples/setup-presets/{path.name}"
        assert link in getting_started, f"docs/getting-started.md does not link {link}"
        assert path.name in caller, f"{CALLER_EXAMPLE.name} comments do not list {path.name}"


def test_docs_explain_shell_step_tool_cache_and_scanners() -> None:
    getting_started = GETTING_STARTED.read_text(encoding="utf-8")
    caller = CALLER_EXAMPLE.read_text(encoding="utf-8")
    for doc_name, text in (("getting-started.md", getting_started), (CALLER_EXAMPLE.name, caller)):
        assert "setup-python" in text, f"{doc_name}: must say setup actions can't run in setup_commands"
        assert "/opt/hostedtoolcache" in text, f"{doc_name}: must give the tool-cache recipe"
        assert "$GITHUB_PATH" in text, f"{doc_name}: must give the $GITHUB_PATH recipe"
        # The note names the variable but never assigns it a value: a literal
        # password assignment here would itself set off the scanner it warns about.
        assert "DATABASE_PASSWORD" in text, f"{doc_name}: must carry the secret-scanner note"
        assert "secret scanner" in text, f"{doc_name}: must carry the secret-scanner note"
        assert not re.search(r"PASSWORD\s*[=:]", text), f"{doc_name}: never write a password assignment"


def test_manifest_lists_every_preset() -> None:
    entries = {line.strip() for line in MANIFEST.read_text(encoding="utf-8").splitlines()}
    for path in presets():
        entry = f"examples/setup-presets/{path.name}"
        assert entry in entries, f"release-snapshot-manifest.txt does not list {entry}"


if __name__ == "__main__":
    test_required_presets_exist()
    test_every_preset_is_plain_bash()
    test_presets_never_download_a_toolchain()
    test_presets_are_safe_to_inline_into_a_yaml_block()
    test_docs_list_every_preset()
    test_docs_explain_shell_step_tool_cache_and_scanners()
    test_manifest_lists_every_preset()
    print("setup-presets contract: OK")
