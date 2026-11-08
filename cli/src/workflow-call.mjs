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
