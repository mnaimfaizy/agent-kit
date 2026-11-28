// Secrets and repository variables, worked out from the Consumer's Callers.
// A secret is required when the reusable workflow at the pinned tag declares
// the secret it is passed to as `required: true`; otherwise it is optional.
// The model credentials are optional there, because only the chosen harness
// needs one (ADR 0030), so they are asked for as a group.
// A variable is optional when every read of it falls back with `||`.

import { secretNames } from "../callers.mjs";
import { parseWorkflowCallSecrets } from "../workflow-call.mjs";
import { byHand, command, NAME_PATTERN, result } from "./result.mjs";

/** The secret inputs `claude-code` accepts, the preferred one first (ADR 0024). */
const CLAUDE_CODE_INPUTS = ["claude_code_oauth_token", "anthropic_api_key"];
/**
 * The Deep scan takes exactly one of the two (its first step fails on both),
 * and the API key is its supported one.
 */
const DEEP_SCAN_REUSABLE = "deep-scan-reusable.yml";
const preferred = (file) =>
  file === DEEP_SCAN_REUSABLE ? [...CLAUDE_CODE_INPUTS].reverse() : CLAUDE_CODE_INPUTS;
/** Every model credential input: the others belong to harnesses no Stage runs yet. */
const MODEL_INPUTS = new Set([
  ...CLAUDE_CODE_INPUTS,
  "openai_api_key",
  "gemini_api_key",
  "cursor_api_key",
]);

/** GitHub provides `secrets.GITHUB_TOKEN`; no `GITHUB_*` secret can be set by hand. */
const isProvided = (name) => /^github_/i.test(name);

/** Caller parts doctor could not read fully: reported, never assumed fine. */
function unreadable(callers) {
  const out = [];
  for (const caller of callers) {
    if (caller.parseIncomplete) out.push(`${caller.path}: ${caller.parseIncomplete}`);
    for (const job of caller.jobs) {
      if (job.secretsUnsupported) {
        out.push(
          `${caller.path}:${job.name}: ${job.secretsUnsupported}; its secrets were not checked.`,
        );
      }
    }
  }
  return out;
}

/** The variables every Caller reads. Needs no tag. */
export function deriveVariables(callers) {
  const variables = new Map();
  for (const caller of callers) {
    for (const v of caller.variables) {
      const prev = variables.get(v.name);
      variables.set(v.name, {
        name: v.name,
        optional: prev ? prev.optional && v.optional : v.optional,
        where: [...(prev?.where ?? []), caller.path],
      });
    }
  }
  return [...variables.values()];
}

/**
 * @param {{ path: string, jobs: object[], variables: { name: string, optional: boolean }[] }[]} callers
 * @param {(workflowFile: string) => string | null} readReusable reads .github/workflows/<file> at the pinned tag
 */
