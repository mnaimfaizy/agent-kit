# Deep scan fixtures (test-only)

The shims and offline fixtures that Agent-kit's own [Scan recipe](../../.security/scan-recipe.yml) names, for the dogfood Deep scan ([#374](https://github.com/mnaimfaizy/agent-kit/issues/374)). They are test-only: nothing here ships in a Release tag, and none of it makes a network call or reads a real credential. Every value in them is fake.

Run one fixture with:

```sh
node security/deep-scan/drive.mjs <fixture>
```

The driver runs each crafted case against the real entry point and prints `ok`, `DIFF` (the entry point did not do what the case expects) or `skip` (this host cannot build the case) for each. It exits 1 when any case is `DIFF`. It prints the case's scratch folder (`Scratch:`, under `$DEEP_SCAN_FIXTURE_DIR` when set) with what each case built and what the shims recorded. Each child process gets a clean environment: no inherited token or proxy variable, a scratch `HOME`, and no system or global git config.

| Fixture             | Entry point                                            | Inputs                                              |
| ------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| `read-confinement`  | `.github/agent-runtime/confine-reads-to-workspace.mjs` | `hook-events/read-confinement.json`                 |
| `write-confinement` | `.github/agent-runtime/confine-writes-to-worktree.mjs` | `hook-events/write-confinement.json`                |
| `push-guard`        | `.github/agent-runtime/guard-implementer-push.mjs`     | `hook-events/push-guard.json`, a git workspace      |
| `git-config`        | `.github/agent-runtime/check-git-config.mjs`           | `git-configs/cases.json` and its `.gitconfig` files |
| `publish-advisory`  | `.github/security-audit/publish-draft-advisory.sh`     | crafted reports, the gh shim                        |
| `pr-comment`        | `.github/security-audit/comment-pr-counts.sh`          | the gh shim                                         |
| `notify-email`      | `.github/security-audit/notify-email.sh`               | the mail shim                                       |
| `cli-init`          | `cli/bin/agent-kit.mjs init`                           | `consumer/`, the tag-fetch sentinel                 |
| `cli-upgrade`       | `cli/bin/agent-kit.mjs upgrade`                        | `consumer/`, the tag-fetch sentinel                 |
| `cli-doctor`        | `cli/bin/agent-kit.mjs doctor`                         | `consumer/`, the tag-fetch sentinel, the gh shim    |

- **`shims/gh`** stands in for the GitHub CLI. It appends one JSON line per call to `$DEEP_SCAN_SHIM_LOG`: the arguments, stdin, and the names (never the values) of any token variables set. It answers the two calls the delivery scripts make (a draft advisory, a PR comment) with fake ids, and refuses anything else. `DEEP_SCAN_GH_FAIL=1` makes every call fail.
- **`shims/mail.mjs`** stands in for the mail server (the `sendmail` role). `notify-email.sh` sends mail from Python's `smtplib`, not a `sendmail` binary, so the shim is an SMTP server on `127.0.0.1`. It records each command, with any `AUTH` payload redacted, offers `STARTTLS` and `AUTH`, answers `STARTTLS` with 454 and accepts no message. A client that would log in without TLS shows up as an `AUTH` line.
- **The tag-fetch sentinel** (in `drive.mjs`): `init`, `upgrade` and `doctor` read a tag only from an `https://` git server, and that fetch stays static-only. The driver points `GITHUB_SERVER_URL` at a listener on `127.0.0.1` that records the connection and closes it, so a case shows whether the CLI got as far as the fetch. It serves no tag.
- **`consumer/`** is the crafted Consumer repository: a Caller pinned to one tag and an invalid Scan recipe. Its `dot-` prefixes become `.` when the driver copies it, so this repository's own tools never read it as this repository's `.github` or `.security`.

The tests in `scripts/deep-scan-dogfood-contract.test.mjs` run every fixture outside the sandbox. On Windows the driver skips the cases it cannot build there: symbolic links without the privilege, `notify-email` without a `python3`, and the `doctor` case that needs the gh shim, since the CLI would find a real `gh.exe` first.
