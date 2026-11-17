#!/usr/bin/env node
/**
 * Print the Doc facts held as JavaScript constants, as JSON, for
 * scripts/gen_doc_blocks.py. Python never parses JavaScript: it runs this.
 *
 * Usage: node scripts/doc-facts.mjs [<repository root>]
 *
 * Each fact imports the real module and reads its constants. A constant the
 * module does not export is read from a second import of the same file, under
 * a `?expose` URL that a module `load` hook ends with an `export { ... }` of
 * the missing names. The module itself is not changed, and once it exports a
 * name the hook is not needed for it.
 */
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".");

async function constants(relativePath, names) {
  const url = pathToFileURL(resolve(root, relativePath)).href;
  const module = await import(url);
  const missing = names.filter((name) => !(name in module));
  if (missing.length === 0) return pick(module, names);
  const exposed = `${url}?expose`;
  const tail = `\nexport { ${missing.join(", ")} };\n`;
  registerHooks({
    load(requested, context, next) {
      const result = next(requested, context);
      return requested === exposed ? { ...result, source: String(result.source) + tail } : result;
    },
  });
  return pick({ ...module, ...(await import(exposed)) }, names);
}

function pick(module, names) {
  return Object.fromEntries(
    names.map((name) => {
      if (!(name in module)) throw new Error(`${name} is not defined`);
      return [name, [...module[name]]];
    }),
  );
}

const facts = {
  "review-response-protected-paths": await constants(
    ".github/agent-review-response/review-response.mjs",
    ["PROTECTED_FILES", "PROTECTED_DIRS_ANY_DEPTH", "PROTECTED_ROOT_DIRS", "KIT_OWNED_PATHS"],
  ),
};

process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
