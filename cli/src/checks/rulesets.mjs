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

/**
 * fnmatch with FNM_PATHNAME, the matching GitHub uses for ruleset ref
 * patterns: `*` and `?` stay within one path segment, a double star
 * followed by a slash matches zero or more whole segments, `[...]` is a character class (`[!...]` or `[^...]`
 * negates it), and `\` escapes the next character.
 */
export function fnmatchToRegExp(pattern) {
  let re = "";
  let i = 0;
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
      re += "(?:[^/]*/)*";
      i += 3;
    } else if (c === "*" && pattern[i + 1] === "*") {
      re += "[^/]*";
      i += 2;
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "\\" && i + 1 < pattern.length) {
      re += esc(pattern[i + 1]);
      i += 2;
    } else if (c === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close === -1) {
        re += "\\[";
        i += 1;
        continue;
      }
      let body = pattern.slice(i + 1, close);
      let negate = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        negate = true;
        body = body.slice(1);
      }
      const cls = body.replace(/[\\\]^]/g, "\\$&");
      re += negate ? `(?!/)[^${cls}]` : `[${cls}]`;
      i = close + 1;
    } else {
      re += esc(c);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Whether a ruleset's `conditions.ref_name` covers `ref`. */
export function coversRef(ruleset, ref, { defaultBranch } = {}) {
  // A ruleset with a pattern doctor cannot interpret is not counted at all.
  if (unreadablePatterns(ruleset).length) return false;
  const cond = ruleset.conditions?.ref_name ?? {};
  const matches = (p) =>
    p === "~ALL" ||
    (p === "~DEFAULT_BRANCH" && defaultBranch && ref === `refs/heads/${defaultBranch}`) ||
    fnmatchToRegExp(p).test(ref);
  return (cond.include ?? []).some(matches) && !(cond.exclude ?? []).some(matches);
}

/** The ref patterns of a ruleset that do not compile (an invalid range such as `[z-a]`). */
export function unreadablePatterns(ruleset) {
  const cond = ruleset.conditions?.ref_name ?? {};
  return [...(cond.include ?? []), ...(cond.exclude ?? [])].filter((p) => {
    if (typeof p !== "string") return true;
    if (p === "~ALL" || p === "~DEFAULT_BRANCH") return false;
    try {
      fnmatchToRegExp(p);
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * Note the rulesets of `target` that were not counted because a pattern could
 * not be interpreted. Rulesets only add restrictions, so a check that holds
 * without them stays a pass; one that does not is already a warning.
 */
function withPatternNotes(res, rulesets, target) {
  const notes = rulesets
    .filter((r) => r.target === target)
    .flatMap((r) =>
      unreadablePatterns(r).map(
        (p) =>
          `${label(r)}: pattern ${JSON.stringify(p)} could not be interpreted, so it was not counted.`,
      ),
    );
  if (notes.length === 0) return res;
  return { ...res, details: [...notes, ...res.details] };
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
  // Only an admin sees bypass lists, and an organization ruleset's may be
  // hidden even then: an unseen list is never assumed to be clean.
  if (!Array.isArray(ruleset.bypass_actors)) return ["a bypass list not visible to this login"];
  const risky = [];
  for (const actor of ruleset.bypass_actors) {
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

function updateRule(rulesets, { defaultBranch }) {
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

// Release-branch names a creation rule should cover; any one is enough.
const RELEASE_BRANCH_REFS = [
  "refs/heads/release/1.0.0",
  "refs/heads/releases/1.0.0",
  "refs/heads/release-1.0.0",
];

function creationRule(rulesets) {
  const ID = "ruleset-creation";
  const TITLE = "Release branches have a creation rule";
  const recipe = `Recipe: ${HARDENING}#2-release-branches-a-creation-rule`;
  const branchRulesets = rulesets.filter((r) => r.target === "branch");
  const covering = branchRulesets.filter((r) =>
    RELEASE_BRANCH_REFS.some((ref) => coversRef(r, ref)),
  );
  const s = ruleStatus(covering, "creation");
  if (s.held) {
    return result(ID, TITLE, "pass", "An active creation rule covers release branches.");
  }
  if (s.present) {
    return result(ID, TITLE, "warn", "Every release-branch creation rule can be bypassed.", {
      details: [...s.bypassed, BYPASS_ADVICE, recipe],
    });
  }
  const elsewhere = ruleStatus(branchRulesets, "creation").present;
  return result(
    ID,
    TITLE,
    "warn",
    elsewhere
      ? "A branch creation rule exists, but none covers a release/* branch."
      : "No active branch ruleset has a creation rule.",
    {
      details: [
        "If you cut releases from branches, stop anyone outside the bypass list creating one.",
        `Checked against ${RELEASE_BRANCH_REFS.join(", ")}.`,
        recipe,
      ],
    },
  );
}

const TAG_RULES = ["creation", "update", "deletion"];

// A stable and a pre-release tag: the v* ruleset must cover both.
const TAG_REFS = ["refs/tags/v1.0.0", "refs/tags/v1.0.0-alpha.1"];

function tagRuleset(rulesets) {
  const ID = "ruleset-tags";
  const TITLE = "Release tags have a v* tag ruleset";
  const recipe = `Recipe: ${HARDENING}#3-release-tags-a-v-tag-ruleset`;
  const problems = [];
  const details = new Set();
  for (const ref of TAG_REFS) {
    const covering = rulesets.filter((r) => r.target === "tag" && coversRef(r, ref));
    if (covering.length === 0) {
      problems.push(`no active tag ruleset covers ${ref.slice("refs/tags/".length)}`);
      continue;
    }
    const statuses = TAG_RULES.map((type) => [type, ruleStatus(covering, type)]);
    const missing = statuses.filter(([, st]) => !st.present).map(([t]) => t);
    const bypassed = statuses.filter(([, st]) => st.present && !st.held);
    const tag = ref.slice("refs/tags/".length);
    if (missing.length) problems.push(`${tag} lacks: ${missing.join(", ")}`);
    if (bypassed.length) {
      problems.push(`${tag} can be bypassed: ${bypassed.map(([t]) => t).join(", ")}`);
      for (const [, st] of bypassed) for (const d of st.bypassed) details.add(d);
      details.add(BYPASS_ADVICE);
    }
  }
  if (problems.length) {
    const unique = [...new Set(problems)];
    return result(ID, TITLE, "warn", `The v* tag ruleset: ${unique.join("; ")}.`, {
      details: [...details, recipe],
    });
  }
  return result(
    ID,
    TITLE,
    "pass",
    "An active tag ruleset blocks creating, moving and deleting v* tags, pre-releases included.",
  );
}

export function checkUpdateRule(rulesets, opts) {
  return withPatternNotes(updateRule(rulesets, opts), rulesets, "branch");
}

export function checkCreationRule(rulesets) {
  return withPatternNotes(creationRule(rulesets), rulesets, "branch");
}

export function checkTagRuleset(rulesets) {
  return withPatternNotes(tagRuleset(rulesets), rulesets, "tag");
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
