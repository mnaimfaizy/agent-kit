// The relay and the probe on Docker Engine (#404), from the launcher's side:
// the pinned image their image is built from, the relay script built into
// it and checked against its pinned SHA-256, and the reading of a probe's
// answer.
//
// On Docker Engine the sandbox's networks are `--internal` with the
// `isolated` gateway mode (Docker 28.0 and later), so the host has no
// address on them. The sandbox's one way to a host-side proxy is a relay
// container on its network and on an ordinary bridge network: it forwards
// one TCP port to the proxy, on that bridge's gateway, and listens on
// nothing else. It never holds the model credential: the bytes pass through,
// and the key is added in the host-side proxy.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENDS_HERE, StepFailed } from "./steps.mjs";
import { tarOf } from "./tar.mjs";

/** The official node image the relay image is built from, pinned by digest. */
export const RELAY_IMAGE =
  "node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5";

/** The relay script as it ships, and its pinned SHA-256. */
export const RELAY_SCRIPT_FILE = fileURLToPath(new URL("./relay-script.mjs", import.meta.url));
export const RELAY_SCRIPT_SHA256 =
  "3917f9338e7e37555e914056474a9dbfc725c85a1d1d280a0596667103666e3e";

/** Where the relay and the probe find the script, in the relay image. */
export const RELAY_SCRIPT_PATH = "/agent-kit/relay.mjs";

/** The port the probe tries on the host besides the proxy's: sshd's, often on all interfaces. */
export const OTHER_HOST_PORT = 22;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const mismatch = (what) =>
  new StepFailed([
    `FAILED  the relay script does not match its pinned SHA-256 (${what}); reinstall agent-kit.`,
    ENDS_HERE,
  ]);

/** The relay image's Dockerfile: the pinned node image, and the script copied in. */
export const RELAY_DOCKERFILE = `FROM ${RELAY_IMAGE}\nCOPY relay.mjs ${RELAY_SCRIPT_PATH}\n`;

/**
 * The relay image's build context, for `docker build -` on stdin: its
 * Dockerfile and the relay script, whose bytes are checked against the
 * pinned SHA-256 first, so what goes into the image is what was checked.
 * No host path is mounted into a container: a daemon with its own private
 * /tmp, such as snap Docker, could not see one.
 * @param {{ source?: string }} [opts]
 * @returns {Buffer}
 */
export function relayBuildContext({ source = RELAY_SCRIPT_FILE } = {}) {
  const data = readFileSync(source);
  if (sha256(data) !== RELAY_SCRIPT_SHA256) throw mismatch(source);
  return tarOf([
    { path: "Dockerfile", data: Buffer.from(RELAY_DOCKERFILE, "utf8") },
    { path: "relay.mjs", data },
  ]);
}

/**
 * The `docker run` options a relay or a probe container shares: no
 * capabilities, a read-only root filesystem, no new privileges, an
 * unprivileged user and small limits. The script is in the image.
 */
export function relayOptions() {
  return [
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "node",
    "--pids-limit",
    "64",
    "--memory",
    "128m",
    "--entrypoint",
    "node",
  ];
}

/**
 * @typedef {{ host: string, port: number, want: "connected" | "unreachable", what: string }} ProbeTarget
 *   A target a probe tries, what it must give, and what to call it.
 */

/**
 * Why a probe's answer fails the check, or null when it passes: every
 * target gave what it must.
 * @param {string} stdout the probe's output
 * @param {ProbeTarget[]} targets
 */
export function probeFailure(stdout, targets) {
  let results;
  try {
    results = JSON.parse(stdout.trim());
  } catch {
    results = null;
  }
  if (
    !Array.isArray(results) ||
    results.length !== targets.length ||
    !results.every((r) => typeof r === "string")
  ) {
    return "the probe's answer is not one result per target";
  }
  for (const [i, t] of targets.entries()) {
    const r = results[i];
    if (r === t.want) continue;
    const at = `${t.host.includes(":") ? `[${t.host}]` : t.host}:${t.port}`;
    return t.want === "connected"
      ? `a probe on it could not reach ${t.what} at ${at} (${r})`
      : `a probe on it reached ${t.what} at ${at} (${r})`;
  }
  return null;
}
