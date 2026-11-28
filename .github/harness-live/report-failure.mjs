// A failed weekly run of the live suite, put in front of the maintainer
// (ADR 0031): an issue, or a comment on the one already open. When a Guard was
// not held, the issue is labelled ready-for-human and guard-failure, and an
// open guard-failure issue blocks the next release (scripts/release.py,
// `cut`), until it is resolved and closed. A level never changes here.
//
// It reads RUN_URL, GUARD_FAILED (`true` when the suite said so) and FAILED
// (the suite's `scenario:guard` entries), and runs `gh` with the job token.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The open issue this adds to is the one with this title that the job token opened. */
export const TITLE = "Harness live: the weekly run failed";

/** The label scripts/release.py refuses to cut past. */
export const GUARD_LABEL = "guard-failure";
export const GUARD_LABELS = Object.freeze(["ready-for-human", GUARD_LABEL]);

/** Any other failure is triaged first. */
const OTHER_LABELS = Object.freeze(["needs-triage"]);

/** The one shape a failed entry has, so nothing else reaches an issue's text. */
const ENTRY = /^[A-Za-z0-9-]+:[a-z]+$/;

/** What the run's issue or comment says. */
function bodyOf({ runUrl, guardFailed, failed }) {
  const entries = failed.split(",").filter((e) => ENTRY.test(e));
  return [
    `The weekly run of the live suite on the default branch failed: ${runUrl}`,
    "",
    ...(guardFailed
      ? [
          "**A Guard was not held**, so the next release is blocked: `scripts/release.py cut` refuses while an open issue carries the `guard-failure` label. Resolve the cause, see a later run pass, then close this issue.",
          ...(entries.length
            ? ["", "Not held, as scenario and Guard:", ...entries.map((e) => `- \`${e}\``)]
            : []),
        ]
      : [
          "No Guard probe reported a failure: the run failed for another reason, which its log shows.",
        ]),
    "",
  ].join("\n");
}

/**
 * @param {{
 *   env: Record<string, string | undefined>,
 *   gh: (args: string[], stdin?: string) => { status: number | null, stdout: string, stderr: string },
 * }} io
 * @returns {string}  what was done
 */
export function reportFailure({ env, gh }) {
  const guardFailed = env.GUARD_FAILED === "true";
  const body = bodyOf({
    runUrl: env.RUN_URL ?? "(no run URL)",
    guardFailed,
    failed: env.FAILED ?? "",
  });
  const run = (args, stdin) => {
    const r = gh(args, stdin);
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  if (guardFailed) {
    // --force updates a label that exists, so this never fails on a second run.
    run([
      "label",
      "create",
      GUARD_LABEL,
      "--force",
      "--color",
      "b60205",
      "--description",
      "A failed Guard probe: blocks the next release while open",
    ]);
  }
  const open = JSON.parse(
    run([
      "issue",
      "list",
      "--state",
      "open",
      "--author",
      "app/github-actions",
      "--limit",
      "100",
      "--json",
      "number,title",
    ]),
  ).find((issue) => issue.title === TITLE);
  if (!open) {
    const labels = guardFailed ? GUARD_LABELS : OTHER_LABELS;
    const url = run(
      [
        "issue",
        "create",
        "--title",
        TITLE,
        ...labels.flatMap((l) => ["--label", l]),
        "--body-file",
        "-",
      ],
      body,
    );
    return `Opened ${url}`;
  }
  const number = String(open.number);
  // Labelled first, so the release is blocked even if the comment fails.
  if (guardFailed) {
    // One triage role at a time: an issue opened for triage becomes the human's.
    run([
      "issue",
      "edit",
      number,
      ...GUARD_LABELS.flatMap((l) => ["--add-label", l]),
      ...OTHER_LABELS.flatMap((l) => ["--remove-label", l]),
    ]);
  }
  run(["issue", "comment", number, "--body-file", "-"], body);
  return `Added to issue ${number}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(
    reportFailure({
      env: process.env,
      gh: (args, input) => spawnSync("gh", args, { input, encoding: "utf8" }),
    }),
  );
}
