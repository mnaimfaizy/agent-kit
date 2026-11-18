# Which sandbox environments can host a deep scan, and what isolation each guarantees

Research for [#333](https://github.com/mnaimfaizy/agent-kit/issues/333), child of map [#332](https://github.com/mnaimfaizy/agent-kit/issues/332) (Deep scan: sandboxed dynamic security audit). Sources read on 2026-11-19. Every claim cites the vendor page that owns it. This note compares options; it does not pick one (that is ticket #337's call).

## Context

Today's `security-audit` runs headless in GitHub Actions with Read/Glob/Grep/Write and no Bash (header of `.github/workflows/security-audit-reusable.yml`). A deep scan builds, runs and probes the Consumer's own code, so it needs Bash-equivalent execution inside a boundary that (a) contains a hostile target, (b) stops the target and the agent from reaching anything but an allowlist, and (c) is destroyed after the run.

## Comparison

| Option | Isolation boundary | Default-deny network + allowlist | State destruction | Cost (who pays, roughly) | Consumer setup burden |
| --- | --- | --- | --- | --- | --- |
| **Plain Docker container** (local or in CI) | Process: kernel namespaces and cgroups, shared host kernel; daemon runs as root by default [D1] | Deny-all yes: `--network none` gives only loopback [D2]; `--internal` networks reach only each other, but the gateway IP and host can still be reached [D3]. No built-in hostname allowlist; needs a proxy you run | `docker run --rm` / remove container; host persists | Consumer's own machine or runner minutes | Docker installed; trust whoever controls the daemon [D1] |
| **Docker + gVisor (`runsc`)** | User-space application kernel intercepts syscalls; does not pass them to the host kernel [G1] | Same Docker network options as above | Same as Docker | Free (open source); slower on syscall-heavy loads, some syscalls and `/proc`//`/sys` files missing [G1] | Install `runsc`, `sudo runsc install`, restart Docker, run with `--runtime=runsc` [G2]; needs root on the host |
| **Kata Containers** (QEMU, Cloud Hypervisor, Firecracker...) | Lightweight VM per pod with its own guest kernel; hardware virtualisation as "a second layer of defence" [K1]; Firecracker is one supported hypervisor [K2] | Container network configured by the host runtime; no built-in allowlist found | VM torn down with the pod | Free (open source) | Linux host with a supported hypervisor; container runtime config. Heavy for a local Consumer |
| **Firecracker microVM directly** | KVM microVM, 5 emulated devices, jailer as a second line of defence [F1] | Whatever the host gives the tap device; no built-in allowlist | Kill VM, delete rootfs | Free (open source) | Linux KVM host, x86-64/Arm with hardware virtualisation, kernel 4.14+ [F1]. Most work of all options |
| **Docker Sandboxes** (`sbx`, local) | microVM, "Full (hypervisor)" isolation, its own Docker daemon [S1] | Deny-by-default outbound TCP; default allowlist includes broad wildcards; UDP and ICMP blocked [S2]. All TCP goes through a host proxy that enforces policy [S1] | `sbx rm` deletes the sandbox, its VM and contents, except a directly mounted workspace, which lives on the host [S1] | Local free to run; cloud sandboxes are pay-as-you-go; org policy management is a paid subscription [S3] | Install `sbx` CLI and sign in; "supported hardware" [S3] |
| **Ephemeral GitHub-hosted runner** (standard) | Full VM per job; `ubuntu-slim` 1-vCPU runners are a container on a shared VM [A1]. Passwordless `sudo` inside [A2] | None by default: only an `/etc/hosts` blocklist of mining/malicious sites [A1]. Shared, weekly-changing IP ranges, not recommended for allowlisting [A2]. Job `container.options` cannot set `--network` [A3], but a step can still `docker run --network none` | New VM per job [A1]; the docs state decommissioning explicitly only for `ubuntu-slim` [A2] | Free in public repos; private repos draw on included allowance, then $0.006/min Linux 2-core [A4] | None beyond a workflow. KVM is usable on 2-vCPU+ Linux runners after a udev step [A5], so gVisor, Kata or Firecracker can nest inside the job |
| **GitHub runner + Harden-Runner** (StepSecurity) | Same VM | `egress-policy: block` with `allowed-endpoints`; full support on GitHub-hosted Linux, macOS, Windows [H1] | Same VM | Community tier for public repos; Enterprise tier for private [H1] | One action as the first step of each job [H1]. Third-party action in the trust path |
| **GitHub larger runner + Azure private networking** | Same VM, NIC in the Consumer's Azure VNET [A6] | Yes: NSG/firewall outbound rules apply to the runner [A6] | Same VM | Larger runners are billed even in public repos [A4]; plus the Consumer's Azure resources | Azure subscription, VNET/subnet in a supported region, larger runners only [A6]. Highest org burden |
| **Copilot coding agent firewall** (reference point only) | Actions runner or cloud sandbox | Default firewall with an allowlist, but only for processes started through the agent's Bash tool, not setup steps; "not ... a comprehensive security solution" [C1] | Per run | Copilot plan | Not available to arbitrary workflows as far as the docs say [C1] |
| **Claude Managed Agents, cloud environment** | Fresh Linux container per session; sessions do not share filesystem state [M1]. The docs say Anthropic secures "multitenant isolation" [M3] but do not name the technology | `limited` networking with nothing allowed is deny-all; `allowed_hosts` adds hosts; package-manager and MCP hosts are separate switches. Omitting `networking` in an API create gives `unrestricted` [M1]. Grants are per host, not per operation (an allowed host can receive uploads) [M1] | Deleting a session deletes its record, events and sandbox [M2]. Transcripts persist until deleted; not ZDR-eligible [M1] | $0.08 per running session-hour plus tokens; no separate container charge [P1] | Anthropic API key and beta header; code leaves the Consumer's infra to Anthropic |
| **Claude Managed Agents, self-hosted sandbox** | Whatever the Consumer builds; "Anthropic's security boundary stops at the sandbox" [M3] | Consumer's VPC/firewall rules [M3] | Consumer's job, including leftover memory copies [M3] | Consumer's compute plus tokens | Write and run a worker, hold an environment service key [M3] |
| **Claude Code sandboxed Bash** (local, for comparison) | bubblewrap (Linux/WSL2) or Seatbelt (macOS); covers shell commands and their children, not hooks or MCP servers [CC1] | Separate network namespace; proxy checks hostnames; allowlist starts empty; non-TCP can't leave; TLS not inspected [CC1] | None: works in the real working directory, reads most of the disk [CC1] | Free with Claude Code | Off by default; unsandboxed on native Windows; escape hatches (`excludedCommands`, unsandboxed retries) [CC1] |

## Key trade-offs

- **Boundary strength.** Plain containers share the host kernel [D1]. gVisor [G1], Kata [K1], Firecracker [F1] and Docker Sandboxes [S1] each put a second kernel or a hypervisor between the target and the host. A GitHub-hosted runner is itself a fresh VM [A1], which bounds the blast radius to that VM even if the inner container is weak.
- **Default-deny with an allowlist is rare out of the box.** Docker gives deny-all (`--network none`) but no hostname allowlist [D2]. The options with a real allowlist are Docker Sandboxes [S2], Managed Agents `limited` [M1], Harden-Runner [H1], Azure VNET NSGs [A6] and Claude Code's sandbox proxy [CC1]. A plain GitHub-hosted runner has none [A1]. A deep scan that needs no network after the build could avoid the allowlist problem by building first, then running the probe phase under `--network none`.
- **Allowlists are per host, not per operation.** Managed Agents says so explicitly: an allowed host can receive uploads, so a prompt-injected agent can exfiltrate through it [M1]. Claude Code's proxy does not inspect TLS [CC1]. This matters for keeping evidence on the Private delivery path.
- **State destruction.** Strongest when the whole VM goes: GitHub-hosted runners (new VM per job) [A1], `sbx rm` [S1]. Managed Agents destroys the sandbox on session delete, but transcripts stay with Anthropic until deleted [M1][M2]. Local Docker leaves the host and any mounted workspace untouched [S1].
- **Cost.** Public-repo Consumers pay nothing for standard GitHub runners [A4]; larger runners (needed for Azure VNET) are always billed [A4]. Managed Agents adds $0.08/session-hour on top of tokens [P1]. Local options cost only the Consumer's machine.
- **Setup burden runs opposite to strength on a laptop.** A GitHub workflow is near-zero setup and can nest gVisor or a KVM microVM because KVM is exposed [A5]. Local gVisor, Kata or Firecracker need root and Linux KVM [G2][F1]; Docker Sandboxes needs its CLI and sign-in [S3].
- **Data leaving the Consumer.** Anthropic-hosted sandboxes move the Consumer's code and run evidence to Anthropic's infrastructure and are not ZDR-eligible [M1]; self-hosted Managed Agents keeps content in the Consumer's environment [M3].

## Gaps and open points

- GitHub's docs do not state in so many words that a standard runner VM is destroyed after the job; they say each runner is a new VM [A1] and state decommissioning only for `ubuntu-slim` [A2].
- Anthropic's docs do not name the isolation technology behind cloud sandboxes [M1][M3].
- Docker Sandboxes' pages read here do not list host OS or hardware requirements [S1][S3].
- Harden-Runner's docs did not say whether the Community tier is free or whether block mode covers traffic from containers started inside the job [H1].
- Not read: per-vendor cloud sandboxes such as E2B (its docs landing page describes "a fast, secure Linux VM created on demand" but not the isolation tech or network controls [E1]).

## Sources

- [D1] Docker, Docker Engine security: https://docs.docker.com/engine/security/
- [D2] Docker, None network driver: https://docs.docker.com/engine/network/drivers/none/
- [D3] Docker, `docker network create` (`--internal`): https://docs.docker.com/reference/cli/docker/network/create/
- [G1] gVisor, What is gVisor: https://gvisor.dev/docs/
- [G2] gVisor, Docker quick start: https://gvisor.dev/docs/user_guide/quick_start/docker/
- [K1] Kata Containers, architecture: https://github.com/kata-containers/kata-containers/blob/main/docs/design/architecture/README.md
- [K2] Kata Containers, hypervisors: https://github.com/kata-containers/kata-containers/blob/main/docs/hypervisors.md
- [F1] Firecracker: https://firecracker-microvm.github.io/
- [S1] Docker Sandboxes, architecture: https://docs.docker.com/ai/sandboxes/architecture/
- [S2] Docker Sandboxes, security: https://docs.docker.com/ai/sandboxes/security/
- [S3] Docker Sandboxes, overview: https://docs.docker.com/ai/sandboxes/
- [A1] GitHub, GitHub-hosted runners (concepts): https://docs.github.com/en/actions/concepts/runners/github-hosted-runners
- [A2] GitHub, GitHub-hosted runners reference: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- [A3] GitHub, Running jobs in a container: https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/run-jobs-in-a-container
- [A4] GitHub, Actions billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- [A5] GitHub changelog, hardware-accelerated Android virtualization (KVM on 2-vCPU Linux runners), 2024-04-02: https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/
- [A6] GitHub, Azure private networking for GitHub-hosted runners: https://docs.github.com/en/organizations/managing-organization-settings/about-azure-private-networking-for-github-hosted-runners-in-your-organization
- [H1] StepSecurity, Harden-Runner: https://docs.stepsecurity.io/harden-runner
- [C1] GitHub, Customize the Copilot coding agent firewall: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall
- [M1] Anthropic, Managed Agents cloud environment setup: https://platform.claude.com/docs/en/managed-agents/environments
- [M2] Anthropic, Secure your Managed Agents deployment: https://platform.claude.com/docs/en/managed-agents/secure-deployment
- [M3] Anthropic, Self-hosted sandboxes security model: https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-security
- [P1] Anthropic, Pricing (Managed Agents session runtime): https://platform.claude.com/docs/en/about-claude/pricing
- [CC1] Claude Code, Sandboxing: https://code.claude.com/docs/en/sandboxing
- [E1] E2B docs: https://docs.e2b.dev/
