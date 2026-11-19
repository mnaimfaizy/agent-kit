// `agent-kit deep-scan`: the host-side launcher for a Deep scan (ADR 0019).
// Its first stage finds the Consumer's Scan recipe at the trusted ref (the
// default branch's tip, never the working tree) and validates it, or refuses
// with what is wrong and a pointer to the docs. There is no fallback to a
// `full` audit. The later stages (runtime, sandbox, proxy, scan) are not
// built yet: a valid recipe ends the run with exit 0.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { firstLine } from "./exec.mjs";
import { detectDefaultBranch } from "./init.mjs";
import { checkSafePath, UnsafePathError } from "./safe-paths.mjs";
import {
  DEFAULT_RECIPE_PATH,
  readRecipeAtRef,
  RecipeError,
  RECIPE_DOCS_URL,
  validateRecipe,
} from "./deep-scan/recipe.mjs";

/**
 * @param {{
 *   cwd: string,
 *   runner: import("./exec.mjs").Runner,
 *   recipePath?: string,
 *   out: (s: string) => void,
 *   err: (s: string) => void,
 * }} opts
 * @returns {number} exit code: 0 the recipe is valid, 1 refused, 2 usage error
 */
export function runDeepScan({ cwd, runner, recipePath, out, err }) {
  const refuse = (lines) => {
    err([`REFUSED  ${lines[0]}`, ...lines.slice(1), `See ${RECIPE_DOCS_URL}`].join("\n"));
    return 1;
  };

  const path = recipePath ?? DEFAULT_RECIPE_PATH;
  try {
    checkSafePath(path, "--recipe");
  } catch (e) {
    if (!(e instanceof UnsafePathError)) throw e;
    err(`${e.message}; give a path relative to the repository root.`);
    return 2;
  }

  const top = runner("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    return refuse([`${cwd} is not a git repository; deep-scan reads the Scan recipe from git.`]);
  }
  const root = top.stdout.trim();

  // The trusted ref: the default branch's tip as this checkout has it.
  const branch = detectDefaultBranch(runner, root);
  const tip = runner("git", [
    "-C",
    root,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}^{commit}`,
  ]);
  if (tip.status !== 0) {
    return refuse([
      `No local branch ${branch} (the default branch) to read the Scan recipe from.`,
      `deep-scan reads ${path} as committed on the default branch, never the working tree: create or fetch ${branch}, then run it again.`,
    ]);
  }
  const commit = tip.stdout.trim();
  const at = `${path} on ${branch} (${commit.slice(0, 12)})`;

  let recipe;
  try {
    recipe = readRecipeAtRef({ runner, root, ref: commit, path });
  } catch (e) {
    if (!(e instanceof RecipeError)) throw e;
    return refuse([`Cannot read the Scan recipe at ${branch}: ${firstLine(e.message)}`]);
  }

  const local = workingCopy(root, path);
  if (!recipe.found) {
    const lines = [
      `No Scan recipe at ${path} on ${branch}. A Deep scan needs one, and does not fall back to a full audit.`,
    ];
    if (local !== null) {
      lines.push(
        `Your working tree has ${path}, but deep-scan reads only what is committed on ${branch}: commit it there first.`,
      );
    }
    return refuse(lines);
  }

  const problems = validateRecipe(recipe.text);
  const drift =
    local !== null && lf(local) !== lf(recipe.text)
      ? `Note: your working copy of ${path} differs from ${branch}'s; deep-scan used ${branch}'s.`
      : null;
  if (problems.length) {
    return refuse([
      `The Scan recipe ${at} is invalid:`,
      ...problems.map((p) => `  - ${p}`),
      ...(drift ? [drift] : []),
    ]);
  }
  out(`Scan recipe ${at} is valid.`);
  if (drift) out(drift);
  out(
    "The later deep-scan stages (runtime selection, sandbox, proxy, scan) are not built yet, so the run stops here.",
  );
  return 0;
}

/** Text with LF line ends, so a CRLF checkout of the same file compares equal. */
const lf = (text) => text.replace(/\r\n?/g, "\n");

/** The working tree's copy of `path` as text, or null if there is no regular file. */
function workingCopy(root, path) {
  const file = join(root, path);
  try {
    if (!existsSync(file) || !lstatSync(file).isFile()) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
