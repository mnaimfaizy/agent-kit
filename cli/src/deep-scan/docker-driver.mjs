// The sandbox driver for the runtimes Docker Engine runs (#369): gVisor,
// Kata Containers and Firecracker registered as a Docker runtime on Linux, and
// Docker Desktop on macOS. It turns each lifecycle operation into `docker`
// commands; the order, the failure handling and the report belong to
// lifecycle.mjs. Every command is an argument array through the deep-scan
// runner's allowlist.

/** The label every sandbox resource carries, so a stray one can be found. */
export const LABEL = "agent-kit.deep-scan";

/**
 * @typedef {import("../exec.mjs").StartResult} StartResult
 * @typedef {(args: string[], opts?: { stdin?: Buffer | string }) => Promise<StartResult>} Call
 *   Runs `docker args` without blocking; throws when the run is interrupted.
 */

/**
 * @param {{ runtime: import("./runtime.mjs").Runtime, platform: string, id: string, call: Call }} opts
 */
export function dockerDriver({ runtime, platform, id, call }) {
  const name = `agent-kit-deep-${id}`;
  const label = `${LABEL}=${id}`;
  /** Every resource asked for, in order, whether or not its command finished. */
  const resources = [];
  let network = null;

  return {
    container: name,
    resources,

    /** Pull the recipe's base image. */
    pull: (image) => call(["pull", image]),

    /** Build the recipe's Dockerfile from `context`, a tar of the trusted tree. */
    build(dockerfile, context) {
      const tag = `${name}-base`;
      resources.push(["image", tag]);
      return call(["build", "--file", dockerfile, "--label", label, "--tag", tag, "-"], {
        stdin: context,
      }).then((r) => ({ ...r, tag }));
    },

    /** Build the sandbox image from a Dockerfile given as text, with no context. */
    layer(dockerfileText) {
      resources.push(["image", name]);
      return call(["build", "--label", label, "--tag", name, "-"], { stdin: dockerfileText });
    },

    /**
     * The setup network: internal (no route out). Returns where the host-side
     * registry proxy listens (`bind`) and the address the sandbox reaches it at
     * (`host`). Docker Desktop on macOS runs the engine in a VM, where the host
     * is host.docker.internal, not the network's gateway.
     */
    async setupNetwork() {
      network = name;
      resources.push(["network", network]);
      const created = await call(["network", "create", "--internal", "--label", label, network]);
      if (created.status !== 0) return { result: created };
      const inspect = await call([
        "network",
        "inspect",
        "--format",
        "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
        network,
      ]);
      if (inspect.status !== 0) return { result: inspect };
      const gateway = inspect.stdout.toString("utf8").trim();
      if (platform === "darwin") {
        return { result: inspect, bind: "127.0.0.1", host: "host.docker.internal" };
      }
      if (!/^[0-9a-f.:]+$/i.test(gateway)) return { result: inspect, bind: null };
      return {
        result: inspect,
        bind: gateway,
        host: gateway.includes(":") ? `[${gateway}]` : gateway,
      };
    },

    /** Start the sandbox: no mount, no host environment, no Docker socket. */
    start() {
      resources.push(["container", name]);
      return call([
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
      ]);
    },

    /** Unpack `tar` at the sandbox's root. */
    copyIn: (tar) => call(["cp", "-", `${name}:/`], { stdin: tar }),

    /** Run `script` with `sh -c`, with `env` (NAME=value) set for it alone. */
    exec: (script, { env = [], workdir = "/workspace" } = {}) =>
      call([
        "exec",
        ...env.flatMap((v) => ["--env", v]),
        ...(workdir ? ["--workdir", workdir] : []),
        name,
        "sh",
        "-c",
        script,
      ]),

    /** Disconnect the sandbox from the setup network, if it had one. */
    cutNetwork: () =>
      network ? call(["network", "disconnect", "--force", network, name]) : Promise.resolve(null),

    /**
     * The networks the host sees the sandbox on (`none` aside), or null when
     * that cannot be read.
     */
    async networks() {
      const r = await call(["inspect", "--format", "{{json .NetworkSettings.Networks}}", name]);
      if (r.status !== 0) return { result: r, attached: null };
      try {
        const parsed = JSON.parse(r.stdout.toString("utf8").trim() || "null");
        if (!parsed || typeof parsed !== "object") return { result: r, attached: null };
        return { result: r, attached: Object.keys(parsed).filter((n) => n !== "none") };
      } catch {
        return { result: r, attached: null };
      }
    },

    /** The file at `path` as a tar archive on stdout. */
    copyOut: (path) => call(["cp", `${name}:${path}`, "-"]),

    /**
     * The commands that remove every resource asked for, newest first.
     * @returns {Array<{ what: string, args: string[] }>}
     */
    teardown() {
      return [...resources].reverse().map(([kind, n]) => ({
        what: `${kind} ${n}`,
        args:
          kind === "container"
            ? ["rm", "--force", "--volumes", n]
            : kind === "network"
              ? ["network", "rm", n]
              : ["image", "rm", "--force", n],
      }));
    },
  };
}
