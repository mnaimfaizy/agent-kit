// Secrets and repository variables, worked out from the Consumer's Callers.
// A secret is required when the reusable workflow at the pinned tag declares
// the secret it is passed to as `required: true`; otherwise it is optional.
// A variable is optional when every read of it falls back with `||`.

import { secretNames } from "../callers.mjs";
import { parseWorkflowCallSecrets } from "../workflow-call.mjs";
import { result } from "./result.mjs";

/**
 * @param {{ path: string, jobs: object[], variables: { name: string, optional: boolean }[] }[]} callers
 * @param {(workflowFile: string) => string | null} readReusable reads .github/workflows/<file> at the pinned tag
 */
export function deriveRequirements(callers, readReusable) {
  const secrets = new Map(); // NAME -> { name, required, alternatives: string[], where: string[] }
  const variables = new Map();
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
      const spec = specFor(job.uses.file);
      if (spec === null) {
        problems.push(`${where}: ${job.uses.file} is not a reusable workflow at the pinned tag`);
        continue;
      }
      if (job.secrets === "inherit") {
        for (const { name, required } of spec.values())
          addSecret([name.toUpperCase()], required, where);
        continue;
      }
      const passed = new Set(Object.keys(job.secrets).map((k) => k.toLowerCase()));
      for (const [input, value] of Object.entries(job.secrets)) {
        const names = secretNames(value);
        if (names.length === 0) continue;
        const declared = spec.get(input.toLowerCase());
        if (!declared) {
          problems.push(
            `${where}: passes secret \`${input}\`, which ${job.uses.file} does not declare`,
          );
          continue;
        }
        addSecret(names, declared.required, `${where} (${input})`);
      }
      for (const { name, required } of spec.values()) {
        if (required && !passed.has(name.toLowerCase())) {
          problems.push(`${where}: does not pass required secret \`${name}\` to ${job.uses.file}`);
        }
      }
    }
    for (const v of caller.variables) {
      const prev = variables.get(v.name);
      variables.set(v.name, {
        name: v.name,
        optional: prev ? prev.optional && v.optional : v.optional,
        where: [...(prev?.where ?? []), caller.path],
      });
    }
  }
  return { secrets: [...secrets.values()], variables: [...variables.values()], problems };
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

export function checkSecrets({ github, repo, ownerType, requirements }) {
  const ID = "secrets";
  const TITLE = "Secrets the Callers pass are set";
  let listed;
  try {
    listed = listNames(github, repo, "secret", ownerType);
  } catch (err) {
    return result(ID, TITLE, "skip", `Could not list repository secrets: ${err.message}`);
  }
  const isSet = (s) => s.names.some((n) => listed.names.has(n.toUpperCase()));
  const missingRequired = requirements.secrets.filter((s) => s.required && !isSet(s));
  const missingOptional = requirements.secrets.filter((s) => !s.required && !isSet(s));
  const describe = (s) => `${s.names.join(" or ")} (${s.where.join(", ")})`;
  const details = [
    ...requirements.problems,
    ...missingRequired.map((s) => `required, not set: ${describe(s)}`),
    ...missingOptional.map((s) => `optional, not set: ${describe(s)}`),
  ];
  if (listed.orgNote && (missingRequired.length || missingOptional.length))
    details.push(listed.orgNote);
  const fix = [...missingRequired, ...missingOptional].map(
    (s) => `gh secret set ${s.names[0]} --repo ${repo}`,
  );
  if (missingRequired.length || requirements.problems.length) {
    return result(ID, TITLE, "fail", `${missingRequired.length} required secret(s) missing.`, {
      details,
      fix,
    });
  }
  if (missingOptional.length) {
    return result(
      ID,
      TITLE,
      "warn",
      `${missingOptional.length} optional secret(s) referenced but not set.`,
      {
        details,
        fix,
      },
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
  const required = requirements.variables.filter((v) => !v.optional);
  const missing = required.filter((v) => !listed.names.has(v.name.toUpperCase()));
  if (missing.length === 0) {
    return result(ID, TITLE, "pass", `All ${required.length} required variable(s) are set.`);
  }
  const details = missing.map(
    (v) =>
      `not set: ${v.name} (${v.where.join(", ")})` +
      (/_ENABLED$/.test(v.name)
        ? " — the Kill switch: the flow never runs until it is set to true"
        : ""),
  );
  if (listed.orgNote) details.push(listed.orgNote);
  return result(ID, TITLE, "fail", `${missing.length} required variable(s) missing.`, {
    details,
    fix: missing.map(
      (v) =>
        `gh variable set ${v.name} --repo ${repo} --body ${/_ENABLED$/.test(v.name) ? "true" : "<value>"}`,
    ),
  });
}
