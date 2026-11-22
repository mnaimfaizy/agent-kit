---
status: proposed
---

# A Stage's Guards are reached by the Launcher's sandbox, and no agent holds a GitHub write credential

On the Launcher path ([ADR 0024](0024-every-stage-runs-through-agent-kits-launcher.md)), what a Stage may touch is decided by a sandbox the Launcher builds around the harness, the same on every harness. A harness's own hooks, policies and approvals are defence in depth: an adapter may add them, but no Stage's safety depends on them. Claude Code's `PreToolUse` hooks do not port (Codex, Gemini and Cursor hooks fail open, a Gemini checkout can disable a system hook, Codex has no Read tool), and a hook on the file tools never confined the shell: plan, review and security audit were safe only because Bash was off.

A **Guard** is an outcome a Stage requires, stated without naming how it is reached. Every Stage requires all six:

| Guard | plan | implement | review | review response | security audit | Deep scan |
|---|---|---|---|---|---|---|
| Reads stay in the workspace, by any tool including the shell | yes | yes | yes | yes | yes | yes |
| Writes | none | working tree | none | working tree | none | none |
| The agent holds no GitHub write credential | yes | yes | yes | yes | yes | yes |
| The real model key and the Launcher's process are out of reach | yes | yes | yes | yes | yes | yes |
| The checkout's harness config is not loaded | yes | yes | yes | yes | yes | yes |
| The network reaches only the model proxy | yes | yes | yes | yes | yes | yes |

How they are reached:

- **The sandbox.** Every Stage runs its harness in the Deep scan's Docker sandbox: one driver, an internal network with no route out, a relay to the model proxy, and the host-side probes that confirm the cut before the agent starts. In CI the runtime is gVisor. The Launcher and the proxy run on the runner, outside it, so the real key lives only in the proxy's process and the sandbox holds a placeholder. On a maintainer's machine the Guards are the same and the runtime rule is the Deep scan's ([ADR 0018](0018-a-deep-scan-runs-locally-by-default.md)): refused without an accepted runtime, with no override.
- **In and out.** The checkout is copied in, never mounted. Two things come out: a result file, as data, and, for implement and review response, a git bundle. A trusted step validates the bundle under [ADR 0005](0005-review-responder-holds-no-write-credential.md)'s rules, checks it for workflow files, local actions and protected paths, and pushes it. So the implementer no longer pushes inside its session, and the check runs before the push instead of having to be a hook.
- **Checkout config.** Instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, the skill) reach the agent only from the trusted commit. Executable harness config (settings, hooks, MCP servers, permissions, `.env`, `.cursor/sandbox.json`) is loaded from no commit: the Launcher removes each adapter's declared list of such paths from the copy and writes the harness's config itself.
- **Environment.** The sandbox's environment is built from a fixed allowlist (the placeholder key, the proxy address, what the adapter names). Nothing is inherited from the runner, so the job token and the OIDC request variables never enter.
- **Setup.** The Caller's `setup_commands` run inside the sandbox before the cut, with egress only to registries the Caller declares. Implement and review response gain two Caller inputs beside `setup_commands`: a sandbox image for the Consumer's toolchain, and that registry list. The defaults are a kit-pinned image and no registries. Plan, review and security audit always use the kit image.

**Refusal.** Each adapter declares how it reaches each Guard, and a contract test probes it. The Launcher's preflight refuses, before the agent starts, any Stage whose adapter cannot reach every Guard that Stage requires. There is no Consumer override.

**A harness the model proxy cannot front** (Cursor CLI first) reaches the key and network Guards in a fixed weaker form, on plan, implement and review only: egress goes only to the vendor's hosts through the Launcher's allowlist proxy, the vendor key sits in the sandbox, and the Launcher refuses a result or bundle that contains the key. It is refused for review response, which runs pull request code beside the key, and for security audit and Deep scan ([ADR 0023](0023-a-deep-scan-runs-only-on-a-harness-a-model-proxy-can-front.md)). This is a rule of the kit, not a setting.

Decided in [Trust enforcement on every harness](https://github.com/mnaimfaizy/agent-kit/issues/444), on the map [Wayfinder: Stages run on a Consumer-chosen harness](https://github.com/mnaimfaizy/agent-kit/issues/438).

## Considered Options

- **The harness's own controls as the boundary.** Rejected. Each harness would have a different mechanism and a different failure mode, and three of the five fail open.
- **Both required: the sandbox and a native gate the agent cannot tamper with.** Rejected. opencode has no OS sandbox and Cursor's managed hooks are unconfirmed off an Enterprise plan, so it would refuse harnesses the sandbox already confines.
- **bubblewrap or a separate Unix user on the runner.** Rejected. Neither gives a network cut as strong as the Deep scan's, and either is a second mechanism to prove.
- **runc for Stages that run no pull request code.** Rejected. It is faster, but it means two runtimes, and an injected agent with a shell would share a kernel with the host that holds the key.
- **A bind mount of the checkout.** Rejected. The agent could change the runner's checkout, including the `.git/config` that later trusted steps read.
- **In-session push kept for Claude Code.** Rejected. It keeps two trust models, and the push guard hook exists only because the agent pushes before any later step can check.
- **The network cut only where untrusted code runs** (review response, Deep scan). Rejected. A harness with a shell on a read-only Stage could send a private repository's contents out after a prompt injection.
- **A warning and an opt-in input for a harness that misses a Guard.** Rejected. A Consumer's setting would remove a guarantee the kit states.
- **Setup on the runner, its result copied in.** Rejected. It keeps pull request and dependency code on the runner, now beside the Launcher's real key.
- **A Consumer-owned file for the image and registries**, like the Scan recipe. Rejected. It is a second place to configure a Stage, against [ADR 0009](0009-stage-settings-resolve-in-the-caller.md).
- **Refusing a proxy-less harness for every Stage.** Rejected. Cursor CLI is a target harness, and its key can make model requests and nothing else.

## Consequences

- **Implement's commands lose the network.** A test that calls out fails. The Caller's setup has to fetch what the checks need.
- **gVisor slows builds and tests** in implement and review response.
- **ADR 0005's residual exposure narrows on the Launcher path.** Setup and pull request code no longer run on the runner beside the model credential. ADR 0005 itself stands: it describes the `claude-code-action` path.
- **The transitional path is unchanged.** A Stage still on `claude-code-action` keeps today's hooks, bubblewrap and environment scrub. The three hooks and two settings files in `.github/agent-runtime/` retire from a Stage when it leaves the action; `review-threads.mjs` and `check-git-config.mjs` stay.
- **A proxy-less harness's key can still leak encoded** in a commit or a result, past the Launcher's check. The exposure is of the same kind ADR 0005 accepts for the subscription token.
- **Tool allowlists stop being a Guard.** What becomes of `extra_allowed_tools` and the per-Stage tool lists is decided in [Harness adapter contract](https://github.com/mnaimfaizy/agent-kit/issues/447).
- **The agent cannot comment or open a pull request itself.** How progress comments, the pull request and inline review comments happen without an agent-held credential is decided in [GitHub layer for non-Claude Stages](https://github.com/mnaimfaizy/agent-kit/issues/449).
