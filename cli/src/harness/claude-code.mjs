// The Claude Code Harness adapter (ADR 0027): one function that takes a
// Stage request and returns a launch plan, as plain data. The Launcher does
// everything with the plan; this module starts nothing and imports nothing.
//
// The CLI: one pinned version, installed with npm, with the auto-updater off
// both by environment and by managed settings in /etc/claude-code, which the
// repository's own project settings cannot override.
//
// The launch: print mode, the brief on stdin. `--bare` skips skill and
// CLAUDE.md discovery, so the Launcher hands the agent everything
// explicitly, in its brief. The agent holds only a placeholder API key. Its
// model API base URL is pinned by the Launcher's own `--settings`, which
// outrank project settings, and project and local settings are not even
// loaded (`--setting-sources user`), so the scanned repository's
// `.claude/settings.json` cannot point it elsewhere. Web tools are not in
// its tool set, and are denied as well. Its turn limit is `--max-turns` on
// the command line (#371).
//
// On the subscription path (#375) it holds a placeholder
// CLAUDE_CODE_OAUTH_TOKEN instead, and runs without `--bare`, which never
// reads one. So it can discover the scanned repository's CLAUDE.md and
// skills: the brief says they are that repository's content, and that its
// own procedure decides. The settings stay pinned the same way, hooks are
// off in them, and `--strict-mcp-config` keeps any MCP server the
// repository names from starting.

/** The Claude Code version every sandbox runs, pinned. */
const VERSION = "2.1.328";

/** The environment that keeps the auto-updater off. */
const AUTO_UPDATER_OFF = "DISABLE_AUTOUPDATER=1";

const MANAGED_SETTINGS = JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } });

/** The tools the agent has; the web tools are not among them. */
export const TOOLS = Object.freeze(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
export const WEB_TOOLS = Object.freeze(["WebFetch", "WebSearch"]);

/**
 * The credentials Claude Code accepts, by kind: the kit secret, the
 * variable it reads in the sandbox, and the non-secret value it holds there,
 * which the model proxy swaps. The subscription placeholder is shaped like a
 * token, in case Claude Code checks the prefix.
 */
const CREDENTIALS = {
  "api-key": {
    secret: "anthropic_api_key",
    env: "ANTHROPIC_API_KEY",
    placeholder: "agent-kit-deep-scan-placeholder",
  },
  subscription: {
    secret: "claude_code_oauth_token",
    env: "CLAUDE_CODE_OAUTH_TOKEN",
    placeholder: "sk-ant-oat01-agent-kit-deep-scan-placeholder",
  },
};

/**
 * @typedef {{
 *   stage?: string,
 *   model?: string,
 *   effort?: string,
 *   credentialKind?: "api-key" | "subscription",
 *   proxyUrl?: string,
 *   briefPath?: string,
 *   kitDir?: string,
 *   maxTurns?: number,
 * }} StageRequest  `model` and `effort` pass through verbatim, already
 *   checked by the Launcher; without either, Claude Code runs on its own
 *   default. `proxyUrl` is the model proxy as the sandbox reaches it,
 *   `kitDir` the Launcher's folder there, outside the workspace, and
 *   `maxTurns` the turn limit. A request without them (before the sandbox
 *   exists) gets a plan whose launch leaves them out.
 *
 * @typedef {{
 *   identity: { name: string, displayName: string, version: string, major: number },
 *   installLayer: { env: string[], run: string[] },
 *   modelRoute: { profile: string },
 *   credentials: {
 *     accepted: Record<string, { secret: string, env: string, placeholder: string }>,
 *     scrub: string[],
 *   },
 *   launch: {
 *     argv: string[],
 *     stdin: { file: string | undefined } | null,
 *     files: Array<{ path: string, text: string }>,
 *     env: string[],
 *   },
 *   checkoutConfig: string[],
 *   instructionFiles: string[],
 *   stops: { turnCap: { stderrPattern: string } | null },
 *   transcript: { path: string },
 * }} LaunchPlan  The nine parts of ADR 0027. `installLayer.run` is the lines
 *   of one shell command, layered on an image that has npm.
 *   `credentials.scrub` names every variable a model credential of this
 *   harness can sit in, removed from the Launcher's own commands.
 */

/**
 * The launch plan for `request`.
 * @param {StageRequest} [request]
 * @returns {LaunchPlan}
 */
export function claudeCode({
  model,
  effort,
  credentialKind = "api-key",
  proxyUrl,
  briefPath,
  kitDir,
  maxTurns,
} = {}) {
  const subscription = credentialKind === "subscription";
  const credential = CREDENTIALS[credentialKind];
  // The Launcher's own settings. Hooks are off where no `--bare` skips
  // them: a setup step could have written some into the user settings.
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: proxyUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    permissions: { allow: [...TOOLS], deny: [...WEB_TOOLS] },
    ...(subscription ? { disableAllHooks: true } : {}),
  };
  return {
    identity: { name: "claude-code", displayName: "Claude Code", version: VERSION, major: 2 },
    installLayer: {
      env: [AUTO_UPDATER_OFF],
      run: [
        `npm install --global @anthropic-ai/claude-code@${VERSION} \\`,
        "  && mkdir -p /etc/claude-code \\",
        `  && printf '%s\\n' '${MANAGED_SETTINGS}' > /etc/claude-code/managed-settings.json`,
      ],
    },
    modelRoute: { profile: "anthropic" },
    credentials: {
      accepted: structuredClone(CREDENTIALS),
      scrub: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    },
    launch: {
      argv: [
        "claude",
        ...(subscription ? [] : ["--bare"]),
        "--print",
        "--settings",
        JSON.stringify(settings),
        "--setting-sources",
        "user",
        ...(subscription ? ["--strict-mcp-config"] : []),
        "--tools",
        TOOLS.join(","),
        "--allowedTools",
        TOOLS.join(","),
        "--disallowedTools",
        WEB_TOOLS.join(","),
        "--permission-mode",
        "dontAsk",
        ...(kitDir !== undefined ? ["--add-dir", kitDir] : []),
        "--no-session-persistence",
        ...(maxTurns !== undefined ? ["--max-turns", String(maxTurns)] : []),
        ...(model !== undefined ? ["--model", model] : []),
        ...(effort !== undefined ? ["--effort", effort] : []),
      ],
      stdin: briefPath !== undefined ? { file: briefPath } : null,
      files: [],
      // The credential's variable alone: on the subscription path an API key
      // would outrank the token in Claude Code's auth order.
      env: [
        `${credential.env}=${credential.placeholder}`,
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
      ],
    },
    // The checkout's executable harness config, and what Claude Code loads by
    // itself. Declared for the Launcher; the Deep scan keeps the config from
    // loading by the flags above, and removes nothing from the copy.
    checkoutConfig: [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"],
    instructionFiles: ["CLAUDE.md", "CLAUDE.local.md"],
    // Print mode says "Error: Reached max turns" on its error output.
    stops: { turnCap: { stderrPattern: "^Error: Reached max turns" } },
    // Where the Launcher keeps Claude Code's own output.
    transcript: { path: `${kitDir ?? "/agent-kit"}/logs/agent.log` },
  };
}
