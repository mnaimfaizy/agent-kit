// Argument parsing and dispatch. Exit codes: 0 ok, 1 a check failed (or a
// warning under --strict, the tag or the change was refused, or deep-scan
// refused, or a sandbox step failed), 2 usage error (including a missing
// answer when there is no terminal to ask on), 3 a deep-scan limit stopped
// the run (after copying out any report and tearing the sandbox down), 130
// or 143 deep-scan was interrupted by SIGINT or SIGTERM (likewise).

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
             committed .env, reads the deep procedure and the Threat pack
             from the same branch and the API key (--credential-from),
             chooses a sandbox runtime from the host or refuses (no
             override), then runs the sandbox: image, copy-in of the
             default branch's tip, setup with egress only to the recipe's
             registries, network cut, the real Claude Code behind a
             key-injecting model proxy on this machine (its only route
             out), copy-out of the report only, and teardown. Every run
             is bounded by wall clocks, a turn limit and a token cap.

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
  --credential-from <s>   Where the Anthropic API key is read from:
                          env:<NAME> (default env:ANTHROPIC_API_KEY, which
                          op run can fill) or an op:// reference, read with
                          op read. Never the key itself. It stays outside
                          the sandbox, in the model proxy.
  --setup-minutes <n>     The setup wall clock: image to agent step
                          (default 20).
  --scan-minutes <n>      The scan wall clock: the agent step (default 60).
  --max-turns <n>         Claude Code's turn limit (default 200).
  --max-tokens <n>        The model proxy's token cap for the run, counting
                          input, output and cache tokens (default 5000000).
                          A limit that fires stops the run, copies out its
                          report with a Stopped: line, and exits 3.
  --model <id>            The Claude model the agent runs on, a plain id
                          such as claude-opus-5-5 (default: Claude Code's).
  --report <path>         Write the report to this new file, in a folder
                          that exists (default: report.md in a new private
                          folder under your temporary folder). The CI
                          workflow's delivery steps read it from there.
  --verify <file>         A Verification run instead: re-attempt the
                          Reproduction of the findings in <file> (each a
                          ### section with Concept id, Location and
                          Observation, as a deep report gives them) to
                          check whether a fix holds. Confirm-only: no full
                          walk, no exploration, no new findings. Local
                          only (refused in CI), with no --report: the
                          report goes to a new private folder, and nothing
                          is filed or posted. Its defaults: scan 15 min,
                          50 turns, the same token cap.
  --ref <ref>             With --verify, and needed by it: the local
                          branch, tag or commit to export and verify on,
                          such as your fix branch. The recipe, the skill
                          and the Threat pack still come from the default
                          branch.
In GitHub Actions (GITHUB_ACTIONS=true) deep-scan keeps the Public-log
rule: it prints nothing the scan shaped (Claude Code's error output, the
model proxy's refusals), since the Actions log is world-readable.

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
  "deep-scan": [
    "recipe",
    "default-branch",
    "credential-from",
    "setup-minutes",
    "scan-minutes",
    "max-turns",
    "max-tokens",
    "model",
    "report",
    "verify",
    "ref",
  ],
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
 *   modelApi?: string,
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 *   openTag?: Function,
 *   openRepo?: Function,
 *   prompt?: ((question: string) => Promise<string>) | null,
 * }} io  `prompt` is null (or absent) when there is no terminal to ask on.
 *   Without `runner`, each command runs through its own allowlist
 *   (`runnerFor`); `spawn` and `spawnAsync` replace only the process
 *   boundary behind it. `platform`, `env`, `fetch`, `signals`, `reportDir`,
 *   `modelApi` and `timers` (default the host's, the real model API and
 *   the real clock) are for tests, never flags.
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
        "credential-from": { type: "string" },
        "setup-minutes": { type: "string" },
        "scan-minutes": { type: "string" },
        "max-turns": { type: "string" },
        "max-tokens": { type: "string" },
        model: { type: "string" },
        report: { type: "string" },
        ref: { type: "string" },
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
      credentialFrom: values["credential-from"],
      model: values.model,
      reportPath: values.report,
      verifyPath: values.verify,
      ref: values.ref,
      limitFlags: {
        "setup-minutes": values["setup-minutes"],
        "scan-minutes": values["scan-minutes"],
        "max-turns": values["max-turns"],
        "max-tokens": values["max-tokens"],
      },
      ...(io.platform !== undefined ? { platform: io.platform } : {}),
      ...(io.env !== undefined ? { env: io.env } : {}),
      ...(io.fetch !== undefined ? { fetch: io.fetch } : {}),
      ...(io.signals !== undefined ? { signals: io.signals } : {}),
      ...(io.reportDir !== undefined ? { reportDir: io.reportDir } : {}),
      ...(io.modelApi !== undefined ? { modelApi: io.modelApi } : {}),
      ...(io.timers !== undefined ? { timers: io.timers } : {}),
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
