#!/usr/bin/env node
/**
 * Print the Doc facts held as JavaScript constants, as JSON, for
 * scripts/gen_doc_blocks.py. Python never parses JavaScript: it runs this.
 *
 * Usage: node scripts/doc-facts.mjs [<repository root>]
 *
 * Each fact imports the real module and reads its constants. A constant the
 * module does not export is read from a second import of the same file, under
 * a `?expose=A,B` URL that a module `load` hook ends with `export { A, B };`.
 * The module itself is not changed, and once it exports a name the hook is
 * not needed for it. That second import runs the module again, so a fact's
 * module must do no work at import time beyond defining things (a `main`
 * behind an `import.meta.url` guard, as review-response.mjs has, is fine).
 */
import * as nodeModule from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".");

// One hook for every fact: a module imported under `?expose=A,B` ends with
// `export { A, B };`. Any other import passes through untouched.
if (typeof nodeModule.registerHooks !== "function") {
  throw new Error(
    `scripts/doc-facts.mjs needs Node 22.15 or later (module.registerHooks); this is ${process.version}`,
  );
}
nodeModule.registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    const names = url.startsWith("file:") ? new URL(url).searchParams.get("expose") : null;
    return names ? { ...result, source: `${result.source}\nexport { ${names} };\n` } : result;
  },
});

async function constants(relativePath, names) {
  const url = pathToFileURL(resolve(root, relativePath)).href;
  const module = await import(url);
  const missing = names.filter((name) => !(name in module));
  const exposed = missing.length ? await import(`${url}?expose=${missing.join(",")}`) : {};
  return Object.fromEntries(
    names.map((name) => {
      const value = name in module ? module[name] : exposed[name];
      if (value === undefined) throw new Error(`${relativePath} defines no ${name}`);
      return [name, value instanceof Set ? [...value] : value];
    }),
  );
}

// `init` prints a `gh label create` line for each: LABELS for the Agent flow,
// RESPONSE_LABEL for Review response.
const { LABELS, RESPONSE_LABEL } = await constants("cli/src/init.mjs", [
  "LABELS",
  "RESPONSE_LABEL",
]);

const facts = {
  "review-response-protected-paths": await constants(
    ".github/agent-review-response/review-response.mjs",
    ["PROTECTED_FILES", "PROTECTED_DIRS_ANY_DEPTH", "PROTECTED_ROOT_DIRS", "KIT_OWNED_PATHS"],
  ),
  "deep-scan-limits": await constants("cli/src/deep-scan/limits.mjs", [
    "DEFAULT_LIMITS",
    "VERIFY_LIMITS",
    "LIMIT_FLAGS",
  ]),
  "deep-scan-recipe-fields": await constants("cli/src/deep-scan/recipe.mjs", [
    "RECIPE_FIELDS",
    "ENTRY_KINDS",
  ]),
  "trigger-labels": [...LABELS, RESPONSE_LABEL].map(([name, color, description]) => ({
    name,
    color,
    description,
  })),
};

process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
