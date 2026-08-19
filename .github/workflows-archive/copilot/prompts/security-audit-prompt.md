# Copilot security-audit prompt (archive fork)

Run the portable security-audit contract in `full` or `pr` mode.

Rules:

- Keep severity floor at Medium.
- Deliver full findings privately through draft GHSA.
- Keep public comments counts-only.
- Never print finding bodies to public logs.
- No auto-fix loop from audit output.
