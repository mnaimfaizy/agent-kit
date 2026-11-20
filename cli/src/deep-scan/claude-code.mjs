// The Claude Code every sandbox runs: one pinned version, installed with npm,
// with the auto-updater off both by environment and by managed settings in
// /etc/claude-code, which the repository's own project settings cannot
// override. Both drivers layer it into an image with Docker: the Docker
// driver as its runtime's image, the Docker Sandboxes driver as the template
// it loads into sbx (#375).

/** The Claude Code version every sandbox runs, pinned. */
export const CLAUDE_CODE_VERSION = "2.1.328";

/** The environment that keeps the auto-updater off. */
export const AUTO_UPDATER_OFF = "DISABLE_AUTOUPDATER=1";

const MANAGED_SETTINGS = JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } });

const INSTALL = [
  `npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \\`,
  "  && mkdir -p /etc/claude-code \\",
  `  && printf '%s\\n' '${MANAGED_SETTINGS}' > /etc/claude-code/managed-settings.json`,
];

/** The Dockerfile that layers the pinned Claude Code on `base`. It needs npm in `base`. */
export function layerDockerfile(base) {
  return [`FROM ${base}`, `ENV ${AUTO_UPDATER_OFF}`, `RUN ${INSTALL.join("\n")}`, ""].join("\n");
}