export function deriveRequirements(callers, readReusable) {
  const secrets = new Map();
  const problems = [];
  const noCredential = [];
  const specs = new Map();
  const specFor = (file) => {
    if (!specs.has(file)) {
      const text = readReusable(file);
      specs.set(file, text === null ? null : parseWorkflowCallSecrets(text));
    }
    return specs.get(file);
  };
  // `shown` is false under `secrets: inherit`, where the Caller writes no input.
  const addSecret = (names, required, job, file, input, shown = true) => {
    // A GITHUB_* secret is always set, so an expression that falls back to one is too.
    if (names.some(isProvided)) return;
    const key = names.join(" || ");
    const prev = secrets.get(key);
    secrets.set(key, {
      names,
      required: Boolean(prev?.required || required),
      where: [...(prev?.where ?? []), shown ? `${job} (${input})` : job],
      // The job, the reusable workflow it calls and the secret input each use fills.
      uses: [...(prev?.uses ?? []), { job, file, input: input.toLowerCase() }],
    });
  };

  for (const caller of callers) {
    for (const job of caller.jobs) {
      const where = `${caller.path}:${job.name}`;
      if (job.secretsUnsupported) continue;
      const spec = specFor(job.uses.file);
      if (spec === null) {
        problems.push(`${where}: ${job.uses.file} is not a reusable workflow at the pinned tag`);
        continue;
      }
      if (job.secrets === "inherit") {
        for (const { name, required } of spec.values()) {
          // Inherited, the secret's name is the input's.
          addSecret([name.toUpperCase()], required, where, job.uses.file, name, false);
        }
        continue;
      }
      const passed = new Set(Object.keys(job.secrets).map((k) => k.toLowerCase()));
      for (const [input, value] of Object.entries(job.secrets)) {
        const names = secretNames(value);
        if (names.length === 0) continue;
        const declared = spec.get(input.toLowerCase());
        if (!declared) {
          problems.push(
            `${where}: passes secret ${JSON.stringify(input)}, which ${job.uses.file} does not declare`,
          );
          continue;
        }
        addSecret(names, declared.required, where, job.uses.file, input);
      }
      // Optional in the workflow, so nothing refuses a job without either.
      const accepted = CLAUDE_CODE_INPUTS.filter((input) => spec.has(input));
      if (
        accepted.length &&
        accepted.every((input) => !spec.get(input).required && !passed.has(input))
      ) {
        noCredential.push(
          `${where} passes neither ${CLAUDE_CODE_INPUTS.join(" nor ")} to ${job.uses.file}; ` +
            "the run fails without one",
        );
      }
      for (const { name, required } of spec.values()) {
        if (required && !passed.has(name.toLowerCase())) {
          problems.push(
            `${where}: does not pass required secret ${JSON.stringify(name)} to ${job.uses.file}`,
          );
        }
      }
    }
  }
  return {
    secrets: [...secrets.values()],
    variables: deriveVariables(callers),
    problems,
    noCredential,
    unsupported: unreadable(callers),
  };
}

function listNames(github, repo, kind, ownerType) {
  const key = kind === "secret" ? "secrets" : "variables";
  const names = new Set(github.getLines(`repos/${repo}/actions/${key}`, `.${key}[].name`));
  let orgNote = null;
  if (ownerType === "Organization") {
    try {
      for (const n of github.getLines(
        `repos/${repo}/actions/organization-${key}`,
        `.${key}[].name`,
      )) {
        names.add(n);
      }
    } catch {
      orgNote = `Organization ${key} could not be read; one reported missing may be set at the organization.`;
    }
  }
  return { names: new Set([...names].map((n) => n.toUpperCase())), orgNote };
}

const isModelCredential = (x) =>
  !x.required && x.uses.every(({ input }) => MODEL_INPUTS.has(input));

/**
 * Each job that passes a Claude Code secret, with what it passes, the preferred
 * input of its workflow first.
 */
function claudeCodeJobs(secrets) {
  const jobs = new Map();
  for (const secret of secrets) {
    for (const { job, file, input } of secret.uses) {
      if (!CLAUDE_CODE_INPUTS.includes(input)) continue;
      if (!jobs.has(job)) jobs.set(job, { file, passed: [] });
      jobs.get(job).passed.push({ secret, rank: preferred(file).indexOf(input) });
    }
  }
  for (const { passed } of jobs.values()) passed.sort((a, b) => a.rank - b.rank);
  return jobs;
}

/** Jobs grouped under the secrets a message names: those that need the same ones together. */
function byNames(entries, joiner) {
  const groups = new Map();
  for (const { job, secrets } of entries) {
    const names = secrets.map((x) => x.names.join(" or ")).join(joiner);
    if (!groups.has(names)) groups.set(names, { names, first: secrets[0], where: [] });
    groups.get(names).where.push(job);
  }
  return [...groups.values()];
}

/**
 * The jobs left with no model credential: for each, the secrets that would give
 * `claude-code`, the one harness that runs a Stage, its credential.
 */
function jobsWithoutCredential(jobs, isSet) {
  const missing = [];
  for (const [job, { passed }] of jobs) {
    // A required one is reported as missing on its own.
    if (passed.some(({ secret }) => secret.required || isSet(secret))) continue;
    missing.push({ job, secrets: passed.map((x) => x.secret) });
  }
  return byNames(missing, " or ");
}

