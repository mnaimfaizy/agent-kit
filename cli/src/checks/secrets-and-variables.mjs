// Secrets and repository variables, worked out from the Consumer's Callers.
// A secret is required when the reusable workflow at the pinned tag declares
// the secret it is passed to as `required: true`; otherwise it is optional.
// A variable is optional when every read of it falls back with `||`.

import { secretNames } from "../callers.mjs";
import { parseWorkflowCallSecrets } from "../workflow-call.mjs";
import { byHand, command, NAME_PATTERN, result } from "./result.mjs";

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
  const specs = new Map();
  const specFor = (file) => {
    if (!specs.has(file)) {
      const text = readReusable(file);
      specs.set(file, text === null ? null : parseWorkflowCallSecrets(text));
    }
    return specs.get(file);
  };
  const addSecret = (names, required, where) => {
    // A GITHUB_* secret is always set, so an expression that falls back to one is too.
    if (names.some(isProvided)) return;
    const key = names.join(" || ");
    const prev = secrets.get(key);
    secrets.set(key, {
      names,
      required: Boolean(prev?.required || required),
      where: [...(prev?.where ?? []), where],
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
          addSecret([name.toUpperCase()], required, where);
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
        addSecret(names, declared.required, `${where} (${input})`);
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
  const { problems, unsupported = [] } = requirements;
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
  const missingOptional = requirements.secrets.filter((x) => !x.required && !isSet(x));
  const describe = (x) => `${x.names.join(" or ")} (${x.where.join(", ")})`;
  // No --body: gh prompts for the value, so it never lands in shell history.
  const { fix, notes } = splitFixes(
    [...missingRequired, ...missingOptional].map((x) => setCommand("secret", x.names[0], repo)),
  );
  const details = [
    ...problems,
    ...missingRequired.map((x) => `required, not set: ${describe(x)}`),
    ...missingOptional.map((x) => `optional, not set: ${describe(x)}`),
    ...unsupported,
    ...notes,
  ];
  if (listed.orgNote && (missingRequired.length || missingOptional.length)) {
    details.push(listed.orgNote);
  }
  if (missingRequired.length || problems.length) {
    const summary = missingRequired.length
      ? `${missingRequired.length} required secret(s) missing.`
      : `${problems.length} Caller problem(s) with secrets.`;
    return result(ID, TITLE, "fail", summary, { details, fix });
  }
  if (missingOptional.length) {
    return result(
      ID,
      TITLE,
      "warn",
      `${missingOptional.length} optional secret(s) referenced but not set.`,
      { details, fix },
    );
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
  return result(
    ID,
    TITLE,
    "pass",
    `All ${requirements.secrets.length} secret(s) the Callers pass are set.`,
  );
}

export function checkVariables({ github, repo, ownerType, requirements }) {
  const ID = "variables";
  const TITLE = "Repository variables the Callers read are set";
  let listed;
  try {
    listed = listNames(github, repo, "variable", ownerType);
  } catch (err) {
    return result(ID, TITLE, "skip", `Could not list repository variables: ${err.message}`);
  }
  const required = requirements.variables.filter((v) => !v.optional && !isProvided(v.name));
  const missing = required.filter((v) => !listed.names.has(v.name.toUpperCase()));
  if (missing.length === 0) {
    return result(ID, TITLE, "pass", `All ${required.length} required variable(s) are set.`);
  }
  const killSwitch = (name) => /_ENABLED$/.test(name);
  const details = missing.map(
    (v) =>
      `not set: ${v.name} (${v.where.join(", ")})` +
      (killSwitch(v.name) ? " — the Kill switch: the flow never runs until it is set to true" : ""),
  );
  if (listed.orgNote) details.push(listed.orgNote);
  // The Kill switch takes true; for anything else, gh prompts for the value.
  const { fix, notes } = splitFixes(
    missing.map((v) =>
      setCommand("variable", v.name, repo, killSwitch(v.name) ? ["--body", "true"] : []),
    ),
  );
  return result(ID, TITLE, "fail", `${missing.length} required variable(s) missing.`, {
    details: [...details, ...notes],
    fix,
  });
}
