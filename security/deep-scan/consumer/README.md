# Fixture Consumer repository

Test-only. The fixture driver (`../drive.mjs`) copies this folder into a scratch folder, renames each `dot-` prefix to `.`, makes it a git repository and runs the CLI's `init`, `upgrade` and `doctor` in it. The `dot-` names keep this repository's own tools from reading the fixture as this repository's `.github` or `.security`.