/** The Deep scan jobs with more than one model credential set, which fail every run. */
function jobsWithTwoCredentials(jobs, isSet) {
  const doubled = [];
  for (const [job, { file, passed }] of jobs) {
    if (file !== DEEP_SCAN_REUSABLE) continue;
    const set = passed.map((x) => x.secret).filter(isSet);
    if (set.length > 1) doubled.push({ job, secrets: set });
  }
  return byNames(doubled, " and ");
}

/** `gh secret set` / `gh variable set` for a valid name, or a by-hand note. */
function setCommand(kind, name, repo, extra = []) {
  if (!NAME_PATTERN.test(name)) return { note: byHand(`${kind} named`, name) };
  return { cmd: command("gh", kind, "set", name, "--repo", repo, ...extra) };
}

function splitFixes(items) {
  return {
    fix: items.filter((i) => i.cmd).map((i) => i.cmd),
    notes: items.filter((i) => i.note).map((i) => i.note),
  };
}

export function checkSecrets({ github, repo, ownerType, requirements }) {
  const ID = "secrets";
  const TITLE = "Secrets the Callers pass are set";
  const { problems, noCredential = [], unsupported = [] } = requirements;
  let listed;
  try {
    listed = listNames(github, repo, "secret", ownerType);
  } catch (err) {
    // Problems found in the Caller files need no API call: they still fail.
    if (problems.length) {
      return result(ID, TITLE, "fail", `${problems.length} Caller problem(s) with secrets.`, {
        details: [
          ...problems,
          ...unsupported,
          `Could not list repository secrets, so unset secrets were not checked: ${err.message}`,
        ],
      });
    }
    return result(ID, TITLE, "skip", `Could not list repository secrets: ${err.message}`, {
      details: unsupported,
    });
  }
  const isSet = (x) => x.names.some((n) => listed.names.has(n.toUpperCase()));
  const missingRequired = requirements.secrets.filter((x) => x.required && !isSet(x));
  const missingOptional = requirements.secrets.filter(
    (x) => !x.required && !isModelCredential(x) && !isSet(x),
  );
  const claudeCode = claudeCodeJobs(requirements.secrets);
  const uncredentialed = jobsWithoutCredential(claudeCode, isSet);
  const doubled = jobsWithTwoCredentials(claudeCode, isSet);
  const describe = (x) => `${x.names.join(" or ")} (${x.where.join(", ")})`;
  // No --body: gh prompts for the value, so it never lands in shell history.
  const wanted = [...missingRequired, ...uncredentialed.map((x) => x.first), ...missingOptional];
  const { fix, notes } = splitFixes(
    [...new Set(wanted.map((x) => x.names[0]))].map((name) => setCommand("secret", name, repo)),
  );
  const details = [
    ...problems,
    ...doubled.map(
      (x) =>
        `two model credentials set: ${x.names} (${x.where.join(", ")}); every run fails. ` +
        "Delete one: the API key is the supported path.",
    ),
    ...missingRequired.map((x) => `required, not set: ${describe(x)}`),
    ...uncredentialed.map(
      (x) =>
        `no model credential set: ${x.names} (${x.where.join(", ")}); the run fails without one`,
    ),
    ...missingOptional.map((x) => `optional, not set: ${describe(x)}`),
    ...noCredential,
    ...unsupported,
    ...notes,
  ];
  if (listed.orgNote && wanted.length) {
    details.push(listed.orgNote);
  }
  if (missingRequired.length || problems.length || doubled.length) {
    const summary = [
      missingRequired.length && `${missingRequired.length} required secret(s) missing.`,
      doubled.length && "Two model credentials are set for the Deep scan.",
      problems.length && `${problems.length} Caller problem(s) with secrets.`,
    ]
      .filter(Boolean)
      .join(" ");
    return result(ID, TITLE, "fail", summary, { details, fix });
  }
  const bare = uncredentialed.length + noCredential.length;
  if (bare || missingOptional.length) {
    const summary = [
      bare && "Some jobs have no model credential.",
      missingOptional.length &&
        `${missingOptional.length} optional secret(s) referenced but not set.`,
    ]
      .filter(Boolean)
      .join(" ");
    return result(ID, TITLE, "warn", summary, { details, fix });
  }
  if (unsupported.length) {
    return result(
      ID,
      TITLE,
      "skip",
      `${unsupported.length} Caller part(s) doctor could not read; their secrets were not checked.`,
      { details: unsupported },
    );
  }
  return result(ID, TITLE, "pass", "Every secret the Callers need is set.");
}

