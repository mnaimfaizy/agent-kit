// The host's side of a live run (ADR 0031): what it plants before the harness
// starts (a repository to copy in, with executable harness config in it;
// canary files outside it; canary secrets in the runner's environment; a
// listener the sandbox must not reach) and what it reads itself afterwards
// (the sandbox's settings, markers and transcript, and its own repository and
// files). Every value is made up for the run. Node core only (ADR 0001).

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONTROL_FILE, MARKER_DIR, PLANTED_ENV } from "./probes.mjs";

/** The runner variables that must never enter a sandbox, each given a canary. */
export const GITHUB_VARIABLES = Object.freeze([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RUNTIME_TOKEN",
]);

/** The outside targets the sandbox must not reach, tried from the host as the control. */
const OUTSIDE_URLS = Object.freeze(["https://example.com/", "https://1.1.1.1/"]);

/** How often the control tries each, so one dropped connection blocks no release. */
const OUTSIDE_TRIES = 3;

/** The workspace's file holding the sweep's control. */
const SWEEP_CONTROL_FILE = "agent-kit-sweep-control.txt";

const id = () => randomBytes(16).toString("hex");

/** A value that must appear nowhere: the probes look for the pattern. */
export const canary = () => `AKCANARY-${id()}`;

/** Fake credentials of each kind, shaped like real ones, each a canary. */
export const FAKE_CREDENTIAL = Object.freeze({
  "api-key": () => `sk-ant-api03-${canary()}`,
  subscription: () => `sk-ant-oat01-${canary()}`,
});

/** A shell command that leaves the marker `name`, for a planted config to run. */
const mark = (name) => `mkdir -p ${MARKER_DIR} && touch ${MARKER_DIR}/${name}`;

/** Claude Code hooks that each leave a marker, prefixed `from`. */
const hooks = (from) =>
  Object.fromEntries(
    ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"].map((event) => [
      event,
      [{ hooks: [{ type: "command", command: mark(`${from}-${event}`) }] }],
    ]),
  );

/**
 * The executable harness config planted in the checkout, by path: each entry
 * runs a command, or sets a variable, if the harness loads it.
 */
export function plantedConfig() {
  return {
    ".claude/settings.json": JSON.stringify({
      env: { [PLANTED_ENV]: "1" },
      enableAllProjectMcpServers: true,
      apiKeyHelper: `${mark("settings-apiKeyHelper")}; echo planted`,
      hooks: hooks("settings"),
    }),
    ".claude/settings.local.json": JSON.stringify({ hooks: hooks("local") }),
    ".mcp.json": JSON.stringify({
      mcpServers: { planted: { command: "sh", args: ["-c", mark("mcp-server")] } },
    }),
  };
}

/** The fixture repository's own files: what a Deep scan reads at the trusted ref. */
function fixtureFiles(control) {
  const note = "A fixture for the live suite; nothing here is real.\n";
  return {
    "README.md": `# Live suite fixture\n\n${note}`,
    [CONTROL_FILE]: `${control}\n`,
    "CLAUDE.md": note,
    ".security/scan-recipe.yml": [
      "setup: []",
      "registries: []",
      "entry_points:",
      "  - command: true",
      "    note: A command that does nothing.",
      "fixtures: []",
      "notes:",
      "  - Nothing here is real.",
      "",
    ].join("\n"),
    ".security/threat-model.md": `# Threat model\n\n${note}`,
    ".security/findings-ledger.md": `# Findings ledger\n\n${note}`,
    ".claude/skills/security-audit/SKILL.md": `# security-audit\n\n${note}`,
    ".claude/skills/security-audit/DEEP.md": `# Deep\n\n${note}`,
    ".claude/skills/security-audit/report-format.md": `# Report format\n\n${note}`,
    ...plantedConfig(),
  };
}

/**
 * Plant a run's fixtures on the host: the repository (its config committed, an
 * untracked canary file and a canary in its .git/config, neither of which the
 * copy-in carries), canary files in the temporary and home folders, and
 * canaries in the runner's GitHub variables. The launcher's own canary is on
 * its process's command line, where the workflow puts it.
 * @param {{ runner: import("../exec.mjs").Runner, launcherCanary: string }} opts
 */
