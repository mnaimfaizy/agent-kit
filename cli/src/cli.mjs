// Argument parsing and dispatch. Exit codes: 0 ok, 1 a check failed (or a
// warning under --strict, the tag or the change was refused, or deep-scan
// refused, or a sandbox step failed), 2 usage error (including a missing
// answer when there is no terminal to ask on), 130 or 143 deep-scan was
// interrupted by SIGINT or SIGTERM (after tearing the sandbox down).

import { parseArgs } from "node:util";
import { runDeepScan } from "./deep-scan.mjs";
import { formatReport, runDoctor } from "./doctor.mjs";
import { REPO_PATTERN, sanitizeLine } from "./checks/result.mjs";
import { runnerFor } from "./exec.mjs";
import { askYesNo } from "./prompt.mjs";
import { CLI_VERSION, isReleaseTag } from "./tags.mjs";
import { runInit } from "./init.mjs";
import { runUpgrade } from "./upgrade.mjs";

export const VERSION = CLI_VERSION;

const USAGE = `Usage: agent-kit <command> [options]

Commands:
  init       Adopt Agent-kit from a tag: copy the Kit-owned paths, write a
             Caller per flow with your answers filled in, the Threat pack
             skeleton and .github/dependabot.yml, then print the GitHub-side
             steps as gh commands. Local files only.
  doctor     Read-only checks of this repository against the Agent-kit tag
             its Callers pin. Never changes anything.
  upgrade    Move this repository to another Agent-kit tag: replace the
             Kit-owned paths, rewrite the uses: pins, print the examples/
             diff, then run doctor's file and pin checks. Local files only.
  deep-scan  Run a Deep scan of this repository's own code in a sandbox.
             Reads the Scan recipe as committed on the default branch and
             validates it, refuses a GitHub token in its environment or a
             committed .env, chooses a sandbox runtime from the host or
             refuses (no override), then runs the sandbox: image, copy-in of
             the default branch's tip, setup with egress only to the
             recipe's registries, network cut, the agent step (a stand-in
             for now), copy-out of the report only, and teardown.

Options for doctor:
  --ci            Check only Kit-owned paths and uses: pins (no gh needed).
                  Used automatically when gh has no admin login on the repo.
  --strict        Treat warnings as failures.
  --repo <o/r>    The GitHub repository to check (default: gh's choice for
                  the current directory).

Options for init (each one is asked for when missing, on a terminal):
  --tag <vX>              The Agent-kit tag to adopt.
  --flows <list>          pipeline, audit and/or review-response
                          (comma-separated).
  --actors <logins>       GitHub logins allowed to trigger runs.
  --default-branch <b>    Default branch (default: origin's HEAD, else main).
  --verify <commands>     verify_commands (pipeline: implement's checks;
                          review-response: the agent's checks). In a
                          prompt, \\n separates commands.
  --preset <name|none>    Inline examples/setup-presets/<name>.sh as
                          setup_commands (pipeline, review-response;
                          default none).
  --threat-pack-dir <d>   Where the Threat pack goes (audit; default .security).
  --yes                   Ask nothing; every answer comes from flags.
  --force                 Overwrite existing Callers, Threat pack files and
                          Kit-owned paths (use upgrade to change tags).

Options for deep-scan:
  --recipe <path>         The Scan recipe, relative to the repository root
                          (default .security/scan-recipe.yml).
  --default-branch <b>    The branch whose tip the recipe is read from
                          (default: origin's HEAD, else main).

Options for upgrade:
  --tag <vY>      The Agent-kit tag to move to (asked for when missing).
  --from <vX>     The tag you are leaving, when the pins already name <vY>
                  (after a Dependabot bump): deletes paths only <vX> listed
                  and prints the examples/ diff.
  --yes           Do not ask before changing files.
  --force         Replace Kit-owned paths even when they have uncommitted
                  changes (those changes are lost).

  -h, --help      Show this help.
  -v, --version   Show the version.`;

const COMMAND_OPTIONS = {
  doctor: ["ci", "strict", "repo"],
  init: [
    "tag",
    "flows",
    "actors",
    "default-branch",
    "verify",
    "preset",
    "threat-pack-dir",
    "yes",
    "force",
  ],
  upgrade: ["tag", "from", "yes", "force"],
  "deep-scan": ["recipe", "default-branch"],
};