/**
 * Variables the kit renamed (ADR 0009, then ADR 0022), old name to new: the
 * Deprecation register's variable entries. A replacement may be an old name
 * itself. The Callers have no fallback to an old name, so one still set does
 * nothing once the Caller reads a newer one.
 */
export const RENAMED_VARIABLES = {
  CLAUDE_PIPELINE_ENABLED: "CLAUDE_AGENT_FLOW_ENABLED",
  CLAUDE_MODEL_PLAN: "CLAUDE_PLAN_MODEL",
  CLAUDE_MODEL_IMPLEMENT: "CLAUDE_IMPLEMENT_MODEL",
  CLAUDE_MODEL_REVIEW: "CLAUDE_REVIEW_MODEL",
  CLAUDE_MODEL_REVIEW_RESPONSE: "CLAUDE_REVIEW_RESPONSE_MODEL",
  CLAUDE_MODEL_AUDIT: "CLAUDE_SECURITY_AUDIT_MODEL",
  CLAUDE_AGENT_FLOW_ENABLED: "AGENT_KIT_AGENT_FLOW_ENABLED",
  CLAUDE_SECURITY_AUDIT_ENABLED: "AGENT_KIT_SECURITY_AUDIT_ENABLED",
  CLAUDE_REVIEW_RESPONSE_ENABLED: "AGENT_KIT_REVIEW_RESPONSE_ENABLED",
  CLAUDE_DEEP_SCAN_ENABLED: "AGENT_KIT_DEEP_SCAN_ENABLED",
  CLAUDE_PLAN_ENABLED: "AGENT_KIT_PLAN_ENABLED",
  CLAUDE_IMPLEMENT_ENABLED: "AGENT_KIT_IMPLEMENT_ENABLED",
  CLAUDE_REVIEW_ENABLED: "AGENT_KIT_REVIEW_ENABLED",
  CLAUDE_MODEL: "AGENT_KIT_MODEL",
  CLAUDE_EFFORT: "AGENT_KIT_EFFORT",
  CLAUDE_PLAN_MODEL: "AGENT_KIT_PLAN_MODEL",
  CLAUDE_PLAN_EFFORT: "AGENT_KIT_PLAN_EFFORT",
  CLAUDE_IMPLEMENT_MODEL: "AGENT_KIT_IMPLEMENT_MODEL",
  CLAUDE_IMPLEMENT_EFFORT: "AGENT_KIT_IMPLEMENT_EFFORT",
  CLAUDE_REVIEW_MODEL: "AGENT_KIT_REVIEW_MODEL",
  CLAUDE_REVIEW_EFFORT: "AGENT_KIT_REVIEW_EFFORT",
  CLAUDE_REVIEW_RESPONSE_MODEL: "AGENT_KIT_REVIEW_RESPONSE_MODEL",
  CLAUDE_REVIEW_RESPONSE_EFFORT: "AGENT_KIT_REVIEW_RESPONSE_EFFORT",
  CLAUDE_SECURITY_AUDIT_MODEL: "AGENT_KIT_SECURITY_AUDIT_MODEL",
  CLAUDE_SECURITY_AUDIT_EFFORT: "AGENT_KIT_SECURITY_AUDIT_EFFORT",
  CLAUDE_DEEP_SCAN_MODEL: "AGENT_KIT_DEEP_SCAN_MODEL",
  CLAUDE_DEEP_SCAN_EFFORT: "AGENT_KIT_DEEP_SCAN_EFFORT",
  CLAUDE_REVIEW_RESPONSE_MODE: "AGENT_KIT_REVIEW_RESPONSE_MODE",
};

