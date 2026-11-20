// `agent-kit deep-scan`: the host-side launcher for a Deep scan (ADR 0019).
// Its first stage finds the Consumer's Scan recipe at the trusted ref (the
// default branch's tip, never the working tree) and validates it, or refuses
// with what is wrong and a pointer to the docs. There is no fallback to a
// `full` audit. Then the pre-flight refusals (a GitHub token in the
// environment, a .env the copy-in would carry wholesale), what the agent is
// handed (the deep procedure and the Threat pack, at the same ref), and the
// model credential (from the environment or 1Password, kept only in this
// process); then the choice of a sandbox runtime from the host, or its
// refusal, with no override (ADR 0018). Then the sandbox lifecycle on that
// runtime, from image to teardown (deep-scan/lifecycle.mjs), its agent step
// the real Claude Code behind the key-injecting model proxy, every run
// bounded by the limits its flags set (deep-scan/limits.mjs). With
// `--verify <file> --ref <ref>`, the run is a Verification run instead
// (deep-scan/verify.mjs): local only, confirm-only against the finding file,
// on the ref the maintainer named, with its own limits.

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { readHandIn } from "./deep-scan/agent.mjs";
import {
  credentialKind,
  credentialSource,
  readCredential,
  SUBSCRIPTION,
  withoutCredentials,
} from "./deep-scan/credential.mjs";
import { DEFAULT_LIMITS, describeLimits, parseLimits, VERIFY_LIMITS } from "./deep-scan/limits.mjs";
import { runLifecycle } from "./deep-scan/lifecycle.mjs";
import { MODEL_ID } from "./deep-scan/model-proxy.mjs";
import { envFilesAtRef, strayTokens } from "./deep-scan/preflight.mjs";
import { RUNTIMES_DOCS_URL, selectRuntime } from "./deep-scan/runtime.mjs";
import {
  readFindingFile,
  REF_NAME,
  verificationProcedure,
  VERIFY_DOCS_URL,
} from "./deep-scan/verify.mjs";
import { CLI_VERSION } from "./tags.mjs";

const CREDENTIALS_DOCS_URL = `https://github.com/mnaimfaizy/agent-kit/blob/v${CLI_VERSION}/docs/security-audit.md#credentials`;

/**
 * @param {{
 *   cwd: string,
 *   runner: import("./exec.mjs").Runner,
 *   recipePath?: string,
 *   defaultBranch?: string,
 *   credential?: string,
 *   credentialFrom?: string,
 *   model?: string,
 *   effort?: string,
 *   reportPath?: string,
 *   verifyPath?: string,
 *   ref?: string,
 *   limitFlags?: Record<string, string | undefined>,
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 *   fetch?: typeof globalThis.fetch,
 *   signals?: { on: Function, off: Function },
 *   reportDir?: string,
 *   modelApi?: string,
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 *   out: (s: string) => void,
 *   err: (s: string) => void,
 * }} opts  `limitFlags` holds the limit flags' values, keyed by flag name.
 *   `verifyPath` (a finding file) and `ref` go together, for a
 *   Verification run.
 *   `platform`, `env`, `fetch`, `signals` and `timers` are the host's
 *   (`process.platform`, `process.env`, the global fetch, `process`, the
 *   real clock), and `reportDir` is a new private temporary folder, and
 *   `modelApi` is the real model API; only tests pass others, and no flag
 *   can change them.
 * @returns {Promise<number>} exit code: 0 the sandbox ran and the report came
 *   out, 1 refused or a step failed, 2 usage error, 3 a limit stopped the
 *   run, 130 or 143 interrupted
 */
