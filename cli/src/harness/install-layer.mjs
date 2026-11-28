// The Launcher's side of a launch plan's install layer (ADR 0027): the
// Dockerfile that puts the harness's CLI on a sandbox image. Both Deep scan
// drivers build it with Docker: the Docker driver as its runtime's image, the
// Docker Sandboxes driver as the template it loads into sbx (#375).

/**
 * The Dockerfile that layers a plan's `installLayer` on `base`. It needs npm
 * in `base`.
 * @param {string} base
 * @param {import("./claude-code.mjs").LaunchPlan["installLayer"]} installLayer
 */
export function layerDockerfile(base, { env, run }) {
  return [`FROM ${base}`, ...env.map((v) => `ENV ${v}`), `RUN ${run.join("\n")}`, ""].join("\n");
}
