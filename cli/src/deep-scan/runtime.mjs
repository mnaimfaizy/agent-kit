// Sandbox runtime selection for the Deep scan launcher (#368, ADR 0018).
// The rule: the target never shares a kernel with the host OS or with the
// maintainer's other environments. The launcher chooses the runtime itself,
// from checks made on the host (the runtimes' own CLIs and Docker's runtime
// registry), never from a check inside the sandbox, which the target could
// fake. Preference: Docker Sandboxes, then Kata or Firecracker (Linux), then
// gVisor (Linux), the last two on Docker Engine 28.0 or later, whose
// isolated gateway mode leaves the host no address on a sandbox network
// (#404). A Mac uses Docker Sandboxes: Docker Desktop for macOS has no way
// to keep a container from the host's services. Everything else is refused,
// and there is no override. Every probe here only reads: nothing is started.

import { firstLine } from "../exec.mjs";
import { CLI_VERSION } from "../tags.mjs";

export const RUNTIMES_DOCS_URL = `https://github.com/mnaimfaizy/agent-kit/blob/v${CLI_VERSION}/docs/security-audit.md#sandbox-runtimes`;

/** The lines every runtime refusal ends with: what is accepted, and the CI path. */
export const ACCEPTED_LINES = Object.freeze([
  "Accepted runtimes: Docker Sandboxes (sbx); Kata Containers or Firecracker on Linux; gVisor (runsc) on Linux; the last two on Docker Engine 28.0 or later.",
  "There is no override: on a host without one of them, use the CI path.",
  "CI path: the deep-scan reusable workflow runs the scan in a gVisor container on an ephemeral GitHub-hosted runner.",
]);

const PLATFORMS = { linux: "Linux", darwin: "macOS", win32: "Windows" };

/** The oldest Docker Engine deep-scan runs Kata, Firecracker or gVisor on. */
export const MIN_DOCKER_ENGINE = Object.freeze({ major: 28, minor: 0 });

/**
 * @typedef {{ id: "sbx" | "kata" | "firecracker" | "gvisor",
 *   name: string, dockerRuntime?: string }} Runtime
 */

/**
 * Choose the sandbox runtime from the host, or refuse.
 * @param {{ runner: import("../exec.mjs").Runner, platform: string }} opts
 * @returns {{ runtime: Runtime } | { refused: string[] }}
 */
export function selectRuntime({ runner, platform }) {
  const host = PLATFORMS[platform] ?? platform;
  const succeeds = (cmd, args) => runner(cmd, args).status === 0;

  if (succeeds("sbx", ["version"])) {
    return { runtime: { id: "sbx", name: "Docker Sandboxes (sbx)" } };
  }

  const info = dockerInfo(runner);
  // A Mac's one accepted runtime is Docker Sandboxes: say so in every refusal.
  const mac =
    platform === "darwin"
      ? [
          "On macOS, deep-scan runs on Docker Sandboxes (sbx), whose per-sandbox policy lets the sandbox reach the model proxy's port alone: install it. Docker Desktop for macOS has no way to keep a container from your machine's other services.",
        ]
      : [];
  const refuse = (...lines) => ({ refused: [...lines, ...mac, ...ACCEPTED_LINES] });

  if (platform === "linux" && info.ok) {
    const viaDocker = (id, label, pattern, cli) => {
      const name = registered(info.runtimes, pattern, id === "kata" ? FIRECRACKER : null);
      if (name === null || !succeeds(cli, ["--version"])) return null;
      return {
        runtime: { id, name: `${label}, as the Docker runtime "${name}"`, dockerRuntime: name },
      };
    };
    const chosen =
      viaDocker("kata", "Kata Containers", KATA, "kata-runtime") ??
      viaDocker("firecracker", "Firecracker", FIRECRACKER, "firecracker") ??
      viaDocker("gvisor", "gVisor (runsc)", RUNSC, "runsc");
    if (chosen) {
      const old = engineTooOld(info.version);
      if (old === null) return chosen;
      return refuse(
        old === "unknown"
          ? `Docker Engine's version is unknown (docker info shows ${JSON.stringify(info.version)}), and deep-scan runs ${chosen.runtime.name} only on ${MIN} or later: from ${MIN} a sandbox network can leave the host no address on it.`
          : `Docker Engine ${info.version} is older than ${MIN}, the oldest deep-scan runs ${chosen.runtime.name} on: from ${MIN} a sandbox network can leave the host no address on it.`,
        `Upgrade Docker Engine to ${MIN} or later, or use Docker Sandboxes (sbx).`,
      );
    }
    const install =
      "Install one of: gVisor (runsc), Kata Containers or Firecracker, each registered as a Docker runtime, or Docker Sandboxes (sbx).";
    if (info.os === "Docker Desktop") {
      return refuse(
        "Docker (Docker Desktop) on Linux is not an accepted sandbox runtime: its one VM is shared by every container.",
        install,
      );
    }
    return refuse(
      "Plain Docker on Linux shares the host's kernel with the target, so it is not an accepted sandbox runtime.",
      install,
    );
  }

  if (
    platform === "win32" &&
    info.ok &&
    info.os === "Docker Desktop" &&
    /wsl2?\b|microsoft/i.test(info.kernel)
  ) {
    return refuse(
      "Docker Desktop on Windows with the WSL 2 backend is not an accepted sandbox runtime.",
      "Its VM shares one Linux kernel and network namespace with your other WSL distros, so the target would share a kernel with them and could reach their network.",
      "Install Docker Sandboxes (sbx), which gives each sandbox its own microVM.",
    );
  }

  if (info.ok) {
    return refuse(
      `Docker (${info.os || "unknown"}) on ${host} is not an accepted sandbox runtime.`,
    );
  }
  return refuse(
    `No accepted sandbox runtime found on this ${host} host.`,
    ...(info.error ? [`docker info failed: ${info.error}`] : []),
  );
}