export async function runDeepScan({
  cwd,
  runner: hostRunner,
  recipePath,
  defaultBranch,
  credential,
  credentialFrom,
  model,
  effort,
  reportPath,
  verifyPath,
  ref,
  limitFlags = {},
  platform = process.platform,
  env = process.env,
  fetch = globalThis.fetch,
  signals = process,
  reportDir,
  modelApi,
  timers = globalThis,
  out,
  err,
}) {
  const refuse = (lines, docs = RECIPE_DOCS_URL) => {
    err([`REFUSED  ${lines[0]}`, ...lines.slice(1), `See ${docs}`].join("\n"));
    return 1;
  };

  // A Verification run: local only. Refused in CI before anything is read,
  // naming no path, since a finding file names a concept id under response.
  const verifying = verifyPath !== undefined;
  if (verifying && env.GITHUB_ACTIONS === "true") {
    return refuse(
      [
        "--verify has no CI form: a Verification run's finding file names a concept id that is private until release, and a CI log could show it.",
        "Run it on your own machine, with an accepted sandbox runtime.",
      ],
      VERIFY_DOCS_URL,
    );
  }
  if (ref !== undefined && !verifying) {
    err("--ref names the ref a Verification run exports: pass --verify <file> with it.");
    return 2;
  }
  if (verifying && ref === undefined) {
    err(
      "--verify needs --ref <ref>: the local branch, tag or commit to verify the fix on, such as your fix branch.",
    );
    return 2;
  }
  if (verifying && reportPath !== undefined) {
    err(
      "--report is not taken with --verify: a Verification run's report goes only to a new private folder on this machine.",
    );
    return 2;
  }
  if (verifying && !REF_NAME.test(ref)) {
    err(`--ref must be a ref name or commit id, got: ${JSON.stringify(ref)}`);
    return 2;
  }

  const path = recipePath ?? DEFAULT_RECIPE_PATH;
  try {
    checkSafePath(path, "--recipe");
  } catch (e) {
    if (!(e instanceof UnsafePathError)) throw e;
    err(`${e.message}; give a path relative to the repository root.`);
    return 2;
  }

  if (model !== undefined && !MODEL_ID.test(model)) {
    err(
      `--model must be a plain model id (letters, digits and . _ : @ / [ ] -), got: ${JSON.stringify(model)}`,
    );
    return 2;
  }
  if (effort !== undefined && !EFFORTS.includes(effort)) {
    err(
      `--effort must be one of ${EFFORTS.slice(0, -1).join(", ")} or ${EFFORTS.at(-1)}, got: ${JSON.stringify(effort)}`,
    );
    return 2;
  }

  // The CI workflow's delivery steps read the report from a path they name.
  // Checked before anything runs, so a run never ends with nowhere to write.
  let reportFile;
  if (reportPath !== undefined) {
    reportFile = resolve(cwd, reportPath);
    if (existsSync(reportFile)) {
      err(`--report ${reportFile} already exists; name a new file.`);
      return 2;
    }
    const folder = dirname(reportFile);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      err(`--report ${reportFile}: its folder ${folder} does not exist.`);
      return 2;
    }
  }

  const bounds = parseLimits(limitFlags, verifying ? VERIFY_LIMITS : DEFAULT_LIMITS);
  if ("error" in bounds) {
    err(bounds.error);
    return 2;
  }
  const { limits } = bounds;

  // The credential's kind: an API key, or the opted-into subscription token.
  const chosen = credentialKind(credential);
  if ("error" in chosen) {
    err(chosen.error);
    return 2;
  }
  const subscription = chosen.kind === SUBSCRIPTION;
  const source = credentialSource(credentialFrom, chosen.kind);
  if ("error" in source) {
    err(source.error);
    return 2;
  }

  // The finding file, read and checked on the host before anything runs.
  let given = null;
  if (verifying) {
    const file = resolve(cwd, verifyPath);
    const read = readFindingFile(file);
    if ("refused" in read) return refuse(read.refused, VERIFY_DOCS_URL);
    given = { ...read, file };
  }
  // No command this launcher runs inherits a model credential: the key
  // lives only in this process, for the model proxy.
  const runner = withoutCredentials(
    hostRunner,
    [env, process.env],
    source.kind === "env" ? [source.name] : [],
  );

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

  // What is copied in as the repository: the default branch's tip, or the
  // ref a Verification run names. The recipe, the skill and the Threat pack
  // still come from the default branch.
  let target = { name: branch, commit };
  if (given) {
    const found = runner("git", [
      "-C",
      root,
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    if (found.status !== 0) {
      return refuse(
        [
          `No local ref ${ref} to verify the fix on: name a local branch, tag or commit.`,
          "deep-scan exports a committed ref, never the working tree: commit the fix on a branch (or fetch the advisory's private-fork branch you reviewed into one), then run it again.",
        ],
        VERIFY_DOCS_URL,
      );
    }
    target = { name: ref, commit: found.stdout.trim() };
  }

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
  // On what is copied in: a Verification run's ref, when there is one.
  const envFiles = envFilesAtRef({ runner, root, ref: target.commit });
  if ("error" in envFiles) {
    return refuse(
      [`Could not list the files on ${target.name}: ${envFiles.error}`],
      RUNTIMES_DOCS_URL,
    );
  }
  if (envFiles.files.length) {
    return refuse(
      [
        `${target.name} (${target.commit.slice(0, 12)}) has environment files that the copy-in would carry into the sandbox, forwarded wholesale:`,
        ...envFiles.files.map((f) => `  - ${f}`),
        `Remove them from ${target.name} (keep a .env.example with placeholder values instead), and rotate any real secret they held.`,
      ],
      RUNTIMES_DOCS_URL,
    );
  }

  // What the agent is handed, read at the trusted ref like the recipe.
  const handed = readHandIn({ runner, root, ref: commit, branch });
  if ("refused" in handed) return refuse(handed.refused);
  const { handIn } = handed;
  let verification;
  if (given) {
    const cut = verificationProcedure(handIn.skill["DEEP.md"]);
    const variant = /^## Verification-run variant[ \t]*$/m.test(handIn.skill["report-format.md"]);
    const missing = [
      ...("missing" in cut ? cut.missing.map((m) => `DEEP.md on ${branch} has no ${m}`) : []),
      ...(variant ? [] : [`report-format.md on ${branch} has no Verification-run variant`]),
    ];
    if (missing.length) {
      return refuse(
        [
          `The security-audit skill is out of date for a Verification run: its ${missing.join(", and its ")}.`,
          `Bring the skill up to date on ${branch} (npx @mnaimfaizy/agent-kit upgrade, then commit), then run deep-scan --verify again.`,
        ],
        VERIFY_DOCS_URL,
      );
    }
    verification = { findings: given.findings, data: given.data, procedure: cut.procedure };
  }
  out(
    `Threat pack: ${handIn.threatModel.path} and ${handIn.findingsLedger.path} (${handIn.from ? `from ${handIn.from}` : "the default paths"}); ${verification ? "the Verification-run procedure, from" : "the deep procedure:"} the security-audit skill's DEEP.md, on the same branch.`,
  );
  if (given) {
    out(
      `Verification run: ${given.findings.length} finding(s) from ${given.file}, on ${target.name} (${target.commit.slice(0, 12)}); confirm-only, with no full walk and no exploration.`,
    );
  }

  // The model credential: read once, and kept only in this process.
  const key = readCredential({ source, env, runner, kind: chosen.kind });
  if ("refused" in key) return refuse(key.refused, CREDENTIALS_DOCS_URL);
  out(
    subscription
      ? `Model credential: a Claude subscription token from ${key.from} (--credential subscription, at your own risk: it relies on undocumented Claude Code behaviour, and the token cap is its only spend lever); it stays in the model proxy, outside the sandbox.`
      : `Model credential: an API key from ${key.from}; it stays in the model proxy, outside the sandbox.`,
  );

  const choice = selectRuntime({ runner, platform });
  if ("refused" in choice) return refuse(choice.refused, RUNTIMES_DOCS_URL);
  out(`Sandbox runtime: ${choice.runtime.name}.`);
  out(describeLimits(limits));
  return runLifecycle({
    limits,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    timers,
    runner,
    credential: key.credential,
    credentialKind: chosen.kind,
    ...(modelApi !== undefined ? { modelApi } : {}),
    runtime: choice.runtime,
    root,
    branch,
    commit,
    steps: recipeSteps(recipe.text),
    handIn,
    recipePath: path,
    recipeText: recipe.text,
    platform,
    fetch,
    signals,
    ...(reportDir !== undefined ? { reportDir } : {}),
    ...(reportFile !== undefined ? { reportFile } : {}),
    ...(verification ? { target, verification } : {}),
    // The Actions log is world-readable: in GitHub Actions nothing the scan
    // shaped is printed (the Public-log rule). No CI caller can forget it.
    publicLog: env.GITHUB_ACTIONS === "true",
    out,
    err,
  });
}

/**
 * The effort levels Claude Code's --effort takes (2.1.328's --help), and the
 * static workflow's effort input: nothing else reaches the command line.
 */
const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

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
