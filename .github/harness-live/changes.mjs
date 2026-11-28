// Whether a run of harness-live.yml needs the live suite: on a pull request,
// when a file it changes is one the suite proves (paths.mjs); on any other
// event, always. It writes the step output `run`, true or false.
//
// It reads the changes from git: the checked-out merge commit against its
// first parent, the base. When git cannot say, it fails rather than skip.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { needsSuite } from "./paths.mjs";

/**
 * @param {{ env: Record<string, string | undefined>, git: (args: string[]) => { status: number | null, stdout: string, stderr: string } }} io
 * @returns {boolean}
 */
export function suiteNeeded({ env, git }) {
  if (env.GITHUB_EVENT_NAME !== "pull_request") return true;
  // Both sides of a rename: moving a file out of these paths counts too.
  const r = git(["diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD"]);
  if (r.status !== 0)
    throw new Error(`could not list the pull request's changes: ${r.stderr.trim()}`);
  return needsSuite(r.stdout.split("\0").filter(Boolean));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = suiteNeeded({
    env: process.env,
    git: (args) => spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
  });
  console.log(run ? "The live suite runs." : "Nothing the live suite proves is changed.");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
}
