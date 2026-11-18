#!/usr/bin/env node
// Pattern guide skeleton: docs/patterns/merge-train.md in Agent-kit.
//
// The merge train's IO shell: the forge calls, the clock and the sleep, and
// nothing else. Every decision is in merge-train-core.mjs. Keep this file thin
// enough that reading it shows there is nothing in it to test.
//
//   <train command> <pr>... [--auto]
//
// Copy it into your repository, fill in each TODO(adopt), and delete the
// Pattern guide line above. It uses the GitHub CLI; swap the gh calls for your
// forge's. Exit 0 when every pull request merged (or the auto pass finished),
// 1 when the train stopped, 2 when it could not start.
import { spawnSync } from "node:child_process";

import {
  BASE,
  DEFAULT_POLL_SECONDS,
  DEFAULT_TIMEOUT_MINUTES,
  parseMode,
  requiredChecksFromRules,
  runAutoPass,
  runTrain,
} from "./merge-train-core.mjs";

// TODO(adopt): the mode setting, read from the base branch, never the working tree.
const MODE_FILE = "<path to your auto-merge mode file>";

const gh = (args) => spawnSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const ghJson = (args) => {
  const result = gh(args);
  try {
    return result.status === 0 ? JSON.parse(result.stdout) : null;
  } catch {
    return null;
  }
};

const repository = ghJson(["repo", "view", "--json", "nameWithOwner"])?.nameWithOwner;

const io = {
  // The branch-rules endpoint returns rulesets only. TODO(adopt): if your
  // required checks live in classic branch protection, read
  // `repos/<owner>/<repo>/branches/<base>/protection/required_status_checks`
  // (its `contexts`) instead, or merge both sources.
  requiredChecks: () =>
    requiredChecksFromRules(ghJson(["api", `repos/${repository}/rules/branches/${BASE}`])),
  read: (pr) => {
    const view = ghJson([
      "pr",
      "view",
      String(pr),
      "--json",
      "number,state,isDraft,baseRefName,headRefOid,mergeStateStatus,reviewDecision,body",
    ]);
    if (!view) return null;
    // `gh pr checks` exits non-zero while a check is pending or failed and
    // still prints the JSON, so read the output, not the exit status.
    const checks = gh(["pr", "checks", String(pr), "--json", "name,bucket,startedAt"]);
    let parsed = [];
    try {
      parsed = JSON.parse(checks.stdout || "[]");
    } catch {
      parsed = [];
    }
    return { ...view, checks: Array.isArray(parsed) ? parsed : [] };
  },
  update: (pr, head) =>
    gh([
      "api",
      "--method",
      "PUT",
      `repos/${repository}/pulls/${pr}/update-branch`,
      "-f",
      `expected_head_sha=${head}`,
    ]).status === 0,
  // `--match-head-commit` makes the forge refuse the merge if anything was
  // pushed after the checks were read. There is deliberately no `--admin`.
  // TODO(adopt): your merge method (--merge, --squash or --rebase).
  merge: (pr, head) =>
    gh(["pr", "merge", String(pr), "--squash", "--match-head-commit", head]).status === 0,
  sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
  now: () => Date.now(),
  log: (line) => console.log(`merge-train: ${line}`),
  // Auto-merge only. TODO(adopt): read each fact for `snapshot.headRefOid`;
  // anything you cannot read is { status: 'missing', reason }, which holds.
  facts: (pr, snapshot, checksGreen) => ({
    head: snapshot.headRefOid,
    requiredChecks: { status: checksGreen ? "green" : "not-green" },
    baseCi: {
      status: "missing",
      reason: "TODO(adopt): the latest completed run on the base branch",
    },
    review: { status: "missing", reason: "TODO(adopt): the review verdict and the head it names" },
    pathGuard: {
      status: "missing",
      reason: "TODO(adopt): changed files against the base branch's guarded paths",
    },
    reversible: {
      status: /^\*\*Reversible:\*\* no\b/m.test(snapshot.body ?? "") ? "no" : "unread",
    },
  }),
  // TODO(adopt): find the comment this login wrote that holds SHADOW_MARKER
  // and edit it; post a new one only when there is none.
  comment: (pr, body) => gh(["pr", "comment", String(pr), "--body", body]).status === 0,
};

function readMode() {
  if (gh(["--version"]).status !== 0) return "off";
  const fetched = spawnSync("git", ["fetch", "--quiet", "origin", BASE]);
  if (fetched.status !== 0) return "off";
  const shown = spawnSync("git", ["show", `origin/${BASE}:${MODE_FILE}`], { encoding: "utf8" });
  return parseMode(shown.status === 0 ? shown.stdout : null);
}

async function main(argv) {
  const auto = argv.includes("--auto");
  const numbers = argv.filter((arg) => arg !== "--auto").map(Number);
  if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n <= 0)) {
    console.error("merge-train: give one or more pull request numbers, in merge order");
    return 2;
  }
  if (new Set(numbers).size !== numbers.length) {
    console.error("merge-train: a pull request is listed twice; check the order you pasted");
    return 2;
  }
  if (!repository) {
    console.error("merge-train: gh is not installed, not logged in, or not in a repository");
    return 2;
  }
  const args = {
    pullRequests: numbers,
    pollSeconds: DEFAULT_POLL_SECONDS,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
  };

  if (auto) {
    const mode = readMode();
    const result = await runAutoPass({ ...args, mode }, io);
    console.log(`mode: ${mode}`);
    for (const pr of result.merged) console.log(`merged: #${pr}`);
    for (const pr of result.wouldMerge) console.log(`would merge: #${pr}`);
    for (const { pr, reason } of result.held) console.log(`held: #${pr}: ${reason}`);
    return 0;
  }

  const result = await runTrain(args, io);
  for (const pr of result.merged) console.log(`merged: #${pr}`);
  if (result.stoppedAt) {
    console.log(`stopped at #${result.stoppedAt.pr}: ${result.stoppedAt.reason}`);
    if (result.notReached.length > 0)
      console.log(`not reached: ${result.notReached.map((n) => `#${n}`).join(" ")}`);
    return 1;
  }
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