const MIN = `${MIN_DOCKER_ENGINE.major}.${MIN_DOCKER_ENGINE.minor}`;

/**
 * Null when Docker Engine `version` (`docker info`'s ServerVersion, such as
 * "28.5.1" or "29.0.0-rc.1") is at least the minimum, "old" when it is
 * older, "unknown" when it cannot be read.
 */
function engineTooOld(version) {
  const m = /^(\d+)\.(\d+)(?:\D|$)/.exec(version);
  if (!m) return "unknown";
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const { major: needMajor, minor: needMinor } = MIN_DOCKER_ENGINE;
  return major > needMajor || (major === needMajor && minor >= needMinor) ? null : "old";
}

// Kata with the Firecracker hypervisor (`kata-fc`) often shares Kata's shim
// path, so a runtime whose name says Firecracker is never counted as Kata.
const FIRECRACKER = /firecracker|kata-fc/i;
const KATA = /kata/i;
const RUNSC = /runsc/i;

/**
 * The first Docker runtime whose name or path matches `pattern`, by name, or
 * null. A runtime whose name matches `exclude` is skipped.
 */
function registered(runtimes, pattern, exclude = null) {
  for (const [name, spec] of Object.entries(runtimes)) {
    if (exclude?.test(name)) continue;
    const path = spec && typeof spec === "object" && typeof spec.path === "string" ? spec.path : "";
    if (pattern.test(name) || pattern.test(path)) return name;
  }
  return null;
}

/**
 * What the host's Docker Engine says about itself: its OS, kernel and
 * registered runtimes. Not installed, failing and unreadable are all "not ok".
 */
function dockerInfo(runner) {
  const r = runner("docker", ["info", "--format", "{{json .}}"]);
  if (r.status === null) return { ok: false, error: null };
  if (r.status !== 0) return { ok: false, error: firstLine(r.stderr) || `exit ${r.status}` };
  let info;
  try {
    info = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: "its output is not JSON" };
  }
  if (!info || typeof info !== "object") return { ok: false, error: "its output is not an object" };
  const text = (v) => (typeof v === "string" ? v : "");
  // Some Docker versions exit 0 when the daemon is down, and say so here.
  const serverErrors = Array.isArray(info.ServerErrors) ? info.ServerErrors.map(text) : [];
  if (serverErrors.some(Boolean)) {
    return { ok: false, error: firstLine(serverErrors.filter(Boolean).join("\n")) };
  }
  const runtimes = info.Runtimes && typeof info.Runtimes === "object" ? info.Runtimes : {};
  return {
    ok: true,
    os: text(info.OperatingSystem),
    kernel: text(info.KernelVersion),
    version: text(info.ServerVersion),
    runtimes,
  };
}
