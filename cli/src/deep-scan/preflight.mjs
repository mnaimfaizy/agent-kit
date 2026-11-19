// The Deep scan launcher's pre-flight refusals (#368): before any sandbox
// runtime is touched, refuse a GitHub token that would reach the sandbox and
// a .env that would be forwarded into it wholesale. Both checks read only the
// launcher's own environment and the trusted ref's file list.

import { firstLine } from "../exec.mjs";

/** The GitHub token variables that must never reach the sandbox. */
export const GITHUB_TOKEN_VARS = Object.freeze(["GH_TOKEN", "GITHUB_TOKEN"]);

/**
 * The GitHub token variables set to a value in `env`, by the names `env`
 * gives them. Names are matched in any letter case, as Windows does.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function strayTokens(env) {
  return Object.keys(env).filter(
    (name) => GITHUB_TOKEN_VARS.includes(name.toUpperCase()) && Boolean(env[name]),
  );
}

// `.env` and `.env.<anything>`, except the templates that hold no values.
const ENV_FILE = /^\.env(\..+)?$/;
const TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i;

/** Whether a repository path names an environment file. */
export function isEnvFile(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return ENV_FILE.test(base) && !TEMPLATE.test(base);
}

/**
 * The environment files committed at `ref`. The copy-in exports the trusted
 * ref's whole tree into the sandbox, so each would be forwarded wholesale.
 * @param {{ runner: import("../exec.mjs").Runner, root: string, ref: string }} opts
 * @returns {{ files: string[] } | { error: string }}
 */
export function envFilesAtRef({ runner, root, ref }) {
  const r = runner("git", ["-C", root, "ls-tree", "-r", "-z", "--name-only", ref]);
  if (r.status !== 0) return { error: firstLine(r.stderr) || "git ls-tree failed" };
  return { files: r.stdout.split("\0").filter((p) => p && isEnvFile(p)) };
}