/**
 * @param {string[]} argv
 * @param {{
 *   cwd: string,
 *   stdout: (s: string) => void,
 *   stderr: (s: string) => void,
 *   runner?: import("./exec.mjs").Runner,
 *   spawn?: Function,
 *   spawnAsync?: Function,
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 *   fetch?: typeof globalThis.fetch,
 *   signals?: { on: Function, off: Function },
 *   reportDir?: string,
 *   openTag?: Function,
 *   openRepo?: Function,
 *   prompt?: ((question: string) => Promise<string>) | null,
 * }} io  `prompt` is null (or absent) when there is no terminal to ask on.
 *   Without `runner`, each command runs through its own allowlist
 *   (`runnerFor`); `spawn` and `spawnAsync` replace only the process
 *   boundary behind it. `platform`, `env`, `fetch`, `signals` and
 *   `reportDir` (default the host's) are for tests, never flags.
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io) {
  const { cwd, openTag, openRepo, prompt = null } = io;
  // Anything printed can echo arguments or file contents: sanitize every line.
  const clean = (text) => String(text).split("\n").map(sanitizeLine).join("\n");
  const stdout = (text) => io.stdout(clean(text));
  const stderr = (text) => io.stderr(clean(text));
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        ci: { type: "boolean" },
        strict: { type: "boolean" },
        repo: { type: "string" },
        tag: { type: "string" },
        from: { type: "string" },
        flows: { type: "string" },
        actors: { type: "string" },
        "default-branch": { type: "string" },
        verify: { type: "string" },
        preset: { type: "string" },
        "threat-pack-dir": { type: "string" },
        recipe: { type: "string" },
        yes: { type: "boolean", short: "y" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    stderr(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    stdout(VERSION);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    (command || values.help ? stdout : stderr)(USAGE);
    return values.help ? 0 : 2;
  }
  if (!(command in COMMAND_OPTIONS)) {
    stderr(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  if (rest.length) {
    stderr(`${command} takes no arguments, got: ${rest.join(" ")}`);
    return 2;
  }
  const foreign = Object.keys(values).filter(
    (k) => k !== "help" && k !== "version" && !COMMAND_OPTIONS[command].includes(k),
  );
  if (foreign.length) {
    stderr(`${command} does not take ${foreign.map((k) => `--${k}`).join(", ")}\n\n${USAGE}`);
    return 2;
  }
  const runner =
    io.runner ??
    runnerFor(command, {
      ...(io.spawn ? { spawn: io.spawn } : {}),
      ...(io.spawnAsync ? { spawnAsync: io.spawnAsync } : {}),
    });

  if (command === "init") {
    stdout(`agent-kit init ${VERSION}`);
    return runInit({
      cwd,
      runner,
      flags: {
        tag: values.tag,
        flows: values.flows,
        actors: values.actors,
        defaultBranch: values["default-branch"],
        verify: values.verify,
        preset: values.preset,
        threatPackDir: values["threat-pack-dir"],
      },
      force: Boolean(values.force),
      yes: Boolean(values.yes),
      prompt,
      confirm: prompt ? (q) => askYesNo(prompt, q) : null,
      out: stdout,
      err: stderr,
      ...(openTag ? { openTag } : {}),
    });
  }
  if (command === "deep-scan") {
    stdout(`agent-kit deep-scan ${VERSION}`);
    return runDeepScan({
      cwd,
      runner,
      recipePath: values.recipe,
      defaultBranch: values["default-branch"],
      ...(io.platform !== undefined ? { platform: io.platform } : {}),
      ...(io.env !== undefined ? { env: io.env } : {}),
      ...(io.fetch !== undefined ? { fetch: io.fetch } : {}),
      ...(io.signals !== undefined ? { signals: io.signals } : {}),
      ...(io.reportDir !== undefined ? { reportDir: io.reportDir } : {}),
      out: stdout,
      err: stderr,
    });
  }
  if (command === "upgrade") {
    return upgrade(values, { cwd, runner, openRepo, prompt, stdout, stderr });
  }

  if (values.repo !== undefined && !REPO_PATTERN.test(values.repo)) {
    stderr(`--repo must be owner/name, got: ${JSON.stringify(values.repo)}`);
    return 2;
  }
  const report = runDoctor({
    cwd,
    runner,
    ci: Boolean(values.ci),
    strict: Boolean(values.strict),
    repo: values.repo,
    ...(openTag ? { openTag } : {}),
  });
  stdout(formatReport(report, { version: VERSION }));
  return report.exitCode;
}

async function upgrade(values, { cwd, runner, openRepo, prompt, stdout, stderr }) {
  if (!prompt) {
    // No terminal: every answer must come from a flag.
    const needed = [];
    if (values.tag === undefined) needed.push("--tag <vY>");
    if (!values.yes) needed.push("--yes");
    if (needed.length) {
      stderr(`agent-kit upgrade: there is no terminal to ask on, so pass ${needed.join(" and ")}.`);
      return 2;
    }
  }
  let tag = values.tag;
  if (tag === undefined) tag = await prompt("Agent-kit tag to upgrade to (for example v1.0.0): ");
  if (values.from !== undefined && !isReleaseTag(values.from)) {
    stderr(`--from must be a Release-line tag, got: ${JSON.stringify(values.from)}`);
    return 2;
  }
  if (!isReleaseTag(tag)) {
    stderr(
      `--tag must be a Release-line tag (vX.Y.Z or vX.Y.Z-stage.N), got: ${JSON.stringify(tag)}`,
    );
    return 2;
  }
  stdout(`agent-kit upgrade ${VERSION}`);
  return runUpgrade({
    cwd,
    runner,
    tag,
    from: values.from,
    force: Boolean(values.force),
    yes: Boolean(values.yes),
    confirm: prompt ? (q) => askYesNo(prompt, q) : null,
    out: stdout,
    ...(openRepo ? { openRepo } : {}),
  });
}
