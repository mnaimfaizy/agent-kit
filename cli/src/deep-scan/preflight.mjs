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
/** The suffixes of the `.env` templates that hold no values; docs/security-audit.md lists them. */
export const ENV_TEMPLATES = Object.freeze([
  "example",
  "sample",
  "template",
  "dist",
  "default",
  "defaults",
]);
const TEMPLATE = new RegExp(`\\.(${ENV_TEMPLATES.join("|")})$`, "i");

/**
 * Of the environment files on the default branch, those a Verification run
 * would still carry in from it: every one when the recipe builds a
 * Dockerfile (the build context is the default branch's whole tree), and
 * else those under a repository grounding path. A grounding entry with
 * pathspec characters is taken to reach them all.
 * @param {string[]} files
 * @param {{ dockerfile?: string, grounding: string[] }} steps
 * @returns {{ files: string[], why: string }}
 */
export function envFilesCarriedFromDefault(files, steps) {
  if (steps.dockerfile !== undefined) {
    return { files, why: `the Dockerfile's build context (${steps.dockerfile})` };
  }
  const paths = steps.grounding.filter((g) => !/^https?:\/\//i.test(g));
  const reaches = (source, file) => {
    if (/[*?[\]:\\]/.test(source)) return true;
    const dir = source.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    return dir === "" || dir === "." || file === dir || file.startsWith(`${dir}/`);
  };
  return {
    files: files.filter((f) => paths.some((g) => reaches(g, f))),
    why: "the recipe's grounding paths",
  };
}

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
