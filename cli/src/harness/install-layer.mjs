// The Launcher's side of a launch plan's install layer (ADR 0027, ADR 0029):
// the Harness image, by digest only, and the Dockerfile that puts the
// harness on another image, by copying `/opt/agent-kit` from it. Both Deep
// scan drivers build that with Docker: the Docker driver as its runtime's
// image, the Docker Sandboxes driver as the template it loads into sbx
// (#375). Nothing is installed from a registry at run time.

/** An image reference that ends in a sha256 digest, with nothing else on the line. */
const BY_DIGEST = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

/** The line the musl check prints; the command text itself never holds it whole. */
export const MUSL_MARKER = "agent-kit-musl-image";

/**
 * The build step that fails on a musl image: the harness's CLI and Node are
 * glibc builds. A glibc image answers `getconf GNU_LIBC_VERSION`, even one
 * that also has the musl loader installed.
 */
const MUSL_CHECK = `RUN if ! getconf GNU_LIBC_VERSION >/dev/null 2>&1 && ls /lib/ld-musl-* >/dev/null 2>&1; then printf '%s-%s\\n' agent-kit musl-image >&2; exit 1; fi`;

/**
 * The plan's Harness image. Throws unless it is named by digest: a tag alone
 * can come to mean another image.
 * @param {import("./claude-code.mjs").LaunchPlan["installLayer"]} installLayer
 * @returns {string}
 */
export function pinnedHarnessImage({ image }) {
  if (typeof image !== "string" || !BY_DIGEST.test(image)) {
    throw new Error(
      `the Harness image must be pinned by digest (name@sha256:<64 hex digits>), got: ${JSON.stringify(image)}`,
    );
  }
  return image;
}

/**
 * The Dockerfile that layers a plan's `installLayer` on `base`, which must be
 * glibc Linux: the musl check, then `/opt/agent-kit` from the Harness image.
 * @param {string} base
 * @param {import("./claude-code.mjs").LaunchPlan["installLayer"]} installLayer
 */
export function layerDockerfile(base, installLayer) {
  const { env, run } = installLayer;
  return [
    `FROM ${base}`,
    MUSL_CHECK,
    `COPY --from=${pinnedHarnessImage(installLayer)} /opt/agent-kit /opt/agent-kit`,
    ...env.map((v) => `ENV ${v}`),
    `RUN ${run.join("\n")}`,
    "",
  ].join("\n");
}
