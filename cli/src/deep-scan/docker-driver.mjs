// The sandbox driver for the runtimes Docker Engine runs (#369): gVisor,
// Kata Containers and Firecracker registered as a Docker runtime on Linux,
// with Docker Engine 28.0 or later. It turns each lifecycle operation into
// `docker` commands; the order, the output and the report belong to
// lifecycle.mjs.
//
// The route to the host (#404): each network the sandbox joins is
// `--internal` with the `isolated` gateway mode, so it has no route out and
// the host has no address on it. The sandbox's one way to a host-side proxy
// is a relay container on its network and on an ordinary bridge network
// (the host network), which forwards one TCP port to the proxy on that
// bridge's gateway (relay.mjs). The relay only forwards bytes: the model
// credential stays in the host-side proxy. Before the target starts, and
// again before the agent step, the host checks the network: `docker network
// inspect` shows it isolated with no gateway address, `docker inspect` shows
// the sandbox on it alone, and a launcher-owned probe on it reaches the
// relay's port and not the host network's gateway, on the proxy's port or
// another. Any failure ends the run before the agent step.
//
// Setup egress: the setup network's relay forwards to the egress proxy the
// launcher runs on the host (egress.mjs), the recipe's registries its only
// destinations. The cut disconnects that network and stops the proxy;
// `docker inspect`, run on the host, confirms no network is left.
//
// The model route (#370): for the agent step, the sandbox joins a second
// isolated network, whose relay forwards to the key-injecting model proxy,
// so the proxy is the scan's only route to the internet.

import { isIPv4 } from "node:net";
import { layerDockerfile } from "./claude-code.mjs";
import { startEgressProxy } from "./egress.mjs";
import {
  OTHER_HOST_PORT,
  probeFailure,
  RELAY_SCRIPT_PATH,
  relayOptions,
  relayBuildContext,
} from "./relay.mjs";
import { failed, must, StepFailed, ENDS_HERE } from "./steps.mjs";
import { singleFileOf } from "./tar.mjs";

/** The label every sandbox resource carries, so a stray one can be found. */
export const LABEL = "agent-kit.deep-scan";

/**
 * @typedef {import("../exec.mjs").StartResult} StartResult
 * @typedef {(cmd: string, args: string[], opts?: { stdin?: Buffer | string, cwd?: string }) => Promise<StartResult>} Call
 *   Runs a command without blocking; throws Interrupted when the run is.
 */

/** The `docker network create` options that leave the host no address on a sandbox network. */
export const ISOLATED_OPTIONS = Object.freeze([
  "com.docker.network.bridge.gateway_mode_ipv4=isolated",
  "com.docker.network.bridge.gateway_mode_ipv6=isolated",
]);

/**
 * @param {{ runtime: import("./runtime.mjs").Runtime, id: string, call: Call }} opts
 * @returns {import("./lifecycle.mjs").Driver}
 */
