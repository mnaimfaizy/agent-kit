// `agent-kit doctor`: read-only checks of a Consumer repository against the
// Agent-kit tag its Callers pin. Local mode (an admin `gh` login) runs every
// check; CI mode runs only the file and pin checks and lists the rest as
// skipped. A skipped check is never reported as passed.

import { readWorkflows } from "./callers.mjs";
import { checkClaudeApp } from "./checks/claude-app.mjs";
import { checkKitOwnedTrees } from "./checks/kit-owned-trees.mjs";
import { checkLabels } from "./checks/labels.mjs";
import { checkPins } from "./checks/pins.mjs";
import { result } from "./checks/result.mjs";
import {
  checkCreationRule,
  checkPersonalTagPush,
  checkTagRuleset,
  checkUpdateRule,
  loadRulesets,
} from "./checks/rulesets.mjs";
import {
  checkSecrets,
  checkVariables,
  deriveRequirements,
} from "./checks/secrets-and-variables.mjs";
import { firstLine } from "./exec.mjs";
import { createGitHub } from "./github.mjs";
import { openKitTag, PreManifestTagError } from "./kit-tag.mjs";

/** The checks that need a `gh` login with admin on the repository. */
export const LOCAL_ONLY_CHECKS = [
  ["secrets", "Secrets the Callers pass are set"],
  ["variables", "Repository variables the Callers read are set"],
  ["trigger-labels", "Trigger labels exist"],
  ["claude-app", "Claude GitHub App installed"],
  ["ruleset-update", "Default branch has an update rule"],
  ["ruleset-creation", "Release branches have a creation rule"],
  ["ruleset-tags", "Release tags have a v* tag ruleset"],
  ["release-tag-push", "Release tags can be pushed under the tag ruleset"],
];

const skipAll = (ids, reason) => ids.map(([id, title]) => result(id, title, "skip", reason));

/**
 * @param {{
 *   cwd: string,
 *   runner: import("./exec.mjs").Runner,
 *   ci?: boolean,
 *   strict?: boolean,
 *   repo?: string,
 *   openTag?: typeof openKitTag,
 * }} opts
 * @returns {{ mode: "local" | "ci", modeReason: string | null, repo: string | null, tag: string | null, results: object[], refusal: string | null, exitCode: number }}
 */
