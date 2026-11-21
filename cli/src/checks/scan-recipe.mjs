// Is there a Scan recipe at its default path, and is it valid? A recipe is
// needed only for a Deep scan, so having none passes. This reads the working
// tree like doctor's other file checks; `agent-kit deep-scan` itself reads the
// copy committed on the default branch.

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RECIPE_PATH,
  MAX_RECIPE_BYTES,
  RECIPE_DOCS_URL,
  validateRecipe,
} from "../deep-scan/recipe.mjs";
import { result } from "./result.mjs";

const ID = "scan-recipe";
const TITLE = "Scan recipe";

/** @param {{ root: string }} opts */
export function checkScanRecipe({ root }) {
  const path = DEFAULT_RECIPE_PATH;
  let stat;
  try {
    stat = lstatSync(join(root, path));
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      return result(
        ID,
        TITLE,
        "pass",
        `No Scan recipe at ${path}; only a Deep scan needs one (agent-kit deep-scan refuses without it).`,
      );
    }
    throw err;
  }
  if (!stat.isFile()) {
    return result(ID, TITLE, "warn", `${path} is not a regular file, so deep-scan cannot use it.`, {
      details: [`Recipe format: ${RECIPE_DOCS_URL}`],
    });
  }
  if (stat.size > MAX_RECIPE_BYTES) {
    return result(ID, TITLE, "warn", `${path} is larger than ${MAX_RECIPE_BYTES / 1024} KiB.`);
  }
  const problems = validateRecipe(readFileSync(join(root, path), "utf8"));
  if (problems.length) {
    return result(ID, TITLE, "warn", `${path} is invalid, so deep-scan will refuse it.`, {
      details: [...problems, `Recipe format: ${RECIPE_DOCS_URL}`],
    });
  }
  return result(
    ID,
    TITLE,
    "pass",
    `${path} is present and valid (deep-scan reads the copy committed on the default branch).`,
  );
}
