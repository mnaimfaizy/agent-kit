// The Deep scan launcher's pre-flight refusals (#368): before any sandbox
// runtime is touched, refuse a GitHub token that would reach the sandbox and
// a .env that would be forwarded into it wholesale. Both checks read only the
// launcher's own environment and the trusted ref's file list. A third
// refusal comes with the image, the first thing that can show it, and still
// before any sandbox: a musl recipe image, which cannot run the Harness
// image's glibc builds (ADR 0029). Before all of them, the Support Level
// (ADR 0028): a Deep scan runs on a pair below `tried` only as a Proving run.

import { appendFileSync } from "node:fs";
import { firstLine } from "../exec.mjs";
import { readHarnesses, supportFor } from "../harness/facts.mjs";
import { MUSL_MARKER } from "../harness/install-layer.mjs";
import { ENDS_HERE, outputLines, StepFailed } from "./steps.mjs";

/**
 * Throw the musl refusal when the layer build `r` failed on the musl check.
 * @param {import("../exec.mjs").StartResult} r
 * @param {{ image?: string, dockerfile?: string }} steps the recipe's
 */
export function refuseMusl(r, { image, dockerfile }) {
  if (r.status === 0) return;
  if (!`${r.stdout.toString("utf8")}\n${r.stderr}`.includes(MUSL_MARKER)) return;
  const what =
    dockerfile !== undefined
      ? `The image the recipe's ${dockerfile} builds`
      : `The recipe's image ${image}`;
  throw new StepFailed([
    `REFUSED  ${what} is musl Linux (such as Alpine), and the harness runs only on glibc Linux.`,
    ...outputLines(r),
    "Name a glibc image, such as a Debian or Ubuntu one, or leave image and dockerfile out to run on the Harness image.",
    ENDS_HERE,
  ]);
}

/**
 * Whether a Deep scan may run on `harness` at the Support Level
 * `cli/harnesses.json` holds for the pair: the refusal, or what the run says
 * about it (the line it prints, the line of the GitHub Actions run summary,
 * and the warning at `documented`). All of it comes from that file and the
 * flag, nothing from the scan, so a public log may hold it.
 * @param {{ harness?: string, provingRun?: boolean }} run
 * @returns {{ refused: string } | { line: string, summary: string, warning?: string }}
 */
export function deepScanSupport({ harness = "claude-code", provingRun = false }) {
  const facts = readHarnesses().harnesses[harness];
  const found = supportFor(facts, { stage: "deep-scan", provingRun });
  if (found.refused !== undefined) return { refused: found.refused };
  return {
    line: `Harness: ${harness}; ${found.summary}`,
    summary: `Harness: \`${harness}\` · Support Level: \`${found.level}\` · Proving run: ${provingRun ? "yes" : "no"}`,
    ...(found.warning !== undefined ? { warning: found.warning } : {}),
  };
}

/**
 * Add `line` to the GitHub Actions run summary, where `env` names one.
 * @param {Record<string, string | undefined>} env
 * @param {string} line
 * @returns {string | null} why it could not be written, or null
 */
export function writeRunSummary(env, line) {
  if (!env.GITHUB_STEP_SUMMARY) return null;
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
    return null;
  } catch (e) {
    return firstLine(e.message);
  }
}

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