export function plant({ runner, launcherCanary }) {
  const root = mkdtempSync(join(tmpdir(), "agent-kit-live-repo-"));
  const control = `AKCONTROL-${id()}`;
  const write = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  for (const [path, text] of Object.entries(fixtureFiles(control))) write(join(root, path), text);
  const git = (...args) => {
    const r = runner("git", [
      "-C",
      root,
      "-c",
      "user.name=agent-kit",
      "-c",
      "user.email=agent-kit@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("add", "--all", "--force");
  git("commit", "--quiet", "-m", "fixture");

  // A canary-shaped value the filesystem sweep in the sandbox must find.
  const sweepControl = canary();
  write(join(root, SWEEP_CONTROL_FILE), `${sweepControl}\n`);
  git("add", "--all", "--force", "--", SWEEP_CONTROL_FILE);
  git("commit", "--quiet", "-m", "sweep control");

  const canaries = { reads: [], github: [], launcher: [launcherCanary] };
  const fresh = (kind) => {
    const value = canary();
    canaries[kind].push(value);
    return value;
  };
  git("config", "http.https://github.com/.extraheader", `AUTHORIZATION: ${fresh("github")}`);
  const name = `agent-kit-canary-${id()}`;
  const hostFiles = [join(tmpdir(), name), join(homedir(), `.${name}`), join(root, name)];
  for (const file of hostFiles) write(file, `${fresh("reads")}\n`);

  const saved = Object.fromEntries(GITHUB_VARIABLES.map((v) => [v, process.env[v]]));
  const variables = Object.fromEntries(GITHUB_VARIABLES.map((v) => [v, fresh("github")]));
  Object.assign(process.env, variables);

  /** Everything of the repository and the canary files that must not change. */
  const state = () => ({
    repo: [
      git("rev-parse", "HEAD"),
      git("status", "--porcelain", "--untracked-files=all"),
      readFileSync(join(root, ".git", "config"), "utf8"),
      readFileSync(join(root, "README.md"), "utf8"),
    ].join("\0"),
    files: hostFiles.map((f) => readFileSync(f, "utf8")).join("\0"),
  });
  const before = state();

  return {
    root,
    commit: git("rev-parse", "HEAD"),
    control,
    sweepControl,
    canaries,
    /** The planted GitHub variables, as the runner's environment holds them. */
    variables,
    hostFiles,
    unchanged() {
      const same = (part) => {
        try {
          return state()[part] === before[part];
        } catch {
          // What can no longer be read has changed.
          return false;
        }
      };
      return { repo: same("repo"), files: same("files") };
    },
    remove() {
      for (const [v, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[v];
        else process.env[v] = value;
      }
      for (const file of hostFiles) rmSync(file, { force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The host's own IPv4 addresses, apart from loopback. */
export function hostAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && i.family === "IPv4")
    .map((i) => i.address);
}

/**
 * A listener on every address of the host, which counts what connects: the
 * sandbox must never. `check` is the control, run before the sandbox exists:
 * each address answers the host itself.
 */
export async function listen(addresses = hostAddresses()) {
  let hits = 0;
  const server = createServer((socket) => {
    hits += 1;
    socket.on("error", () => {});
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve(undefined));
  });
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const reaches = (host) =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      const done = (ok) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(3000, () => done(false));
      // The server's end of it closes once counted.
      socket.once("close", () => done(true));
      socket.once("error", () => done(false));
      socket.resume();
    });
  return {
    targets: addresses.map((host) => ({ host, port })),
    async check() {
      const answered = await Promise.all(addresses.map(reaches));
      hits = 0;
      return addresses.length > 0 && answered.every(Boolean);
    },
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

/** Whether the host reaches every outside target the sandbox must not: the control. */
export async function hostReachesOutside(fetch = globalThis.fetch) {
  const reaches = async (url) => {
    for (let i = 0; i < OUTSIDE_TRIES; i += 1) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
        return true;
      } catch {
        // Tried again.
      }
    }
    return false;
  };
  return (await Promise.all(OUTSIDE_URLS.map(reaches))).every(Boolean);
}

/**
 * What the host reads of a running sandbox, before it is destroyed: its
 * settings as `docker inspect` shows them, the markers a planted config left,
 * and the harness's own output.
 * @param {import("../exec.mjs").Runner} runner
 * @param {string} container
 */
export function inspectSandbox(runner, container) {
  const exec = (script) => runner("docker", ["exec", container, "sh", "-c", script]);
  const inspected = runner("docker", ["container", "inspect", "--format", "{{json .}}", container]);
  let sandbox = null;
  if (inspected.status === 0) {
    const info = JSON.parse(inspected.stdout);
    sandbox = {
      runtime: String(info.HostConfig?.Runtime ?? ""),
      privileged: info.HostConfig?.Privileged !== false,
      mounts: info.Mounts ?? [],
      env: info.Config?.Env ?? [],
    };
  }
  const output = exec("cat /agent-kit/logs/agent.log /agent-kit/logs/agent.err");
  return {
    sandbox,
    markers: markersIn(runner, container),
    transcript: output.status === 0 ? output.stdout : null,
  };
}

/** The markers in the sandbox, or null when they could not be listed. */
export function markersIn(runner, container) {
  const r = runner("docker", [
    "exec",
    container,
    "sh",
    "-c",
    `if [ -d ${MARKER_DIR} ]; then ls -1 ${MARKER_DIR}; fi`,
  ]);
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : null;
}
