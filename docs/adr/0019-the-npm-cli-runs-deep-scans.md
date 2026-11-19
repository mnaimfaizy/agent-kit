---
status: proposed
---

# The npm CLI runs deep scans

[ADR 0001](0001-distribute-the-cli-via-npm.md) framed `@mnaimfaizy/agent-kit` as an adoption CLI: `init`, `upgrade` and `doctor` write local files and print `gh` commands. The CLI now also takes a run-time job, `agent-kit deep-scan`, the host-side launcher for a **Deep scan**. It reads the **Scan recipe**, chooses and starts an accepted sandbox runtime or refuses, runs the key-injecting model-API proxy, copies the repository in and the report out, enforces the time and token limits, and tears the sandbox down. The CI deep-scan workflow calls the same subcommand on the runner, so both paths share one implementation.

Recorded in [#346](https://github.com/mnaimfaizy/agent-kit/issues/346), on the wayfinder map [#332](https://github.com/mnaimfaizy/agent-kit/issues/332), and specified in [#362](https://github.com/mnaimfaizy/agent-kit/issues/362).

The proxy, the runtime check and the teardown are security-critical code. They need one tested home that is versioned and published with provenance, and the CLI is already that home. ADR 0001's rule of no npm runtime dependencies still holds: Node core is enough for the proxy and for driving the runtimes' own command-line tools.

## Considered Options

- **A launcher script copied inside the `security-audit` skill.** Rejected. Security-critical code would then live in every Consumer's copy of the skill, with no one tested home.
- **Steps a human follows by hand.** Rejected for the same reason. A missed step, such as forwarding the real key or mounting the workspace, fails open.

## Consequences

- **The CLI now handles a secret.** The real model credential is read from the launcher's environment or a secret manager (the 1Password CLI is a named, supported option). It lives only in the proxy process's memory and never enters the sandbox or touches disk.
- **The CLI now starts processes and containers.** It is no longer true that it writes only local files. `init`, `upgrade` and `doctor` are unchanged, and only `deep-scan` runs anything.
- **The CLI's tests gain a launcher suite**, run against fake runtimes and a fake model API, beside the existing `init`, `upgrade` and `doctor` contract tests.
- **Running `deep` from an ordinary Claude Code session on the host never scans from the host.** The skill points to the launcher instead.
