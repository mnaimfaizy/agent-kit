// Argument parsing and dispatch. Exit codes: 0 ok, 1 a check failed (or a
// warning under --strict, or the tag or the change was refused), 2 usage
// error (including a missing answer when there is no terminal to ask on).

import { parseArgs } from "node:util";
import { formatReport, runDoctor } from "./doctor.mjs";
import { REPO_PATTERN, sanitizeLine } from "./checks/result.mjs";
import { systemRunner } from "./exec.mjs";
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

Options for doctor:
  --ci            Check only Kit-owned paths and uses: pins (no gh needed).
                  Used automatically when gh has no admin login on the repo.
  --strict        Treat warnings as failures.
  --repo <o/r>    The GitHub repository to check (default: gh's choice for
                  the current directory).

Options for init (each one is asked for when missing, on a terminal):
  --tag <vX>              The Agent-kit tag to adopt.
  --flows <list>          pipeline, audit, or both (comma-separated).
  --actors <logins>       GitHub logins allowed to trigger runs.
  --default-branch <b>    Default branch (default: origin's HEAD, else main).
  --verify <commands>     verify_commands for implement (pipeline). In a
                          prompt, \\n separates commands.
  --preset <name|none>    Inline examples/setup-presets/<name>.sh as
                          setup_commands (pipeline; default none).
  --threat-pack-dir <d>   Where the Threat pack goes (audit; default .security).
  --yes                   Ask nothing; every answer comes from flags.
  --force                 Overwrite existing Callers, Threat pack files and
                          Kit-owned paths (use upgrade to change tags).

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
};

/**
 * @param {string[]} argv
 * @param {{
 *   cwd: string,
 *   stdout: (s: string) => void,
 *   stderr: (s: string) => void,
 *   runner?: import("./exec.mjs").Runner,
 *   openTag?: Function,
 *   openRepo?: Function,
 *   prompt?: ((question: string) => Promise<string>) | null,
 * }} io  `prompt` is null (or absent) when there is no terminal to ask on.
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io) {
  const { cwd, runner = systemRunner, openTag, openRepo, prompt = null } = io;
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
