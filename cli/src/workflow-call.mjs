// Reads a reusable workflow's `on.workflow_call.secrets` block: which secrets
// it declares and which of them are required.

import { parseYamlSubset } from "./yaml-subset.mjs";

/** @returns {Map<string, { required: boolean }> | null} null when the file is not a reusable workflow. */
export function parseWorkflowCallSecrets(text) {
  const doc = parseYamlSubset(text);
  const on = doc.on ?? doc["'on'"] ?? doc['"on"'];
  if (!on || typeof on !== "object" || !("workflow_call" in on)) return null;
  const call = on.workflow_call && typeof on.workflow_call === "object" ? on.workflow_call : {};
  const secrets =
    call.secrets && typeof call.secrets === "object" && !call.secrets.$seq ? call.secrets : {};
  const out = new Map();
  for (const [name, spec] of Object.entries(secrets)) {
    const required =
      spec && typeof spec === "object" ? String(spec.required).toLowerCase() === "true" : false;
    out.set(name.toLowerCase(), { name, required });
  }
  return out;
}

/**
 * A reusable workflow's `on.workflow_call.inputs`: each input's default (or
 * null) and whether it is required.
 * @returns {Map<string, { default: string | null, required: boolean }> | null}
 */
export function parseWorkflowCallInputs(text) {
  const doc = parseYamlSubset(text);
  const on = doc.on ?? doc["'on'"] ?? doc['"on"'];
  if (!on || typeof on !== "object" || !("workflow_call" in on)) return null;
  const call = on.workflow_call && typeof on.workflow_call === "object" ? on.workflow_call : {};
  const inputs =
    call.inputs && typeof call.inputs === "object" && !call.inputs.$seq ? call.inputs : {};
  const out = new Map();
  for (const [name, spec] of Object.entries(inputs)) {
    const obj = spec && typeof spec === "object" ? spec : {};
    out.set(name, {
      default: typeof obj.default === "string" ? obj.default : null,
      required: String(obj.required).toLowerCase() === "true",
    });
  }
  return out;
}
