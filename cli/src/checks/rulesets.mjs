// The rulesets docs/repository-hardening.md sets up, which keep the Claude
// GitHub App token away from the default branch, release branches and
// release tags. Each gap is a warning: the flows still run without them.
//
// A rule only counts when no one the App can act as is on the ruleset's
// bypass list: rulesets stack, so an actor on one ruleset's bypass list is
// still held by any other ruleset with the same rule that does not list it.

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

/**
 * Active rulesets with their full rules and bypass lists. `bypass_actors` is
 * only returned by the single-ruleset endpoint, and only to an admin, which
 * the local checks require. Throws GhError on any API failure.
 */
export function loadRulesets(github, repo) {
  const ids = github.getLines(`repos/${repo}/rulesets?includes_parents=true`, ".[].id");
  return ids
    .map((id) => github.getJson(`repos/${repo}/rulesets/${Number(id)}`))
    .filter((r) => r.enforcement === "active");
}

// Base repository roles as ruleset bypass actors (docs/repository-hardening.md).
const ADMIN_ROLE = 5;
const MAINTAIN_ROLE = 2;
const ROLE_NAMES = { 1: "Read", 2: "Maintain", 3: "Triage", 4: "Write", 5: "Admin" };

/**
 * Bypass actors that undo the ruleset's protection against the Claude App:
 * any GitHub App (the Claude App is an `Integration`), any repository role
 * below Maintain (the Write role, or a custom role), and, on a branch
 * ruleset, deploy keys. Admin, Maintain, teams and organization admins are
 * the intended bypass list; a DeployKey bypass on a tag ruleset is the
 * documented personal-account pattern.
 */
export function riskyBypassActors(ruleset) {
  const risky = [];
  for (const actor of ruleset.bypass_actors ?? []) {
    const type = actor.actor_type;
    if (type === "Integration") {
      risky.push(`a GitHub App (Integration ${actor.actor_id})`);
    } else if (type === "RepositoryRole" && ![ADMIN_ROLE, MAINTAIN_ROLE].includes(actor.actor_id)) {
      const name = ROLE_NAMES[actor.actor_id];
      risky.push(name ? `the ${name} role` : `custom repository role ${actor.actor_id}`);
    } else if (type === "DeployKey" && ruleset.target !== "tag") {
      risky.push("deploy keys");
    }
  }
  return risky;
}

const hasRule = (ruleset, type) => (ruleset.rules ?? []).some((x) => x.type === type);
const label = (r) => `"${r.name ?? `ruleset ${r.id}`}"`;

/**
 * For one rule type: the covering rulesets that have it, and whether any of
 * them has a clean bypass list.
 */
function ruleStatus(covering, type) {
  const withRule = covering.filter((r) => hasRule(r, type));
  const clean = withRule.filter((r) => riskyBypassActors(r).length === 0);
  const bypassed = withRule
    .filter((r) => !clean.includes(r))
    .map((r) => `${label(r)} lets ${riskyBypassActors(r).join(", ")} bypass its ${type} rule.`);
  return { present: withRule.length > 0, held: clean.length > 0, bypassed };
}

const BYPASS_ADVICE =
  "Keep the bypass list to Admin and Maintain: never a GitHub App, the Write role, or a team the App acts through.";

export function checkUpdateRule(rulesets, { defaultBranch }) {
  const ID = "ruleset-update";
  const TITLE = "Default branch has an update rule";
  const recipe = `Recipe: ${HARDENING}#1-default-branch-an-update-rule`;
  const ref = `refs/heads/${defaultBranch}`;
  const covering = rulesets.filter(
    (r) => r.target === "branch" && coversRef(r, ref, { defaultBranch }),
  );
  const s = ruleStatus(covering, "update");
  if (s.held) return result(ID, TITLE, "pass", `${defaultBranch} has an active update rule.`);
  if (s.present) {
    return result(ID, TITLE, "warn", `The update rule on ${defaultBranch} can be bypassed.`, {
      details: [...s.bypassed, BYPASS_ADVICE, recipe],
    });
  }
  return result(ID, TITLE, "warn", `No active update rule on ${defaultBranch}.`, {
    details: [
      "A required pull request with zero approvals does not stop the Claude App merging its own pull request; an update rule does.",
      recipe,
    ],
  });
}

export function checkCreationRule(rulesets) {
  const ID = "ruleset-creation";
  const TITLE = "Release branches have a creation rule";
  const recipe = `Recipe: ${HARDENING}#2-release-branches-a-creation-rule`;
  const s = ruleStatus(
    rulesets.filter((r) => r.target === "branch"),
    "creation",
  );
  if (s.held) return result(ID, TITLE, "pass", "An active branch ruleset has a creation rule.");
  if (s.present) {
    return result(ID, TITLE, "warn", "Every branch creation rule can be bypassed.", {
      details: [...s.bypassed, BYPASS_ADVICE, recipe],
    });
  }
  return result(ID, TITLE, "warn", "No active branch ruleset has a creation rule.", {
    details: [
      "If you cut releases from branches, stop anyone outside the bypass list creating one.",
      recipe,
    ],
  });
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
  const statuses = TAG_RULES.map((type) => [type, ruleStatus(covering, type)]);
  const missing = statuses.filter(([, s]) => !s.present).map(([t]) => t);
  const bypassed = statuses.filter(([, s]) => s.present && !s.held);
  if (missing.length || bypassed.length) {
    const parts = [];
    if (missing.length) parts.push(`lacks: ${missing.join(", ")}`);
    if (bypassed.length) parts.push(`can be bypassed: ${bypassed.map(([t]) => t).join(", ")}`);
    return result(ID, TITLE, "warn", `The v* tag ruleset ${parts.join("; ")}.`, {
      details: [
        ...new Set(bypassed.flatMap(([, s]) => s.bypassed)),
        ...(bypassed.length ? [BYPASS_ADVICE] : []),
        recipe,
      ],
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
