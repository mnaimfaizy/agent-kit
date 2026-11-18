# How Claude Code runs sandboxed with Bash for a headless deep scan

Research for wayfinder ticket [#334](https://github.com/mnaimfaizy/agent-kit/issues/334) on map [#332](https://github.com/mnaimfaizy/agent-kit/issues/332): a deep, dynamic mode for the `security-audit` skill that builds, runs and probes a Consumer's own code inside a closed sandbox. Today's audit runs `claude -p` in GitHub Actions with Read/Glob/Grep/Write only and Bash in `--disallowedTools`, because a Bash prefix rule admitted writes outside the workspace ([`security-audit-reusable.yml`](../../.github/workflows/security-audit-reusable.yml) header; [threat model](../../security/threat-model.md), "Tool grant widening").

The question: what Claude Code itself offers for running an agent **with** Bash inside a sandbox, headless; what that sandbox isolates; what permission rules can and cannot hold; how the agent keeps reaching the model API while the code it runs has no egress; and what the agent's own credential is exposed to in each setup.

This note states facts and limits only. It recommends no design: that is tickets #337 and #338.

- **Read on:** 2026-11-19. Docs pages carry no publish date, so a fact from a docs page is dated by the read. Local CLI for reference: Claude Code 2.1.312.
- **Sources:** primary only.
  - Claude Code docs: [Sandboxing](https://code.claude.com/docs/en/sandboxing) (also read as [raw Markdown](https://code.claude.com/docs/en/sandboxing.md)), [Choose a sandbox environment](https://code.claude.com/docs/en/sandbox-environments), [Configure permissions](https://code.claude.com/docs/en/permissions), [Run Claude Code programmatically](https://code.claude.com/docs/en/headless) (`-p`), [Development containers](https://code.claude.com/docs/en/devcontainer), [Enterprise network configuration](https://code.claude.com/docs/en/network-config), [Securely deploying AI agents](https://code.claude.com/docs/en/agent-sdk/secure-deployment), [Authentication](https://code.claude.com/docs/en/authentication.md), [Environment variables](https://code.claude.com/docs/en/env-vars.md).
  - Source files: [`anthropics/claude-code/.devcontainer/init-firewall.sh`](https://github.com/anthropics/claude-code/blob/d945a61bc6346abce607252d5667df8a3bf0461a/.devcontainer/init-firewall.sh) at `d945a61`; [`anthropics/claude-code-action/docs/security.md`](https://github.com/anthropics/claude-code-action/blob/5a856893345e332afa621934082d8c660c26d689/docs/security.md) at `5a85689`.
- **Nothing was run** to test a claim. No sandbox, container or workflow was started.
- **INFERENCE** marks a conclusion drawn from two or more stated facts that no source states outright. **UNCONFIRMED** marks a point no source settles. Both are listed again at the end.

## 1. Three ways to put a boundary around Claude Code

The docs name three shapes, from narrowest to widest ([sandbox environments](https://code.claude.com/docs/en/sandbox-environments), "Compare sandboxing approaches"):

| Approach | What is inside the boundary | Needs Docker |
| :- | :- | :- |
| Built-in sandboxed Bash tool (`sandbox.enabled`) | Bash, PowerShell and Monitor commands and their child processes | No |
| Sandbox runtime (`srt claude`) | The whole Claude Code process: file tools, MCP servers, hooks, and shell commands | No |
| Dev container, custom container, VM | The whole environment | Container: yes |

"The sandboxed Bash tool on its own constrains only shell commands, so it is not sufficient for fully unattended runs" in bypass or auto mode; layering the Bash sandbox inside a container or VM is supported ([sandbox environments](https://code.claude.com/docs/en/sandbox-environments), "How isolation relates to permission modes").

The secure-deployment guide adds: "In all of these configurations, Claude Code (or your Agent SDK application) runs inside the isolation boundary" — the agent process is never outside it in that guide's designs ([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment), "Isolation technologies").

## 2. The built-in Bash sandbox

### What it isolates, and on which OSes

- Off by default; turned on with `/sandbox` or `sandbox.enabled: true` in a settings file. Built on the open-source [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) ([sandboxing](https://code.claude.com/docs/en/sandboxing), "What the sandbox restricts").
- **macOS:** Seatbelt. **Linux and WSL2:** bubblewrap plus `socat`. **Native Windows:** no sandbox; "Claude Code runs commands unsandboxed", use WSL2 ([sandboxing](https://code.claude.com/docs/en/sandboxing), "Get started", "OS-level enforcement"; [sandbox environments](https://code.claude.com/docs/en/sandbox-environments), "Sandboxed Bash tool").
- Defaults ([sandboxing](https://code.claude.com/docs/en/sandboxing), table under "What the sandbox restricts"):
  - **Writes:** the working directory, a per-user temp directory and added directories. Protected paths stay write-denied even inside them: `.claude` settings, skills, agents, commands and hooks, `.mcp.json`, shell startup files, `.gitconfig`, `.git/hooks` and `.git/config`, and in `~/.claude` "most of its contents, plus `~/.claude.json` and the `.credentials.json` credential store" ("Protected paths").
  - **Reads:** "Most of the machine, including credential files such as `~/.ssh` and `~/.aws/credentials`." Narrow with `filesystem.denyRead` or `credentials`. "There is no built-in credential deny list."
  - **Network:** "No direct route out." On Linux/WSL2 each command runs "in a separate network namespace that has no connection to your network"; on macOS Seatbelt blocks everything but the proxy connection. A proxy that Claude Code runs **outside** the sandbox checks each hostname against `allowedDomains`, which "start empty" ("Network isolation").
  - **Environment variables:** "Inherited from Claude Code, including any secrets in its environment."
- Tools that ignore `HTTP_PROXY`/`HTTPS_PROXY` (plain `ssh`, most database drivers) cannot connect even to an allowed host; UDP, QUIC and ICMP cannot leave ("Network isolation").
- Hostnames that resolve only to local addresses — loopback, link-local such as `169.254.169.254`, the machine's own addresses — are refused after passing the allowlist ("Hostnames that resolve to local addresses").
- On Linux/WSL2, "a sandboxed command's `localhost` is private to that command. The command can listen on a port and reach servers it started itself." A direct connection to `localhost` does not reach servers on the host ("A command fails to reach a server on localhost").

**What runs outside it** ([sandboxing](https://code.claude.com/docs/en/sandboxing), "What runs outside the sandbox"): Read, Edit, Write, WebFetch and WebSearch ("A `denyRead` entry doesn't stop the Read tool, and `allowedDomains` doesn't limit WebFetch"); command hooks, local MCP servers, plugin monitors, LSP servers, status line, `apiKeyHelper`; mods; commands matching `excludedCommands`; and unsandboxed retries.

### Settings that matter headless

- `failIfUnavailable: true` — exit at startup instead of silently running unsandboxed when the sandbox cannot start. Without it, "Claude Code runs commands without sandboxing" on an unsupported platform or failed dependency check ("Commands are refused with `Sandbox is required`" and settings list).
- `allowUnsandboxedCommands: false` — "strict sandbox mode": Claude Code ignores the `dangerouslyDisableSandbox` retry. Set in managed settings or via `--settings`, it makes the sandbox "admin-required", after which a repository's `.claude/settings.json` cannot loosen it, `excludedCommands` included ("Turn off the retry with strict sandbox mode").
- `network.strictAllowlist: true` (user, managed or `--settings` only; v2.1.219+) — refuse any host outside the allowlist instead of prompting ("Network isolation").
- `autoAllowBashIfSandboxed` — sandboxed commands run without a prompt; deny rules, critical-path `rm`, and content-scoped ask rules still apply ("Auto-allow mode").
- `credentials` — `deny` unsets named env vars before each sandboxed command and denies reads of named files; `mask` shows a sentinel and has the proxy substitute the real value on outbound requests to allowed hosts, which needs the experimental `network.tlsTerminate` ("Protect credentials", "Mask credentials").
- `httpProxyPort`/`socksProxyPort` — replace the built-in proxy with your own; then `allowedDomains`, `deniedDomains` and `strictAllowlist` "stop applying to that traffic" ("Custom proxy configuration").

### Documented limits ([sandboxing](https://code.claude.com/docs/en/sandboxing), "Limitations")

- "Sandboxing reduces risk but is not a complete isolation boundary."
- **No TLS inspection by default.** The proxy decides from the client-supplied hostname, so code inside "can potentially use domain fronting or similar techniques to reach hosts outside the allowlist"; broad entries such as `github.com` "can create paths for data exfiltration".
- **Unix sockets:** allowing e.g. `/var/run/docker.sock` "effectively grants access to the host system".
- **Broad write grants** to `$PATH` directories, system config or shell rc files can lead to code execution elsewhere.
- **`enableWeakerNestedSandbox`**, needed for bubblewrap in an unprivileged container, "considerably weakens security and should only be used when additional isolation is otherwise enforced" ("Bubblewrap fails to start inside a container").
- **`allowNestedUserNamespaces: true`** "turn[s] off a security boundary: code from a sandboxed command can end up running outside the sandbox."
- **`excludedCommands`** run with no filesystem or network limits; Claude "can write a script in the working directory and run it through an excluded pattern".
- Ubuntu's AppArmor restriction on unprivileged user namespaces can stop bubblewrap; until lifted, commands run unsandboxed, or Claude Code refuses to start with `failIfUnavailable` ("Ubuntu's AppArmor restriction stops bubblewrap").
- "Effective sandboxing requires both filesystem and network isolation" ("Scope").

## 3. Permission rules: what they hold and what they don't

- Bash rules match "the whole command text". Claude Code splits compound commands on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, and every part must be allowed ([permissions](https://code.claude.com/docs/en/permissions), "Compound commands").
- A fixed set of wrappers (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`) is stripped before matching. Environment runners (`npx`, `docker exec`, `devbox run`, `mise exec`, `direnv exec`) are **not**: `Bash(devbox run *)` also matches `devbox run rm -rf .` ("Wrappers").
- **A Bash rule is not a boundary around a program.** "It doesn't match the same program invoked in a different form, so a deny or ask rule covers the invocation Claude usually produces and isn't a security boundary around the program." The docs' own table: `Bash(curl *)` does not stop `/usr/bin/curl …` or `sh -c 'curl …'`; `Bash(rm *)` does not stop `/bin/rm …` or `bash -c 'rm …'`; `Bash(git push *)` does not stop `git -C . push …` or `git -c push.default=current push …` ("What a Bash rule doesn't match").
- "Bash permission patterns that try to constrain command arguments are fragile" — options before the URL, a different scheme, redirects, and variables all slip past `Bash(curl http://github.com/ *)`. "If Bash is allowed, Claude can still use `curl`, `wget`, or other tools to reach any URL" (warning under "Read-only commands").
- Read/Edit deny rules cover the built-in tools, recognised file commands (`cat`, `sed`, `tee` …) and redirect targets, but not "arbitrary subprocesses that read or write files indirectly, like a Python or Node script". "For OS-level enforcement that blocks all processes from accessing a path, enable the sandbox" ("What `Read` and `Edit` rules cover").
- `permissions.blockWritesOutsideWorkingDirectories` stops the Write/Edit tools in every mode, but "doesn't limit shell commands" ("Block file-tool reads and writes outside the working directories").
- Deny and ask rules win over a PreToolUse hook's `allow` ("Precedence among rules, hooks, and mods").
- The docs' stated answer to all of the above is the sandbox: "For filesystem and network enforcement that doesn't depend on the command text, use sandboxing" ("What a Bash rule doesn't match"). Permissions and sandbox are "complementary security layers … sandbox restrictions still apply even if a prompt injection bypasses Claude's decision-making" ("How permissions interact with sandboxing").
- `claude-code-action` says the same of its own deny list for untrusted pull requests: "This is a list of common commands, not a sandbox", and "Auto mode is a review, not a boundary" ([action security.md](https://github.com/anthropics/claude-code-action/blob/5a856893345e332afa621934082d8c660c26d689/docs/security.md), "Running code from pull requests", "Prompt Injection Risks").

## 4. Running headless

- `claude -p` with `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--settings`. Since v2.1.302 a `-p` run with no mode set starts in Manual mode, where "a call that needs approval is denied unless something approves it" (a `PermissionRequest` hook or `--permission-prompt-tool`) ([headless](https://code.claude.com/docs/en/headless), "Auto-approve tools").
- `dontAsk` denies everything that would prompt; `--permission-prompts none` (v2.1.259+) or `permissions.denyInsteadOfPrompting` denies prompts and tells Claude not to retry ("Turn off permission prompts in unattended runs").
- Without `--bare`, "a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted". `--bare` skips that discovery and is "the recommended mode for scripted and SDK calls" ("Start faster with bare mode").
- **Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN` or OAuth credentials**; it needs `ANTHROPIC_API_KEY` or an `apiKeyHelper` ([headless](https://code.claude.com/docs/en/headless), "Start faster with bare mode"; [authentication](https://code.claude.com/docs/en/authentication.md), "Generate a long-lived token").
- The sandbox page describes the "host outside your allowed domains" decision for **interactive** sessions only: prompt in Manual/acceptEdits, allowed in bypass, refused in `dontAsk`, classifier in auto; `strictAllowlist` refuses in every mode ("Hosts outside your allowed domains"). INFERENCE: in a headless Manual run the prompt has no answerer, so the connection is denied by the general `-p` rule; `strictAllowlist` makes that refusal explicit and mode-independent.

### In a container or dev container

- The [dev container](https://code.claude.com/docs/en/devcontainer) page: with the container running Claude Code as non-root, `--dangerously-skip-permissions` may be used for unattended runs (the CLI rejects the flag as root). The firewall script and its `NET_ADMIN`/`NET_RAW` capabilities are optional ("Run without permission prompts", "Restrict network egress").
- Its warning: "When executed with `--dangerously-skip-permissions`, dev containers do not prevent a malicious project from exfiltrating anything accessible inside the container, including the Claude Code credentials stored in `~/.claude`." Avoid mounting host secrets.
- The reference [`init-firewall.sh`](https://github.com/anthropics/claude-code/blob/d945a61bc6346abce607252d5667df8a3bf0461a/.devcontainer/init-firewall.sh) is an iptables default-DROP on INPUT/OUTPUT/FORWARD with an ipset of GitHub ranges (from `api.github.com/meta`) and the IPs of `registry.npmjs.org`, `api.anthropic.com`, `sentry.io`, `statsig.com` and three VS Code hosts, resolved once at start. It also accepts outbound UDP 53 and TCP 22 to any address, loopback, and the host's /24. It is container-wide: every process in the container, Claude Code and the code it runs alike, gets the same allowlist.
- The Bash sandbox can be layered inside a container; unprivileged containers need `enableWeakerNestedSandbox` ([sandbox environments](https://code.claude.com/docs/en/sandbox-environments), "Custom container").
- Hardened `docker run` example: `--cap-drop ALL`, `no-new-privileges`, seccomp profile, `--read-only`, tmpfs, `--network none`, limits, `--user 1000:1000`, code mounted `:ro`, plus a proxy's Unix socket mounted in ([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment), "Containers"). gVisor (`--runtime=runsc`) and Firecracker microVMs are the stronger options; a Firecracker agent VM "has no external network interface" and talks to a host proxy over vsock ("gVisor", "Virtual machines").

## 5. Reaching the model API while run code has no egress

Two documented shapes:

1. **The Bash sandbox splits the agent from the code it runs.** The sandbox wraps shell commands only, and its proxy runs "on your machine, outside the sandbox" ([sandboxing](https://code.claude.com/docs/en/sandboxing), "Network isolation"). The env scrub doc says "The Claude Code process keeps the credentials for its own API calls" ([env vars](https://code.claude.com/docs/en/env-vars.md), "What the subprocess environment scrub removes"). INFERENCE: the Claude Code process calls the model API directly, not through the sandbox proxy, so `allowedDomains` can stay empty (or omit `api.anthropic.com`) for run code while the agent still works. No page states the agent's own API path in these words — UNCONFIRMED in wording, consistent with every scope statement read.
2. **Whole-process boundary plus a proxy outside it.** Everything inside has no route out except a proxy. Claude Code is pointed at it with `ANTHROPIC_BASE_URL` (plaintext HTTP to the proxy, which can inject the credential) or `HTTP(S)_PROXY` (a CONNECT tunnel the proxy cannot see into without TLS interception) ([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment), "Configuring Claude Code to use a proxy"). With `--network none`, a host proxy's Unix socket is mounted in and a localhost port is relayed to it ("Unix socket architecture"). "Within your proxy's allowlist, the agent can send data to any allowed domain."
   - In this shape the run code shares the agent's network position: whatever the proxy allows the agent, it allows the code it runs, unless the Bash sandbox is layered inside as well. INFERENCE from the two facts above.
   - With `srt claude`, the runtime's allowlist must include `api.anthropic.com` (or the provider), and `claude.ai` and `platform.claude.com` for OAuth sign-in and refresh; "Runs authenticated with an API key can drop these two" ([sandbox environments](https://code.claude.com/docs/en/sandbox-environments), "Set up and launch the runtime").

The hosts Claude Code itself needs are listed in [network config](https://code.claude.com/docs/en/network-config), "Network access requirements": `api.anthropic.com` for the API (also the WebFetch domain check and feature flags), `claude.ai` and `platform.claude.com` for OAuth (token exchange and refresh go to `platform.claude.com`). `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turns off telemetry, error reporting, auto-update and similar ([env vars](https://code.claude.com/docs/en/env-vars.md)). Claude Code does not support SOCKS proxies ([network config](https://code.claude.com/docs/en/network-config), "Proxy configuration").

## 6. What the agent's credential is exposed to

Facts that hold everywhere:

- Credential precedence: cloud-provider vars, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, profiles, then `/login`. `claude setup-token` mints a **one-year** OAuth token for `CLAUDE_CODE_OAUTH_TOKEN`; it is not saved anywhere by the command ([authentication](https://code.claude.com/docs/en/authentication.md), "Authentication precedence", "Generate a long-lived token").
- `/login` credentials live in `~/.claude/.credentials.json` (mode `0600`) on Linux, the Keychain on macOS, `%USERPROFILE%\.claude\.credentials.json` on Windows, or under `CLAUDE_CONFIG_DIR` ([authentication](https://code.claude.com/docs/en/authentication.md)).
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips credentials from Bash commands, hooks and stdio MCP servers by name or value shape (`ANTHROPIC_API_KEY` named as removed), but **leaves `GITHUB_TOKEN`/`GH_TOKEN` and `HTTP(S)_PROXY` in place**, and leaves any secret whose name and value do not look like one. "Use it as one layer … rather than as the only control" ([env vars](https://code.claude.com/docs/en/env-vars.md), "What the subprocess environment scrub removes"). `claude-code-action` sets it automatically only when `allowed_non_write_users` is set, plus PID-namespace isolation where bubblewrap is available ([action security.md](https://github.com/anthropics/claude-code-action/blob/5a856893345e332afa621934082d8c660c26d689/docs/security.md), "Access Control").

Per setup:

| Setup | Model credential lives | Reachable by code the agent runs |
| :- | :- | :- |
| No sandbox (Bash allowed, e.g. a plain runner) | Claude Code's env / config dir | Yes: env inherited; config files readable. |
| Built-in Bash sandbox, defaults | Same, Claude Code process outside the sandbox | Env vars: **yes**, "inherited from Claude Code, including any secrets". Files: readable unless denied ("Reads: most of the machine"); `.credentials.json` is write-protected, not read-protected. Egress to send it: only via allowed domains (empty by default) and the TLS/fronting caveat. |
| Bash sandbox + `credentials` `deny` (env var and file) or env scrub | Same | Env var unset before each sandboxed command; file read denied. Whether the scrub's shape match removes `CLAUDE_CODE_OAUTH_TOKEN` by itself is UNCONFIRMED; an explicit `credentials.envVars` deny entry names it. |
| Whole process in container / `srt` / VM, credential inside | Inside the boundary with the agent | Yes. The docs say so for the dev container: it does "not prevent a malicious project from exfiltrating anything accessible inside the container, including the Claude Code credentials". Bounded only by the egress allowlist, which must include the API host. |
| Whole process in a boundary, credential injected by a proxy outside it | Proxy only | No: "The agent never sees the actual credentials" ([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment), "The proxy pattern"). The run code can still send requests through the proxy to any allowed host, including the API with injected auth. |
| Anthropic cloud session | Anthropic-managed VM; a separate proxy holds the GitHub token outside the sandbox | Per [sandbox environments](https://code.claude.com/docs/en/sandbox-environments), "Cloud sessions"; the model credential's location is not described. |

Other credentials the docs flag in the same breath: `GITHUB_TOKEN` survives the scrub, so the action docs advise minimal job `permissions` and a `sandbox.credentials` deny entry to remove it from sandboxed commands ([env vars](https://code.claude.com/docs/en/env-vars.md)); a code mount can carry `.env`, `.npmrc`, `~/.git-credentials`, cloud and kube configs ([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment), "Read-only code mounting"); with `allowed_non_write_users` the action warns that a static token "could be partially or fully recovered over time via prompt injection" ([action security.md](https://github.com/anthropics/claude-code-action/blob/5a856893345e332afa621934082d8c660c26d689/docs/security.md)).

## 7. Points that bear on a build-run-probe loop

- On Linux each sandboxed command has its own network namespace and private `localhost`, reaching "servers it started itself". INFERENCE: a server started by one Bash call is not reachable from a later, separate sandboxed Bash call; start and probe would have to share one command (or the probe run outside the sandbox). UNCONFIRMED whether background Bash commands share a namespace with later calls.
- macOS `allowLocalBinding` opens every localhost port to sandboxed commands, including unauthenticated services that "can act for the command outside the sandbox" ([sandboxing](https://code.claude.com/docs/en/sandboxing)).
- Package installs during a build need registry hosts in `allowedDomains`; each allowed host is an exfiltration path under the no-TLS-inspection caveat.
- `docker` inside the Bash sandbox needs the Docker socket, which the docs call effective host access.

## UNCONFIRMED and INFERENCE, collected

1. INFERENCE: in the built-in sandbox, Claude Code's own model API calls go direct from the unsandboxed process, not through the sandbox proxy, so run code can have an empty allowlist while the agent works. No page says this in one sentence.
2. UNCONFIRMED: whether `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`'s name/value match removes `CLAUDE_CODE_OAUTH_TOKEN` (only `ANTHROPIC_API_KEY` is named).
3. INFERENCE: a headless Manual-mode run denies a sandboxed connection to a non-allowed host because no one answers the prompt; the sandbox page describes the interactive case only.
4. INFERENCE/UNCONFIRMED: separate sandboxed Bash calls on Linux do not share `localhost`; background commands not addressed.
5. INFERENCE: in whole-process designs without a layered Bash sandbox, the run code has the agent's network reach.
6. UNCONFIRMED: where a cloud session keeps the model credential.
