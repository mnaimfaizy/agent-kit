---
status: proposed
---

# The kit publishes one image per harness, pinned by digest

A Stage's sandbox ([ADR 0025](0025-a-stages-guards-are-reached-by-the-launchers-sandbox.md)) needs the harness's CLI in it. The Deep scan gets it there today by running `npm install` on the Scan recipe's image at run time. That pins only the CLI's own version: its dependencies resolve fresh on every run, so the tree a Stage runs can differ from the tree the contract tests proved. It also needs npm in the image, which a Consumer's Python image does not have.

So the kit publishes a **Harness image** for each built-in harness. Each is the kit's base image plus one directory, `/opt/agent-kit`, that holds the pinned CLI and the Node it runs on. The install layer of [ADR 0027](0027-a-harness-adapter-returns-a-launch-plan-as-data.md) becomes, for a built-in adapter, the digest of its Harness image.

- **No Consumer image.** The Launcher pulls the Harness image by digest and starts it. Plan, review and security audit always run this way.
- **A Consumer image, or a Scan recipe's image.** The Launcher does one local build: that image, plus `/opt/agent-kit` copied from the Harness image. The image must be glibc Linux; preflight refuses a musl image such as Alpine.
- **The Deep scan uses the same path.** `agent-kit deep-scan` drops its run-time npm layer, so the Launcher has one way to install a harness.
- **A Custom harness has no Harness image.** It keeps the run-time npm install from its exact version.

**The base image** is Debian slim with git, bash, curl, CA certificates, Node 24 LTS and Debian's own Python 3 on the path. A Consumer with an ordinary Node or Python project sets no image. The harness's own Node stays in `/opt/agent-kit`, off the project's path.

_Amended 2026-11-28 (the maintainer's decision on [#459](https://github.com/mnaimfaizy/agent-kit/issues/459)):_ the base first took Debian's own Node. Debian trixie ships Node 20, which is past upstream end of life, so the base carries Node 24 LTS, copied from the official `node` image that is pinned by digest and moved by the monthly refresh.

**Publishing and pinning.** Images go to GHCR under the repository owner, public, for amd64 and arm64 (`ghcr.io/mnaimfaizy/agent-kit-sandbox-<harness>`). Each digest is written into its adapter's source beside the CLI version, and the Launcher pulls by digest only. An image is built in the pull request that changes its pin, so a kit release carries only digests that already exist. The base is refreshed by a monthly pull request that a scheduled workflow opens; it rebuilds all five. Every digest change follows [ADR 0028](0028-a-security-stage-runs-only-on-a-harness-with-a-recorded-run.md)'s rule for a pin bump: the contract tests must pass, and the Support Level is kept if they do.

**The two Caller inputs** of ADR 0025, on implement and review response:

- `sandbox_image`: one image reference. Empty, the default, means the kit's image. A tag is accepted; the docs recommend a digest, and the run log records the digest that was resolved.
- `setup_registries`: host names, one per line. Empty, the default, means setup has no network.

Neither takes a Dockerfile. A private `sandbox_image` is pulled by a trusted workflow step before the Launcher, with the job token and `packages: read`, from GHCR only; the Launcher still holds no GitHub token ([ADR 0026](0026-every-github-write-is-a-trusted-step-working-from-the-stage-result.md)).

**Setup presets** become three values each, which `agent-kit init` writes into the Caller:

| Preset | `sandbox_image`        | `setup_registries`                   | `setup_commands`                  |
| ------ | ---------------------- | ------------------------------------ | --------------------------------- |
| node   | `node:22-bookworm`     | `registry.npmjs.org`                 | `npm ci`                          |
| python | `python:3.12-bookworm` | `pypi.org`, `files.pythonhosted.org` | `pip install -r requirements.txt` |
| mixed  | empty                  | all three                            | both                              |

**The verify job** runs `setup_commands` and `verify_commands` in the same Sandbox image, with the same registries and the same network cut, and no agent.

Decided in [Sandbox image for the CI Stages](https://github.com/mnaimfaizy/agent-kit/issues/451), on the map [Wayfinder: Stages run on a Consumer-chosen harness](https://github.com/mnaimfaizy/agent-kit/issues/438).

## Considered Options

- **The run-time npm install, kept.** Rejected. A dependency's bad release reaches every Consumer's next run, inside the sandbox that talks to the model proxy, and a Consumer's image would need npm only to host the harness.
- **One image holding all five CLIs.** Rejected. Any one pin bump changes the digest for all five, so every harness's recorded runs are against an image that no longer ships; opencode alone bumps every week or two. A rebuild would also pull a new Cursor CLI binary whenever another harness bumps.
- **A Harness image built at each kit release.** Rejected. The images would have to be published before the npm package that names them, and a release would ship digests no pull request tested.
- **A Dockerfile input beside `sandbox_image`.** Rejected. It is a build on the runner that the two inputs do not need.
- **A digest required for `sandbox_image`.** Rejected. The image is the Consumer's own and the Caller is trusted code; the presets would go stale at once.
- **Any private registry for `sandbox_image`.** Rejected for now. It needs a new secret; GHCR needs none.
- **The verify job left on the runner.** Rejected. `setup_commands` would have to work in two environments, and a check could pass for the agent and fail in verify.

## Consequences

- **`setup_commands` changes meaning** when a Stage leaves `claude-code-action`: it runs in the sandbox, not on the runner. This is a clean cut per Stage, as in ADR 0028. The tool-cache presets are removed in that release and the release notes say so.
- **The `redis-service` preset retires** on the Launcher path. The sandbox has no Docker, so a service has to be in the Consumer's image and started in `setup_commands`.
- **A Scan recipe with an Alpine image is refused**, where today it works if the image has npm.
- **Cursor CLI stays capped at `tried`.** Its Harness image freezes the binary, so the installer can no longer hand out a new one inside a release. But every model request goes through Cursor's backend, which changes behind the binary. If that backend refuses an old client, Cursor CLI Stages fail until the next refresh.
- **Five images to build and five digests to keep**, and a monthly refresh that runs the contract tests on all five.