export function dockerDriver({ runtime, id, call }) {
  const name = `agent-kit-deep-${id}`;
  const label = `${LABEL}=${id}`;
  const docker = (args, opts) => call("docker", args, opts);
  /** Every resource asked for, in order, whether or not its command finished. */
  const resources = [];
  let network = null;
  let proxy = null;
  let proxyEnv = [];
  let modelNetwork = null;
  let modelProxy = null;
  /** The ordinary bridge network the relays reach the host on, and its gateway. */
  let hostNetwork = null;
  let hostGateway = null;
  /** The relay image, once built. */
  let relayImage = null;

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
      if (!network) return {};
      await onAlone(network, "the setup network");
      return {
        isolation:
          "Isolation: checked from the host before the target starts; the sandbox reaches only the setup relay's port.",
      };
    },

    /**
     * Unpack `tar` at the sandbox's root, through `docker exec` as root (as
     * `docker cp` would write it). Never `docker cp`: under gVisor, what it
     * writes into a running container is hidden from the sandbox once the
     * sandbox has looked up that path (#404).
     */
    async copyIn(tar, what) {
      must(
        await docker(["exec", "-i", "--user", "0:0", name, "tar", "-x", "-f", "-", "-C", "/"], {
          stdin: tar,
        }),
        what,
      );
    },

    /** Claude Code is already in the image. */
    async installAgent() {},

    /** The setup egress was opened with the network: the proxy's variables. */
    async openSetupEgress(registries) {
      return registries.length
        ? {
            env: proxyEnv,
            note: `egress limited to ${registries.join(", ")}, through a relay to the host-side proxy; checked from the host: the sandbox reaches the relay's port alone`,
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

    /** Null when the host sees the sandbox on no network but the model network, else what it sees. */
    egressLeft: () => networksLeft(modelNetwork),

    /** Join the model network, whose relay forwards to the model proxy. */
    async openModelRoute(startProxy) {
      if (!network) {
        // Setup had no network: the sandbox is on `none`, which no other
        // network may join.
        must(
          await docker(["network", "disconnect", "none", name]),
          "taking the sandbox off the none network",
        );
      }
      const bind = await ensureHostNetwork();
      modelNetwork = `${name}-model`;
      await isolatedNetwork(modelNetwork, "the model network");
      try {
        modelProxy = await startProxy(bind);
      } catch (e) {
        throw failed(`starting the model proxy on ${bind}`, {
          status: null,
          stdout: Buffer.alloc(0),
          stderr: e.message,
        });
      }
      const relay = await startRelay("model", modelNetwork, modelProxy.port);
      await probe("model", modelNetwork, relay, modelProxy.port, "the model network");
      must(
        await docker(["network", "connect", modelNetwork, name]),
        "connecting the sandbox to the model network",
      );
      return {
        url: `http://${hostOf(relay)}:${modelProxy.port}`,
        note: `through a relay on the isolated network ${modelNetwork}`,
        isolation:
          "Isolation: checked from the host before the agent step; the sandbox reaches only the model relay's port.",
      };
    },

    /**
     * The file at `path`, as a tar `docker exec` writes from the sandbox:
     * first checked in the sandbox (a regular file, not a link, of at most
     * `maxBytes`), then, on the host, read as exactly one regular file of at
     * most `maxBytes`. Never `docker cp`, which under gVisor cannot read
     * what the sandbox wrote (#404).
     */
    async copyOut(path, { maxBytes }) {
      const r = await docker([
        "exec",
        "--user",
        "0:0",
        name,
        "sh",
        "-c",
        copyOutScript(path, maxBytes),
      ]);
      if (r.status === 4) return { error: "it is not a regular file (checked in the sandbox)" };
      if (r.status === 5) {
        return {
          error: `it is larger than ${maxBytes / 1024 / 1024} MiB (checked in the sandbox)`,
        };
      }
      if (r.status !== 0) return { missing: r };
      return singleFileOf(r.stdout, { maxBytes });
    },

    async close() {
      await closeProxy();
      if (modelProxy) {
        const p = modelProxy;
        modelProxy = null;
        await p.close();
      }
    },

    /**
     * The commands that remove every resource asked for: the sandbox first,
     * then the relays and probes (a network still in use cannot be removed),
     * then the rest, newest first.
     */
    teardown() {
      const newest = [...resources].reverse();
      const container = ([kind]) => kind === "container";
      const ordered = [
        ...newest.filter((r) => container(r) && r[1] === name),
        ...newest.filter((r) => container(r) && r[1] !== name),
        ...newest.filter((r) => !container(r)),
      ];
      return ordered.map(([kind, n]) => ({
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

  /** An address as a URL host. */
  function hostOf(address) {
    return address.includes(":") ? `[${address}]` : address;
  }

  /**
   * Null when the host sees the sandbox on no network but `allowed`, else
   * what it sees. `verb` is `inspect`, or `container inspect` for the check
   * before the target starts.
   */
  async function networksLeft(allowed, verb = ["inspect"]) {
    const r = must(
      await docker([...verb, "--format", "{{json .NetworkSettings.Networks}}", name]),
      "checking the sandbox's networks",
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
    const extra = attached.filter((n) => n !== allowed);
    return extra.length ? `docker inspect shows the sandbox on ${extra.join(", ")}` : null;
  }

  /** Check from the host that the sandbox is on `net` alone. */
  async function onAlone(net, what) {
    const left = await networksLeft(net, ["container", "inspect"]);
    if (left !== null) {
      throw new StepFailed([`FAILED  the sandbox is not on ${what} alone: ${left}.`, ENDS_HERE]);
    }
  }

  /**
   * The ordinary bridge network the relays reach the host on, created once,
   * and its gateway: the host address the host-side proxies listen on.
   */
  async function ensureHostNetwork() {
    if (hostNetwork) return hostGateway;
    hostNetwork = `${name}-host`;
    resources.push(["network", hostNetwork]);
    must(
      await docker(["network", "create", "--label", label, hostNetwork]),
      "creating the relays' host network",
    );
    const inspect = must(
      await docker(["network", "inspect", "--format", "{{json .IPAM.Config}}", hostNetwork]),
      "reading the relays' host network's gateway",
    );
    // A dual-stack bridge lists an IPv6 config too: the proxies go on the
    // IPv4 gateway, the address the relay forwards to.
    const gateway = ipv4GatewayOf(inspect.stdout.toString("utf8"));
    if (gateway === null) {
      throw new StepFailed([
        "FAILED  the relays' host network has no IPv4 gateway address to put a proxy on.",
        ENDS_HERE,
      ]);
    }
    hostGateway = gateway;
    return gateway;
  }

  /**
   * Create an `--internal` network in the `isolated` gateway mode, and check
   * from the host that `docker network inspect` shows it so, with no
   * gateway address.
   */
  async function isolatedNetwork(net, what) {
    resources.push(["network", net]);
    must(
      await docker([
        "network",
        "create",
        "--internal",
        ...ISOLATED_OPTIONS.flatMap((o) => ["--opt", o]),
        "--label",
        label,
        net,
      ]),
      `creating ${what}`,
    );
    const r = must(
      await docker(["network", "inspect", "--format", "{{json .}}", net]),
      `checking ${what}`,
    );
    const why = isolationFailure(r.stdout.toString("utf8"));
    if (why !== null) {
      throw new StepFailed([
        `FAILED  ${what} is not isolated: docker network inspect shows ${why}.`,
        ENDS_HERE,
      ]);
    }
  }

  /**
   * The relay image, built once from the pinned node image and the
   * digest-checked relay script, its context sent on stdin.
   */
  async function ensureRelayImage() {
    if (relayImage) return relayImage;
    const context = relayBuildContext();
    relayImage = `${name}-relay`;
    resources.push(["image", relayImage]);
    must(
      await docker(["build", "--label", label, "--tag", relayImage, "-"], { stdin: context }),
      "building the relay image",
      { showOutput: true },
    );
    return relayImage;
  }

  /**
   * Start the relay on `net` and the host network, forwarding `port` to the
   * host-side proxy on the host network's gateway; return its address on
   * `net`. It listens on that one port, the proxy's own number.
   */
  async function startRelay(phase, net, port) {
    const relay = `${name}-relay-${phase}`;
    const image = await ensureRelayImage();
    resources.push(["container", relay]);
    must(
      await docker([
        "run",
        "--detach",
        "--name",
        relay,
        "--label",
        label,
        // The host network is its default route; the sandbox's has none.
        "--network",
        `name=${hostNetwork},gw-priority=1`,
        "--network",
        net,
        ...relayOptions(),
        image,
        RELAY_SCRIPT_PATH,
        "forward",
        String(port),
        hostGateway,
        String(port),
      ]),
      `starting the ${phase} relay`,
    );
    const r = must(
      await docker([
        "inspect",
        "--format",
        `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`,
        relay,
      ]),
      `reading the ${phase} relay's address`,
    );
    const address = r.stdout.toString("utf8").trim();
    if (!/^[0-9a-f.:]+$/i.test(address)) {
      throw new StepFailed([`FAILED  the ${phase} relay has no address on ${net}.`, ENDS_HERE]);
    }
    return address;
  }

  /**
   * From a launcher-owned probe on `net`: the relay's port is reached, and
   * the host network's gateway is not, on the proxy's port or another.
   */
  async function probe(phase, net, relay, port, what) {
    const container = `${name}-probe-${phase}`;
    const image = await ensureRelayImage();
    const gateway = [
      [hostGateway, port],
      [hostGateway, OTHER_HOST_PORT],
    ];
    resources.push(["container", container]);
    const r = must(
      await docker([
        "run",
        "--rm",
        "--name",
        container,
        "--label",
        label,
        "--network",
        net,
        ...relayOptions(),
        image,
        RELAY_SCRIPT_PATH,
        "probe",
        relay,
        String(port),
        ...gateway.flatMap(([h, p]) => [h, String(p)]),
      ]),
      `probing ${what}`,
    );
    const why = probeFailure(r.stdout.toString("utf8"), { relay: [relay, port], gateway });
    if (why !== null) {
      throw new StepFailed([`FAILED  ${what} is not isolated: ${why}.`, ENDS_HERE]);
    }
  }

  async function setupNetwork(registries) {
    const bind = await ensureHostNetwork();
    network = name;
    await isolatedNetwork(network, "the setup network");
    try {
      proxy = await startEgressProxy({ registries, bind });
    } catch (e) {
      throw failed(`starting the setup registry proxy on ${bind}`, {
        status: null,
        stdout: Buffer.alloc(0),
        stderr: e.message,
      });
    }
    const relay = await startRelay("setup", network, proxy.port);
    await probe("setup", network, relay, proxy.port, "the setup network");
    const url = `http://${hostOf(relay)}:${proxy.port}`;
    proxyEnv = [
      ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].map((v) => `${v}=${url}`),
      "NO_PROXY=localhost,127.0.0.1",
      "no_proxy=localhost,127.0.0.1",
    ];
  }
}

/**
 * The script that checks the report at `path` in the sandbox and writes it
 * as a tar of that one file: exit 3 when there is none, 4 when it is not a
 * regular file, 5 when it is larger than `maxBytes`.
 * @param {string} path an absolute path the launcher names, with no quote
 * @param {number} maxBytes
 */
export function copyOutScript(path, maxBytes) {
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const base = path.slice(path.lastIndexOf("/") + 1);
  return [
    `p=${path};`,
    `if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo "no file at $p" >&2; exit 3; fi;`,
    `{ [ -f "$p" ] && [ ! -L "$p" ]; } || exit 4;`,
    `[ "$(wc -c < "$p")" -le ${maxBytes} ] || exit 5;`,
    `exec tar -c -f - -C ${dir} ${base}`,
  ].join(" ");
}

/**
 * The first IPv4 gateway in `docker network inspect --format {{json
 * .IPAM.Config}}`, or null.
 * @param {string} text
 */
export function ipv4GatewayOf(text) {
  let configs;
  try {
    configs = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(configs)) return null;
  for (const c of configs) {
    const g = typeof c?.Gateway === "string" ? c.Gateway : "";
    if (isIPv4(g)) return g;
  }
  return null;
}

/**
 * Why `docker network inspect --format {{json .}}` does not show an
 * internal network in the isolated gateway mode with no gateway address,
 * or null when it does.
 * @param {string} text
 */
export function isolationFailure(text) {
  let net;
  try {
    net = JSON.parse(text.trim());
  } catch {
    return "output that is not JSON";
  }
  if (Array.isArray(net) && net.length === 1) net = net[0];
  if (!net || typeof net !== "object") return "no network";
  if (net.Internal !== true) return "it is not internal";
  const options = net.Options && typeof net.Options === "object" ? net.Options : {};
  for (const o of ISOLATED_OPTIONS) {
    const [key] = o.split("=");
    const value = typeof options[key] === "string" ? options[key] : "";
    if (value !== "isolated") return `${key} as ${JSON.stringify(value)}, not isolated`;
  }
  const configs = Array.isArray(net.IPAM?.Config) ? net.IPAM.Config : [];
  const gateway = configs
    .map((c) => (typeof c?.Gateway === "string" ? c.Gateway : ""))
    .find(Boolean);
  if (gateway) return `the gateway address ${gateway}`;
  return null;
}
