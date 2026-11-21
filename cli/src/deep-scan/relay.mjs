// The relay and the probe on Docker Engine (#404), from the launcher's side:
// the pinned image they run on, the relay script staged for them and checked
// against its pinned SHA-256, and the reading of a probe's answer.
//
// On Docker Engine the sandbox's networks are `--internal` with the
// `isolated` gateway mode (Docker 28.0 and later), so the host has no
// address on them. The sandbox's one way to a host-side proxy is a relay
// container on its network and on an ordinary bridge network: it forwards
// one TCP port to the proxy, on that bridge's gateway, and listens on
// nothing else. It never holds the model credential: the bytes pass through,
// and the key is added in the host-side proxy.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENDS_HERE, StepFailed } from "./steps.mjs";

/** The official node image the relay and the probe run on, pinned by digest. */
export const RELAY_IMAGE =
  "node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5";

/** The relay script as it ships, and its pinned SHA-256. */
export const RELAY_SCRIPT_FILE = fileURLToPath(new URL("./relay-script.mjs", import.meta.url));
export const RELAY_SCRIPT_SHA256 =
  "dba81f93ed2d8265ba909c0da7b87f8639258d8b192a9f017d496232e9af8c4e";

/** Where the relay and the probe find the staged script. */
export const RELAY_SCRIPT_PATH = "/agent-kit/relay.mjs";

/** The port the probe tries on the host besides the proxy's: sshd's, often on all interfaces. */
export const OTHER_HOST_PORT = 22;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const mismatch = (what) =>
  new StepFailed([
    `FAILED  the relay script does not match its pinned SHA-256 (${what}); reinstall agent-kit.`,
    ENDS_HERE,
  ]);

/**
 * Copy the relay script to a private folder and check the copy against its
 * pinned SHA-256, so what the containers mount is what was checked.
 * @param {{ source?: string }} [opts]
 * @returns {{ file: string, remove: () => void }}
 */
export function stageRelayScript({ source = RELAY_SCRIPT_FILE } = {}) {
  const data = readFileSync(source);
  if (sha256(data) !== RELAY_SCRIPT_SHA256) throw mismatch(source);
  const dir = mkdtempSync(join(tmpdir(), "agent-kit-relay-"));
  const file = join(dir, "relay.mjs");
  // Readable by the container's unprivileged user; the folder stays private.
  writeFileSync(file, data, { mode: 0o444 });
  if (sha256(readFileSync(file)) !== RELAY_SCRIPT_SHA256) {
    rmSync(dir, { recursive: true, force: true });
    throw mismatch("its staged copy");
  }
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The `docker run` options a relay or a probe container shares: no
 * capabilities, a read-only root filesystem, no new privileges, an
 * unprivileged user, small limits, and the staged script mounted read-only.
 * @param {string} staged the staged script's path on the host
 */
export function relayOptions(staged) {
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
    "--mount",
    `type=bind,source=${staged},target=${RELAY_SCRIPT_PATH},readonly`,
    "--entrypoint",
    "node",
  ];
}

/**
 * Why a probe's answer fails the check, or null when it passes: the relay
 * connected, and the host network's gateway unreachable on each port.
 * @param {string} stdout the probe's output
 * @param {{ relay: [string, number], gateway: Array<[string, number]> }} targets
 */
export function probeFailure(stdout, { relay, gateway }) {
  let results;
  try {
    results = JSON.parse(stdout.trim());
  } catch {
    results = null;
  }
  const count = 1 + gateway.length;
  if (
    !Array.isArray(results) ||
    results.length !== count ||
    !results.every((r) => typeof r === "string")
  ) {
    return "the probe's answer is not one result per target";
  }
  const at = ([host, port]) => `${host.includes(":") ? `[${host}]` : host}:${port}`;
  if (results[0] !== "connected") {
    return `a probe on it could not reach the relay at ${at(relay)} (${results[0]})`;
  }
  for (const [i, target] of gateway.entries()) {
    const r = results[i + 1];
    if (r !== "unreachable") {
      return `a probe on it reached the host network's gateway at ${at(target)} (${r})`;
    }
  }
  return null;
}
