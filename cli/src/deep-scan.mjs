// `agent-kit deep-scan`: the host-side launcher for a Deep scan (ADR 0019).
// Its first stage finds the Consumer's Scan recipe at the trusted ref (the
// default branch's tip, never the working tree) and validates it, or refuses
// with what is wrong and a pointer to the docs. There is no fallback to a
// `full` audit. Then the pre-flight refusals (a GitHub token in the
// environment, a .env the copy-in would carry wholesale), then the choice of a
// sandbox runtime from the host, or its refusal, with no override (ADR 0018).
// Then the sandbox lifecycle on that runtime, from image to teardown
// (deep-scan/lifecycle.mjs), with a stand-in agent step until the proxy and
// the real scan land.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { firstLine } from "./exec.mjs";
import { detectDefaultBranch, parseAnswer } from "./init.mjs";
import { checkSafePath, UnsafePathError } from "./safe-paths.mjs";
import {
  DEFAULT_RECIPE_PATH,
  readRecipeAtRef,
  RecipeError,
  RECIPE_DOCS_URL,
  recipeSteps,
  validateRecipe,
} from "./deep-scan/recipe.mjs";
import { credentialSource, readCredential, withoutCredentials } from "./deep-scan/credential.mjs";
import { runLifecycle } from "./deep-scan/lifecycle.mjs";
import { envFilesAtRef, strayTokens } from "./deep-scan/preflight.mjs";
import { RUNTIMES_DOCS_URL, selectRuntime } from "./deep-scan/runtime.mjs";
import { CLI_VERSION } from "./tags.mjs";

const CREDENTIALS_DOCS_URL = `https://github.com/mnaimfaizy/agent-kit/blob/v${CLI_VERSION}/docs/security-audit.md#credentials`;

/**
 * @param {{
 *   cwd: string,
 *   runner: import("./exec.mjs").Runner,
 *   recipePath?: string,
 *   defaultBranch?: string,
 *   credentialFrom?: string,
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 *   fetch?: typeof globalThis.fetch,
 *   signals?: { on: Function, off: Function },
 *   reportDir?: string,
 *   modelApi?: string,
 *   out: (s: string) => void,
 *   err: (s: string) => void,
 * }} opts  `platform`, `env`, `fetch` and `signals` are the host's
 *   (`process.platform`, `process.env`, the global fetch, `process`), and
 *   `reportDir` is a new private temporary folder, and `modelApi` is the
 *   real model API; only tests pass others, and no flag can change them.
 * @returns {Promise<number>} exit code: 0 the sandbox ran and the report came
 *   out, 1 refused or a step failed, 2 usage error, 130 or 143 interrupted
 */
export async function runDeepScan({
  cwd,
  runner,
  recipePath,
  defaultBranch,
  credentialFrom,
  platform = process.platform,
  env = process.env,
  fetch = globalThis.fetch,
  signals = process,
  reportDir,
  modelApi,
  out,
  err,
}) {
  const refuse = (lines, docs = RECIPE_DOCS_URL) => {
    err([`REFUSED  ${lines[0]}`, ...lines.slice(1), `See ${docs}`].join("\n"));
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

  const source = credentialSource(credentialFrom);
  if ("error" in source) {
    err(source.error);
    return 2;
  }

  if (defaultBranch !== undefined) {
    const answer = parseAnswer("defaultBranch", defaultBranch);
    if (answer.error) {
      err(answer.error);
      return 2;
    }
  }

  const top = runner("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (top.status === null) {
    return refuse([`Could not run git: ${firstLine(top.stderr)}`]);
  }
  if (top.status !== 0) {
    return refuse([`${cwd} is not a git repository; deep-scan reads the Scan recipe from git.`]);
  }
  const root = top.stdout.trim();

  // The trusted ref: the default branch's tip as this checkout has it.
  const branch = defaultBranch ?? detectDefaultBranch(runner, root);
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
      ...(defaultBranch === undefined
        ? [
            `If your default branch is not ${branch} (origin's HEAD is not set here), name it with --default-branch <name>.`,
          ]
        : []),
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

  // Pre-flight, before any runtime CLI runs.
  const tokens = strayTokens(env);
  if (tokens.length) {
    return refuse(
      [
        `${tokens.join(" and ")} ${tokens.length > 1 ? "are" : "is"} set in deep-scan's environment, and a GitHub token must never reach the sandbox.`,
        `Unset ${tokens.length > 1 ? "them" : "it"} for this run, for example:`,
        "  env -u GH_TOKEN -u GITHUB_TOKEN npx @mnaimfaizy/agent-kit deep-scan",
        "  In PowerShell: Remove-Item Env:GH_TOKEN, Env:GITHUB_TOKEN -ErrorAction SilentlyContinue, then run it again.",
      ],
      RUNTIMES_DOCS_URL,
    );
  }
  const envFiles = envFilesAtRef({ runner, root, ref: commit });
  if ("error" in envFiles) {
    return refuse([`Could not list the files on ${branch}: ${envFiles.error}`], RUNTIMES_DOCS_URL);
  }
  if (envFiles.files.length) {
    return refuse(
      [
        `${branch} (${commit.slice(0, 12)}) has environment files that the copy-in would carry into the sandbox, forwarded wholesale:`,
        ...envFiles.files.map((f) => `  - ${f}`),
        `Remove them from ${branch} (keep a .env.example with placeholder values instead), and rotate any real secret they held.`,
      ],
      RUNTIMES_DOCS_URL,
    );
  }

  // The model credential: read once, kept only in this process for the
  // model proxy, and removed from every command's environment from here on.
  const runs = withoutCredentials(
    runner,
    [env, process.env],
    source.kind === "env" ? [source.name] : [],
  );
  const key = readCredential({ source, env, runner: runs });
  if ("refused" in key) return refuse(key.refused, CREDENTIALS_DOCS_URL);
  out(
    `Model credential: an API key from ${key.from}; it stays in the model proxy, outside the sandbox.`,
  );

  const choice = selectRuntime({ runner: runs, platform });
  if ("refused" in choice) return refuse(choice.refused, RUNTIMES_DOCS_URL);
  out(`Sandbox runtime: ${choice.runtime.name}.`);
  return runLifecycle({
    runner: runs,
    credential: key.credential,
    ...(modelApi !== undefined ? { modelApi } : {}),
    runtime: choice.runtime,
    root,
    branch,
    commit,
    steps: recipeSteps(recipe.text),
    platform,
    fetch,
    signals,
    ...(reportDir !== undefined ? { reportDir } : {}),
    out,
    err,
  });
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
