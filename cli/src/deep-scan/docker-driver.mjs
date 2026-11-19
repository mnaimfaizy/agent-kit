// The sandbox driver for the runtimes Docker Engine runs (#369): gVisor,
// Kata Containers and Firecracker registered as a Docker runtime on Linux, and
// Docker Desktop on macOS. It turns each lifecycle operation into `docker`
// commands; the order, the output and the report belong to lifecycle.mjs.
//
// Setup egress: the sandbox sits on an `--internal` Docker network (no route
// out), and its only way to the recipe's registries is a proxy the launcher
// runs on the host (egress.mjs). The cut disconnects that network and stops
// the proxy; `docker inspect`, run on the host, confirms no network is left.

import { layerDockerfile } from "./claude-code.mjs";
import { startEgressProxy } from "./egress.mjs";
import { failed, must, StepFailed, ENDS_HERE } from "./steps.mjs";
import { singleFileOf } from "./tar.mjs";

/** The label every sandbox resource carries, so a stray one can be found. */
export const LABEL = "agent-kit.deep-scan";

/**
 * @typedef {import("../exec.mjs").StartResult} StartResult
 * @typedef {(cmd: string, args: string[], opts?: { stdin?: Buffer | string, cwd?: string }) => Promise<StartResult>} Call
 *   Runs a command without blocking; throws Interrupted when the run is.
 */

/**
 * @param {{ runtime: import("./runtime.mjs").Runtime, platform: string, id: string, call: Call }} opts
 * @returns {import("./lifecycle.mjs").Driver}
 */
export function dockerDriver({ runtime, platform, id, call }) {
  const name = `agent-kit-deep-${id}`;
  const label = `${LABEL}=${id}`;
  const docker = (args, opts) => call("docker", args, opts);
  /** Every resource asked for, in order, whether or not its command finished. */
  const resources = [];
  let network = null;
  let proxy = null;
  let proxyEnv = [];

  return {
    container: name,

    async prepare(steps, { archive, out, branch, short }) {
      let base;
      if (steps.dockerfile !== undefined) {
        out(`Image: building ${steps.dockerfile} from ${branch} (${short}).`);
        const context = archive({}, `export ${branch} as the build context`);
        base = `${name}-base`;
        resources.push(["image", base]);
        must(
          await docker(
            ["build", "--file", steps.dockerfile, "--label", label, "--tag", base, "-"],
            { stdin: context },
          ),
          `building ${steps.dockerfile}`,
          { showOutput: true },
        );
      } else {
        base = steps.image;
        out(`Image: pulling ${base}.`);
        must(await docker(["pull", base]), `pulling ${base}`, { showOutput: true });
      }
      out("Image: layering the pinned Claude Code, auto-updater off.");
      resources.push(["image", name]);
      must(
        await docker(["build", "--label", label, "--tag", name, "-"], {
          stdin: layerDockerfile(base),
        }),
        `layering Claude Code on ${base}`,
        { showOutput: true },
      );
    },

    async start(steps) {
      if (steps.registries.length) await setupNetwork(steps.registries);
      resources.push(["container", name]);
      must(
        await docker([
          "run",
          "--detach",
          "--init",
          "--name",
          name,
          "--label",
          label,
          ...(runtime.dockerRuntime ? ["--runtime", runtime.dockerRuntime] : []),
          "--network",
          network ?? "none",
          "--security-opt",
          "no-new-privileges",
          "--workdir",
          "/workspace",
          "--entrypoint",
          "tail",
          name,
          "-f",
          "/dev/null",
        ]),
        "starting the sandbox",
      );
    },

    /** Unpack `tar` at the sandbox's root. */
    async copyIn(tar, what) {
      must(await docker(["cp", "-", `${name}:/`], { stdin: tar }), what);
    },

    /** Claude Code is already in the image. */
    async installAgent() {},

    /** The setup egress was opened with the network: the proxy's variables. */
    async openSetupEgress(registries) {
      return registries.length
        ? {
            env: proxyEnv,
            note: `egress limited to ${registries.join(", ")}, through the host-side proxy`,
          }
        : { env: [], note: "no registries, so no network" };
    },

    refused: () => proxy?.refused ?? [],

    exec: (script, { env = [], workdir = "/workspace" } = {}) =>
      docker([
        "exec",
        ...env.flatMap((v) => ["--env", v]),
        ...(workdir ? ["--workdir", workdir] : []),
        name,
        "sh",
        "-c",
        script,
      ]),

    async cutEgress() {
      await closeProxy();
      if (network) {
        must(
          await docker(["network", "disconnect", "--force", network, name]),
          "cutting the network",
        );
      }
    },

    /** Null when the host sees no network on the sandbox, else what it sees. */
    async egressLeft() {
      const r = must(
        await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", name]),
        "checking that the network is cut",
      );
      let attached = null;
      try {
        const parsed = JSON.parse(r.stdout.toString("utf8").trim() || "null");
        if (parsed && typeof parsed === "object") {
          attached = Object.keys(parsed).filter((n) => n !== "none");
        }
      } catch {
        attached = null;
      }
      if (attached === null) return "docker inspect shows an unknown network state";
      return attached.length ? `docker inspect shows the sandbox on ${attached.join(", ")}` : null;
    },

    /** The file at `path`, read from the tar `docker cp` writes. */
    async copyOut(path, { maxBytes }) {
      const r = await docker(["cp", `${name}:${path}`, "-"]);
      if (r.status !== 0) return { missing: r };
      return singleFileOf(r.stdout, { maxBytes });
    },

    close: closeProxy,

    /** The commands that remove every resource asked for, newest first. */
    teardown() {
      return [...resources].reverse().map(([kind, n]) => ({
        what: `${kind} ${n}`,
        cmd: "docker",
        args:
          kind === "container"
            ? ["rm", "--force", "--volumes", n]
            : kind === "network"
              ? ["network", "rm", n]
              : ["image", "rm", "--force", n],
      }));
    },
  };

  async function closeProxy() {
    if (proxy) {
      const p = proxy;
      proxy = null;
      await p.close();
    }
  }

  async function setupNetwork(registries) {
    network = name;
    resources.push(["network", network]);
    must(
      await docker(["network", "create", "--internal", "--label", label, network]),
      "creating the setup network",
    );
    const inspect = must(
      await docker([
        "network",
        "inspect",
        "--format",
        "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
        network,
      ]),
      "reading the setup network's gateway",
    );
    const gateway = inspect.stdout.toString("utf8").trim();
    // Docker Desktop on macOS runs the engine in a VM: the host is
    // host.docker.internal there, not the network's gateway.
    const desktop = platform === "darwin";
    const bind = desktop ? "127.0.0.1" : gateway;
    if (!/^[0-9a-f.:]+$/i.test(bind)) {
      throw new StepFailed([
        "FAILED  the setup network has no gateway address to put the registry proxy on.",
        ENDS_HERE,
      ]);
    }
    try {
      proxy = await startEgressProxy({ registries, bind });
    } catch (e) {
      throw failed(`starting the setup registry proxy on ${bind}`, {
        status: null,
        stdout: Buffer.alloc(0),
        stderr: e.message,
      });
    }
    const host = desktop ? "host.docker.internal" : bind.includes(":") ? `[${bind}]` : bind;
    const url = `http://${host}:${proxy.port}`;
    proxyEnv = [
      ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].map((v) => `${v}=${url}`),
      "NO_PROXY=localhost,127.0.0.1",
      "no_proxy=localhost,127.0.0.1",
    ];
  }
}
