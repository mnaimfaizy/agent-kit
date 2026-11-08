// The rulesets docs/repository-hardening.md sets up, which keep the Claude
// GitHub App token away from the default branch, release branches and
// release tags. Each gap is a warning: the flows still run without them.

import { stripComment } from "../yaml-subset.mjs";
import { result } from "./result.mjs";

const HARDENING = "https://github.com/mnaimfaizy/agent-kit/blob/main/docs/repository-hardening.md";

function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Whether a ruleset's `conditions.ref_name` covers `ref`. */
export function coversRef(ruleset, ref, { defaultBranch } = {}) {
  const cond = ruleset.conditions?.ref_name ?? {};
  const matches = (p) =>
    p === "~ALL" ||
    (p === "~DEFAULT_BRANCH" && defaultBranch && ref === `refs/heads/${defaultBranch}`) ||
    globToRegExp(p).test(ref);
  return (cond.include ?? []).some(matches) && !(cond.exclude ?? []).some(matches);
}

/** Active rulesets with their full rules. Throws GhError on any API failure. */
export function loadRulesets(github, repo) {
  const ids = github.getLines(`repos/${repo}/rulesets?includes_parents=true`, ".[].id");
  return ids
    .map((id) => github.getJson(`repos/${repo}/rulesets/${Number(id)}`))
    .filter((r) => r.enforcement === "active");
}

const ruleTypes = (rulesets) =>
  new Set(rulesets.flatMap((r) => (r.rules ?? []).map((x) => x.type)));

export function checkUpdateRule(rulesets, { defaultBranch }) {
  const ref = `refs/heads/${defaultBranch}`;
  const covering = rulesets.filter(
    (r) => r.target === "branch" && coversRef(r, ref, { defaultBranch }),
  );
  if (ruleTypes(covering).has("update")) {
    return result(
      "ruleset-update",
      "Default branch has an update rule",
      "pass",
      `${defaultBranch} has an active update rule.`,
    );
  }
  return result(
    "ruleset-update",
    "Default branch has an update rule",
    "warn",
    `No active update rule on ${defaultBranch}.`,
    {
      details: [
        "A required pull request with zero approvals does not stop the Claude App merging its own pull request; an update rule does.",
        `Recipe: ${HARDENING}#1-default-branch-an-update-rule`,
      ],
    },
  );
}

export function checkCreationRule(rulesets) {
  const has = rulesets.some(
    (r) => r.target === "branch" && (r.rules ?? []).some((x) => x.type === "creation"),
  );
  if (has)
    return result(
      "ruleset-creation",
      "Release branches have a creation rule",
      "pass",
      "An active branch ruleset has a creation rule.",
    );
  return result(
    "ruleset-creation",
    "Release branches have a creation rule",
    "warn",
    "No active branch ruleset has a creation rule.",
    {
      details: [
        "If you cut releases from branches, stop anyone outside the bypass list creating one.",
        `Recipe: ${HARDENING}#2-release-branches-a-creation-rule`,
      ],
    },
  );
}

const TAG_RULES = ["creation", "update", "deletion"];

export function checkTagRuleset(rulesets) {
  const ID = "ruleset-tags";
  const TITLE = "Release tags have a v* tag ruleset";
  const covering = rulesets.filter((r) => r.target === "tag" && coversRef(r, "refs/tags/v1.0.0"));
  const recipe = `Recipe: ${HARDENING}#3-release-tags-a-v-tag-ruleset`;
  if (covering.length === 0) {
    return result(ID, TITLE, "warn", "No active tag ruleset covers v* tags.", {
      details: [recipe],
    });
  }
  const types = ruleTypes(covering);
  const missing = TAG_RULES.filter((t) => !types.has(t));
  if (missing.length) {
    return result(ID, TITLE, "warn", `The v* tag ruleset lacks: ${missing.join(", ")}.`, {
      details: [recipe],
    });
  }
  return result(
    ID,
    TITLE,
    "pass",
    "An active tag ruleset blocks creating, moving and deleting v* tags.",
  );
}

/**
 * Workflows that push tags with GITHUB_TOKEN: a `git push` of tags, with no
 * SSH deploy key in the same file.
 */
export function workflowsPushingTagsWithToken(files) {
  return files
    .filter(({ text }) => {
      const body = String(text)
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .map(stripComment)
        .join("\n");
      const pushes = body
        .split("\n")
        .some(
          (l) =>
            /\bgit\b.*\bpush\b/.test(l) &&
            /--tags|--follow-tags|refs\/tags\/|\bTAG\b|\btag\b/i.test(l),
        );
      const tagged = /\bgit\b[^\n]*\btag\b/.test(body) && /\bgit\b[^\n]*\bpush\b/.test(body);
      const ssh = /GIT_SSH_COMMAND|git@github\.com:|ssh:\/\//.test(body);
      return (pushes || tagged) && !ssh;
    })
    .map((f) => f.path);
}

export function checkPersonalTagPush({ ownerType, files }) {
  const ID = "release-tag-push";
  const TITLE = "Release tags can be pushed under the tag ruleset";
  if (ownerType !== "User") {
    return result(
      ID,
      TITLE,
      "pass",
      "Owned by an organization: the GitHub Actions app can be a ruleset bypass actor.",
    );
  }
  const offenders = workflowsPushingTagsWithToken(files);
  if (offenders.length === 0)
    return result(ID, TITLE, "pass", "No workflow pushes tags with GITHUB_TOKEN.");
  return result(
    ID,
    TITLE,
    "warn",
    "A personal-account repository whose workflow pushes tags with GITHUB_TOKEN.",
    {
      details: [
        ...offenders,
        "On a personal account the GitHub Actions app cannot bypass a tag ruleset, so these pushes are refused once v* tags are protected.",
        `Fix: ${HARDENING}#personal-account-repositories-pushing-release-tags`,
      ],
    },
  );
}