export function runDoctor({
  cwd,
  runner,
  ci = false,
  strict = false,
  repo: repoArg,
  openTag = openKitTag,
}) {
  const results = [];
  let mode = ci ? "ci" : "local";
  let modeReason = ci ? "--ci" : null;

  // Which repository, and may this login read its settings?
  let info = null;
  if (!ci) {
    const github = createGitHub(runner, { cwd });
    try {
      info = repoInfo(github, repoArg);
      if (!info.admin) {
        mode = "ci";
        modeReason = `your gh login is not an admin on ${info.repo}`;
      }
    } catch (err) {
      mode = "ci";
      modeReason = `gh could not read the repository (${firstLine(err.message)})`;
    }
  }

  let root = cwd;
  const top = runner("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (top.status === 0) root = top.stdout.trim();
  else {
    results.push(result("pins", "uses: pins agree", "fail", `${cwd} is not a git repository.`));
    return finish({
      mode,
      modeReason,
      repo: info?.repo ?? null,
      tag: null,
      results,
      refusal: null,
      strict,
    });
  }

  const { files, callers } = readWorkflows(root);
  const pins = checkPins(files);
  results.push(pins.result);

  let snapshot = null;
  let refusal = null;
  if (pins.tag) {
    try {
      snapshot = openTag({ runner, repo: pins.repo, tag: pins.tag });
    } catch (err) {
      if (err instanceof PreManifestTagError) refusal = err.message;
      else
        results.push(
          result("kit-owned-trees", "Kit-owned paths match the pinned tag", "fail", err.message),
        );
    }
  } else {
    results.push(
      result(
        "kit-owned-trees",
        "Kit-owned paths match the pinned tag",
        "skip",
        "No single pinned tag to compare against.",
      ),
    );
  }
  if (refusal) {
    return finish({
      mode,
      modeReason,
      repo: info?.repo ?? null,
      tag: pins.tag,
      results,
      refusal,
      strict,
    });
  }

  try {
    if (snapshot) {
      try {
        results.push(checkKitOwnedTrees({ runner, cwd: root, snapshot }));
      } catch (err) {
        results.push(
          result("kit-owned-trees", "Kit-owned paths match the pinned tag", "fail", err.message),
        );
      }
    }

    if (mode === "ci") {
      results.push(
        ...skipAll(
          LOCAL_ONLY_CHECKS,
          `CI mode (${modeReason}): needs a local run with an admin gh login.`,
        ),
      );
    } else {
      results.push(...localChecks({ runner, cwd, info, files, callers, snapshot }));
    }
  } finally {
    snapshot?.cleanup();
  }
  return finish({
    mode,
    modeReason,
    repo: info?.repo ?? null,
    tag: pins.tag,
    results,
    refusal: null,
    strict,
  });
}

function repoInfo(github, repoArg) {
  return github.repoInfo(repoArg);
}

function localChecks({ runner, cwd, info, files, callers, snapshot }) {
  const github = createGitHub(runner, { cwd });
  const { repo, owner, ownerType, defaultBranch } = info;
  const out = [];

  if (snapshot) {
    const requirements = deriveRequirements(callers, (file) =>
      snapshot.readFile(`.github/workflows/${file}`),
    );
    out.push(checkSecrets({ github, repo, ownerType, requirements }));
    out.push(checkVariables({ github, repo, ownerType, requirements }));
  } else {
    out.push(
      ...skipAll(
        LOCAL_ONLY_CHECKS.slice(0, 2),
        "Needs the pinned tag's reusable workflows; fix the pins first.",
      ),
    );
  }

  if (callers.length) out.push(checkLabels({ github, repo, callers }));
  else
    out.push(
      result(
        "trigger-labels",
        "Trigger labels exist",
        "skip",
        "No Caller to read Trigger labels from.",
      ),
    );

  out.push(checkClaudeApp({ github, repo, owner, ownerType }));

  let rulesets = null;
  let rulesetError = null;
  try {
    rulesets = loadRulesets(github, repo);
  } catch (err) {
    rulesetError = `Could not read rulesets: ${err.message}`;
  }
  if (rulesets) {
    out.push(checkUpdateRule(rulesets, { defaultBranch }));
    out.push(checkCreationRule(rulesets));
    out.push(checkTagRuleset(rulesets));
  } else {
    out.push(...skipAll(LOCAL_ONLY_CHECKS.slice(4, 7), rulesetError));
  }
  out.push(checkPersonalTagPush({ ownerType, files }));
  return out;
}

function finish({ mode, modeReason, repo, tag, results, refusal, strict }) {
  const final = strict
    ? results.map((r) => (r.status === "warn" ? { ...r, status: "fail", strict: true } : r))
    : results;
  const failed = refusal !== null || final.some((r) => r.status === "fail");
  return { mode, modeReason, repo, tag, results: final, refusal, exitCode: failed ? 1 : 0 };
}

const LABEL = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

/** Plain-text report. */
export function formatReport(report, { version } = {}) {
  const lines = [];
  lines.push(`agent-kit doctor${version ? ` ${version}` : ""}`);
  lines.push(`  repository: ${report.repo ?? "(unknown)"}`);
  lines.push(`  pinned tag: ${report.tag ?? "(none)"}`);
  lines.push(`  mode:       ${report.mode}${report.modeReason ? ` (${report.modeReason})` : ""}`);
  lines.push("");
  if (report.refusal) {
    for (const r of report.results) lines.push(...formatResult(r));
    lines.push(`REFUSED  ${report.refusal}`);
    lines.push("");
    lines.push("Result: refused (exit 1).");
    return lines.join("\n");
  }
  for (const r of report.results) lines.push(...formatResult(r));
  const count = (s) => report.results.filter((r) => r.status === s).length;
  const skipped = report.results.filter((r) => r.status === "skip");
  lines.push("");
  lines.push(
    `Result: ${count("fail")} failed, ${count("warn")} warning(s), ${skipped.length} skipped, ${count("pass")} passed (exit ${report.exitCode}).`,
  );
  if (skipped.length) {
    lines.push(
      `Skipped checks did not run and are not passes: ${skipped.map((r) => r.id).join(", ")}.`,
    );
  }
  return lines.join("\n");
}

function formatResult(r) {
  const out = [
    `${LABEL[r.status]}  ${r.title}: ${r.summary}${r.strict ? " (warning; failed by --strict)" : ""}`,
  ];
  for (const d of r.details) out.push(`      ${d}`);
  for (const f of r.fix) out.push(`      $ ${f}`);
  return out;
}