/** The first name `read` holds among those `oldName` was renamed to, or null. */
function replacementRead(oldName, read) {
  let name = RENAMED_VARIABLES[oldName];
  while (name && !read.has(name)) name = RENAMED_VARIABLES[name];
  return name ?? null;
}

const killSwitch = (name) => /_ENABLED$/.test(name);

export function checkVariables({ github, repo, ownerType, requirements }) {
  const ID = "variables";
  const TITLE = "Repository variables the Callers read are set";
  let listed;
  try {
    listed = listNames(github, repo, "variable", ownerType);
  } catch (err) {
    return result(ID, TITLE, "skip", `Could not list repository variables: ${err.message}`);
  }
  const isSet = (name) => listed.names.has(name.toUpperCase());
  const required = requirements.variables.filter((v) => !v.optional && !isProvided(v.name));
  const missing = required.filter((v) => !isSet(v.name));
  // An old name still set while a Caller reads its replacement: the value is ignored.
  const read = new Map(requirements.variables.map((v) => [v.name.toUpperCase(), v]));
  const renamed = Object.keys(RENAMED_VARIABLES)
    .filter(isSet)
    .map((oldName) => ({ oldName, newName: replacementRead(oldName, read) }))
    .filter(({ newName }) => newName)
    .map((r) => ({ ...r, v: read.get(r.newName), stillRead: read.get(r.oldName) }));
  if (missing.length === 0 && renamed.length === 0) {
    return result(ID, TITLE, "pass", `All ${required.length} required variable(s) are set.`);
  }
  const details = [
    ...missing.map(
      (v) =>
        `not set: ${v.name} (${v.where.join(", ")})` +
        (killSwitch(v.name)
          ? " — the Kill switch: the flow never runs until it is set to true"
          : ""),
    ),
    ...renamed.map(({ oldName, newName, v, stillRead }) => {
      const start = `renamed: ${oldName} is still set, but ${newName} replaces it (${v.where.join(", ")}). `;
      // Callers part-way through an upgrade: the old name still does something.
      if (stillRead) {
        return (
          `${start}${oldName} is still read by ${stillRead.where.join(", ")}: ` +
          (isSet(newName) ? "" : `set ${newName} to its value, and `) +
          `delete ${oldName} once no Caller reads it.`
        );
      }
      return (
        `${start}${oldName} is ignored: ` +
        (isSet(newName)
          ? `${newName} is set too, so delete ${oldName}.`
          : `set ${newName} to its value, then delete ${oldName}.`)
      );
    }),
  ];
  if (listed.orgNote && missing.length) details.push(listed.orgNote);
  // A missing Kill switch takes true; for anything else, gh prompts for the
  // value: a renamed Stage switch may have been set to false.
  const turnsOn = new Set(missing.map((v) => v.name));
  const toSet = [
    ...missing.map((v) => v.name),
    ...renamed.filter((r) => !isSet(r.newName)).map((r) => r.newName),
  ].filter((name, i, all) => all.indexOf(name) === i);
  const { fix, notes } = splitFixes(
    toSet.map((name) =>
      setCommand(
        "variable",
        name,
        repo,
        turnsOn.has(name) && killSwitch(name) ? ["--body", "true"] : [],
      ),
    ),
  );
  // Each old name goes last, once its replacement has a value: deleting first
  // would lose the value before it is copied. The old names are the kit's own.
  for (const { oldName } of renamed.filter((r) => !r.stillRead)) {
    fix.push(command("gh", "variable", "delete", oldName, "--repo", repo));
  }
  if (missing.length) {
    return result(ID, TITLE, "fail", `${missing.length} required variable(s) missing.`, {
      details: [...details, ...notes],
      fix,
    });
  }
  return result(
    ID,
    TITLE,
    "warn",
    `${renamed.length} renamed variable(s) still set under the old name.`,
    { details: [...details, ...notes], fix },
  );
}
