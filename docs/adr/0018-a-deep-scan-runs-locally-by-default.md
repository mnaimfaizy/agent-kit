---
status: proposed
---

# A deep scan runs locally by default

Today's static audit is CI-first. A **Deep scan** is the other way round: **local is the default** and **CI is an opt-in**. How the Consumer invokes it picks the path, and no setting chooses between them. Running it by hand starts a local scan through the `agent-kit deep-scan` launcher. Adopting the separate deep-scan reusable workflow opts into CI. On both paths Claude Code and the target run together in one disposable sandbox, and Agent-kit provides that sandbox: the image layering, the boundary, the network policy, the key-injecting proxy and the teardown. The Consumer supplies only a **Scan recipe** that says what to build and run.

Recorded in [#337](https://github.com/mnaimfaizy/agent-kit/issues/337), as corrected by [#338](https://github.com/mnaimfaizy/agent-kit/issues/338) and [#346](https://github.com/mnaimfaizy/agent-kit/issues/346), on the wayfinder map [#332](https://github.com/mnaimfaizy/agent-kit/issues/332), and specified in [#362](https://github.com/mnaimfaizy/agent-kit/issues/362).

This is the real trade-off: CI has the stronger destruction story at lower cost, because a fresh runner VM is thrown away after the job. Local stays the default anyway, and the local launcher is also the only home for a **Verification run**, which cannot run in CI because its input names a concept id that is private until release ([#358](https://github.com/mnaimfaizy/agent-kit/issues/358)).

## The local boundary rule

_The target never shares a kernel with the host OS or with the maintainer's other environments._ The launcher enforces this rule by starting only accepted runtimes, and it never trusts a check run inside the sandbox, which the target could fake.

- **Accepted:** Docker Sandboxes; Kata or Firecracker on Linux; gVisor on Linux (a user-space kernel, not hardware virtualization, accepted on purpose); Docker Desktop on macOS.
- **Refused:** plain Docker on a Linux host, which shares the host kernel; Docker Desktop on Windows with the WSL 2 backend, whose VM shares a kernel and network namespace with the user's other WSL distros.
- **No override.** A Consumer without an accepted runtime uses the CI path.

## Considered Options

- **CI first, like the static audit.** Rejected as the default, and kept as the opt-in.
- **The agent on the host driving a sandboxed target.** Rejected. Every probe, and every prompt injection in the target's output, would become a host command.
- **Claude Managed Agents as the host.** Rejected. The Consumer's code and transcripts would leave for Anthropic and persist, which breaks the rule that only the report leaves the sandbox.

## Consequences

- **In CI the runner holds only the proxy and the delivery steps.** The agent and target run together in a gVisor container on an ephemeral GitHub-hosted runner, the same shape as local. The job's `GITHUB_TOKEN` and the advisory token never enter the container.
- **A local run's residue is the maintainer's to trust.** The repository goes in as a copy, never a mount, because a mounted workspace survives teardown. Only the report comes out.
- **Consumers build habits on the local launcher.** Moving the default to CI later would change how every existing user starts a scan.
