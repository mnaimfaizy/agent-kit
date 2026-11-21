// The sandbox driver for the runtimes Docker Engine runs (#369): gVisor,
// Kata Containers and Firecracker registered as a Docker runtime on Linux,
// with Docker Engine 28.0 or later. It turns each lifecycle operation into
// `docker` commands; the order, the output and the report belong to
// lifecycle.mjs.
//
// The route to the host (#404): the sandbox has one network, attached at
// `docker run` and never connected or disconnected after, since a running
// gVisor sandbox does not see such a change. It is `--internal` with the
// `isolated` gateway mode, so it has no route out and the host has no
// address on it. The sandbox's one way to a host-side proxy is a relay
// container on that network and on an ordinary bridge network (the host
// network), which forwards one TCP port to the proxy on that bridge's
// gateway (relay.mjs). The relay only forwards bytes: the model credential
// stays in the host-side proxy. Each copy in or out goes through `docker
// exec`, since what `docker cp` moves is hidden from a running gVisor
// sandbox.
//
// The checks from the host: `docker network inspect` shows the network
// isolated with no gateway address, `docker inspect` shows the sandbox on it
// alone, and a launcher-owned probe on it, under the sandbox's own runtime,
// reaches what it must and nothing else: before the target starts (the setup
// relay), after the cut (nothing) and before the agent step (the model
// relay). Any failure ends the run before the agent step.
//
// Setup egress: the setup relay forwards to the egress proxy the launcher
// runs on the host (egress.mjs), the recipe's registries its only
// destinations. The cut stops the proxy and removes the setup relay.
//
// The model route (#370): for the agent step, the model relay, on the same
// network, forwards to the key-injecting model proxy, so the proxy is the
// scan's only route to the internet.

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
 * @typedef {(cmd: string, args: string[], opts?: { stdin?: Buffer | string, cwd?: string, maxOutput?: number }) => Promise<StartResult>} Call
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
  /** The sandbox's one network, isolated, attached at `docker run`. */
  const network = name;
  let proxy = null;
  let proxyEnv = [];
  let modelProxy = null;
  /**
   * The sandbox network's subnet prefix ("198.18.N"), once created. The
   * relays and probes take fixed addresses in its lower half, each its own
   * and none reused in a run, while Docker hands out the upper half: on an
   * isolated network nothing reserves `.1`, so an address a removed
   * container freed would otherwise go to the next one (#404).
   */
  let prefix = null;
  /** The relays on the sandbox's network: { address, port }, once started. */
  let setupRelay = null;
  let modelRelay = null;
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

    /**
     * Start the sandbox on its one isolated network, with every network it
     * will need attached at `docker run`: under gVisor a running sandbox
     * never sees a network connected or disconnected later (#404). Before
     * the target starts, check the network from the host.
     */
    async start(steps) {
      await ensureHostNetwork();
      await isolatedNetwork(network, "the setup network");
      if (steps.registries.length) await setupEgress(steps.registries);
      const why = await probe("setup", [
        ...(setupRelay ? [relayTarget(setupRelay, "connected", "the relay")] : []),
        ...gatewayTargets(setupRelay?.port),
      ]);
      if (why !== null) {
        throw new StepFailed([`FAILED  the setup network is not isolated: ${why}.`, ENDS_HERE]);
      }
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
          network,
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
      await onAlone(network, "the setup network");
      return {
        isolation: setupRelay
          ? "Isolation: checked from the host before the target starts; the sandbox reaches only the setup relay's port."
          : "Isolation: checked from the host before the target starts; the sandbox reaches nothing.",
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
        : { env: [], note: "no registries, so nothing on its network to reach" };
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

    /**
     * The cut: stop the egress proxy and remove the setup relay. Nothing is
     * disconnected (gVisor would not see it): the probe in `egressLeft`
     * proves nothing on the network is left to reach.
     */
    async cutEgress() {
      await closeProxy();
      if (setupRelay) {
        must(await docker(["rm", "--force", `${name}-relay-setup`]), "removing the setup relay");
      }
    },

    /**
     * Null when a probe on the sandbox's network, under the sandbox's own
     * runtime, reaches what it must and nothing else; else why not. After
     * the cut: not the removed setup relay, nor the host network's gateway.
     * With the model route open: the model relay, and not those, after
     * `docker network inspect` shows the network still isolated.
     */
    async egressLeft() {
      if (!modelRelay) {
        return probe("cut", [
          ...(setupRelay
            ? [relayTarget(setupRelay, "unreachable", "the removed setup relay")]
            : []),
          ...gatewayTargets(setupRelay?.port),
        ]);
      }
      const r = must(
        await docker(["network", "inspect", "--format", "{{json .}}", network]),
        "checking the sandbox's network",
      );
      const isolation = isolationFailure(r.stdout.toString("utf8"));
      if (isolation !== null) return `docker network inspect shows ${isolation}`;
      return probe("model", [
        relayTarget(modelRelay, "connected", "the model relay"),
        ...(setupRelay ? [relayTarget(setupRelay, "unreachable", "the removed setup relay")] : []),
        ...gatewayTargets(modelRelay.port),
      ]);
    },

    /**
     * Start the model proxy and its relay on the sandbox's network, which
     * the sandbox has been on since `docker run`.
     */
    async openModelRoute(startProxy) {
      const bind = await ensureHostNetwork();
      try {
        modelProxy = await startProxy(bind);
      } catch (e) {
        throw failed(`starting the model proxy on ${bind}`, {
          status: null,
          stdout: Buffer.alloc(0),
          stderr: e.message,
        });
      }
      modelRelay = await startRelay("model", modelProxy.port);
      return {
        url: `http://${hostOf(modelRelay.address)}:${modelProxy.port}`,
        note: `through a relay on the isolated network ${network}`,
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
      // The sandbox writes this output: never hold more of it than one
      // report's tar can be.
      const r = await docker(
        ["exec", "--user", "0:0", name, "sh", "-c", copyOutScript(path, maxBytes)],
        { maxOutput: maxBytes + TAR_OVERHEAD },
      );
      if (r.truncated) {
        return { error: `it is larger than ${maxBytes / 1024 / 1024} MiB (read on the host)` };
      }
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

  /** Check from the host that `docker inspect` shows the sandbox on `net` alone. */
  async function onAlone(net, what) {
    const r = must(
      await docker([
        "container",
        "inspect",
        "--format",
        "{{json .NetworkSettings.Networks}}",
        name,
      ]),
      "checking the sandbox's networks",
    );
    let attached = null;
    try {
      const parsed = JSON.parse(r.stdout.toString("utf8").trim() || "null");
      if (parsed && typeof parsed === "object") attached = Object.keys(parsed);
    } catch {
      attached = null;
    }
    const left =
      attached === null
        ? "docker inspect shows an unknown network state"
        : attached.some((n) => n !== net)
          ? `docker inspect shows the sandbox on ${attached.filter((n) => n !== net).join(", ")}`
          : null;
    if (left !== null) {
      throw new StepFailed([`FAILED  the sandbox is not on ${what} alone: ${left}.`, ENDS_HERE]);
    }
  }

  /** A probe target on a relay. */
  function relayTarget(relay, want, what) {
    return { host: relay.address, port: relay.port, want, what };
  }

  /** The host network's gateway, on the proxy's port when there is one, and on another. */
  function gatewayTargets(port) {
    return [...(port ? [port] : []), OTHER_HOST_PORT].map((p) => ({
      host: hostGateway,
      port: p,
      want: "unreachable",
      what: "the host network's gateway",
    }));
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
   * Create an `--internal` network in the `isolated` gateway mode, on a
   * per-run subnet (another candidate when one overlaps a network on this
   * host), and check from the host that `docker network inspect` shows it
   * so, with no gateway address.
   */
  async function isolatedNetwork(net, what) {
    resources.push(["network", net]);
    const tried = [];
    for (const candidate of subnetCandidates(id)) {
      const r = await docker([
        "network",
        "create",
        "--internal",
        ...ISOLATED_OPTIONS.flatMap((o) => ["--opt", o]),
        "--subnet",
        `${candidate}.0/24`,
        "--ip-range",
        `${candidate}.128/25`,
        "--label",
        label,
        net,
      ]);
      if (r.status === 0) {
        prefix = candidate;
        break;
      }
      if (!/overlap/i.test(r.stderr)) must(r, `creating ${what}`);
      tried.push(`${candidate}.0/24`);
    }
    if (prefix === null) {
      throw new StepFailed([
        `FAILED  no free subnet for the sandbox's network: tried ${tried.join(", ")}, and each overlaps a network on this host.`,
        ENDS_HERE,
      ]);
    }
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

  /** The fixed address of a relay or a probe on the sandbox's network. */
  function fixedAddress(container) {
    return `${prefix}.${FIXED_HOSTS[container]}`;
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
   * Start the relay on the sandbox's network, at its fixed address, and on
   * the host network, forwarding `port` to the host-side proxy on the host
   * network's gateway; return its address and port. It listens on that one
   * port, the proxy's own number.
   */
  async function startRelay(phase, port) {
    const relay = `${name}-relay-${phase}`;
    const address = fixedAddress(`relay-${phase}`);
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
        `name=${network},ip=${address}`,
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
    return { address, port };
  }

  /**
   * Run a launcher-owned probe on the sandbox's network, at its own fixed
   * address, under the sandbox's own runtime (so a runtime that sees the
   * network otherwise than Docker says fails here), and return why its
   * answer fails, or null. It runs the relay image alone: no code of the
   * target's.
   * @param {string} phase
   * @param {import("./relay.mjs").ProbeTarget[]} targets
   */
  async function probe(phase, targets) {
    const container = `${name}-probe-${phase}`;
    const image = await ensureRelayImage();
    resources.push(["container", container]);
    const r = must(
      await docker([
        "run",
        "--rm",
        "--name",
        container,
        "--label",
        label,
        ...(runtime.dockerRuntime ? ["--runtime", runtime.dockerRuntime] : []),
        "--network",
        `name=${network},ip=${fixedAddress(`probe-${phase}`)}`,
        ...relayOptions(),
        image,
        RELAY_SCRIPT_PATH,
        "probe",
        ...targets.flatMap((t) => [t.host, String(t.port)]),
      ]),
      `probing the sandbox's network (${phase})`,
    );
    return probeFailure(r.stdout.toString("utf8"), targets);
  }

  async function setupEgress(registries) {
    const bind = hostGateway;
    try {
      proxy = await startEgressProxy({ registries, bind });
    } catch (e) {
      throw failed(`starting the setup registry proxy on ${bind}`, {
        status: null,
        stdout: Buffer.alloc(0),
        stderr: e.message,
      });
    }
    setupRelay = await startRelay("setup", proxy.port);
    const url = `http://${hostOf(setupRelay.address)}:${proxy.port}`;
    proxyEnv = [
      ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].map((v) => `${v}=${url}`),
      "NO_PROXY=localhost,127.0.0.1",
      "no_proxy=localhost,127.0.0.1",
    ];
  }
}

/**
 * Each relay's and probe's host number on the sandbox's /24: its own, below
 * Docker's dynamic range (.128 and up), and never given to another.
 */
const FIXED_HOSTS = Object.freeze({
  "relay-setup": 10,
  "probe-setup": 11,
  "probe-cut": 12,
  "relay-model": 13,
  "probe-model": 14,
});

/** How many subnets a run tries for the sandbox's network. */
const SUBNET_TRIES = 5;

/**
 * The /24 prefixes a run tries for the sandbox's network, in order, chosen
 * from its id inside 198.18.0.0/15: a range set aside for testing, which
 * Docker's default pools never hand out and few LANs or VPNs use.
 * @param {string} id the run's hex id
 */
export function subnetCandidates(id) {
  const start = Number.parseInt(id.slice(0, 4), 16) % 512;
  return Array.from({ length: SUBNET_TRIES }, (_, i) => {
    const k = (start + i * 131) % 512;
    return `198.${18 + (k >> 8)}.${k & 255}`;
  });
}

/** Room for a tar's headers, padding and end blocks around one file. */
const TAR_OVERHEAD = 64 * 1024;

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
