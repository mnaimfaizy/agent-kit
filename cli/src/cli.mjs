// Argument parsing and dispatch. Exit codes: 0 ok, 1 a check failed (or a
// warning under --strict, or the tag was refused), 2 usage error.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatReport, runDoctor } from "./doctor.mjs";
import { systemRunner } from "./exec.mjs";

export const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const USAGE = `Usage: agent-kit <command> [options]

Commands:
  doctor     Read-only checks of this repository against the Agent-kit tag
             its Callers pin. Never changes anything.

Options for doctor:
  --ci            Check only Kit-owned paths and uses: pins (no gh needed).
                  Used automatically when gh has no admin login on the repo.
  --strict        Treat warnings as failures.
  --repo <o/r>    The GitHub repository to check (default: gh's choice for
                  the current directory).

  -h, --help      Show this help.
  -v, --version   Show the version.

init and upgrade are not available yet.`;

/**
 * @param {string[]} argv
 * @param {{ cwd: string, stdout: (s: string) => void, stderr: (s: string) => void, runner?: import("./exec.mjs").Runner, openTag?: Function }} io
 * @returns {number} exit code
 */
export function main(argv, { cwd, stdout, stderr, runner = systemRunner, openTag }) {
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
  if (command === "init" || command === "upgrade") {
    stderr(`agent-kit ${command} is not available in ${VERSION} yet; it ships in a later release.`);
    return 2;
  }
  if (command !== "doctor") {
    stderr(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  if (rest.length) {
    stderr(`doctor takes no arguments, got: ${rest.join(" ")}`);
    return 2;
  }
  if (values.repo !== undefined && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(values.repo)) {
    stderr(`--repo must be owner/name, got: ${values.repo}`);
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
