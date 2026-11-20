// The Deep scan's model credential (#370), on the API-key path: where it is
// read from, and the checks it passes before anything starts. It is read from
// an environment variable (default ANTHROPIC_API_KEY, which `op run` can
// fill) or from 1Password with `op read`, never from the command line, where
// other processes could see it. Once read, it lives only in the launcher's
// memory, for the model proxy: every command the launcher runs gets an
// environment with the model credential variables removed, and the sandbox
// gets only a placeholder.

import { firstLine } from "../exec.mjs";
import { GITHUB_TOKEN_VARS } from "./preflight.mjs";

/** The default variable the API key is read from. */
export const API_KEY_VAR = "ANTHROPIC_API_KEY";

/** The non-secret key the sandboxed Claude Code holds; the proxy swaps it. */
export const PLACEHOLDER_API_KEY = "agent-kit-deep-scan-placeholder";

/** Model credential variables, removed from every command the launcher runs. */
export const CREDENTIAL_VARS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/** The variable Claude Code reads a subscription (OAuth) token from. */
const OAUTH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";
/** How a Claude subscription (OAuth) token starts; an API key starts sk-ant-api. */
const OAUTH_TOKEN_PREFIX = "sk-ant-oat";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OP_REF = /^op:\/\/[^/\s][^\r\n]*$/;
const USAGE =
  "--credential-from takes env:<NAME> or an op:// reference (for example op://Private/Anthropic/credential), never the key itself: a command line is visible to other processes.";

/**
 * Where the credential comes from, from `--credential-from` (undefined: the
 * default variable). The value is never echoed: it may be the key itself.
 * @param {string | undefined} value
 * @returns {{ kind: "env", name: string } | { kind: "op", ref: string } | { error: string }}
 */
export function credentialSource(value) {
  if (value === undefined) return { kind: "env", name: API_KEY_VAR };
  if (value.startsWith("env:")) {
    const name = value.slice(4);
    if (!ENV_NAME.test(name)) return { error: USAGE };
    if (GITHUB_TOKEN_VARS.includes(name.toUpperCase())) {
      return {
        error: `--credential-from: ${name} is a GitHub token variable, and a GitHub token is never the model credential.`,
      };
    }
    return { kind: "env", name };
  }
  if (OP_REF.test(value)) return { kind: "op", ref: value };
  return { error: USAGE };
}

/**
 * Read the credential. Returns it with a description of where it came from
 * (never the value), or refusal lines that never hold it.
 * @param {{
 *   source: { kind: "env", name: string } | { kind: "op", ref: string },
 *   env: Record<string, string | undefined>,
 *   runner: import("../exec.mjs").Runner,
 * }} opts
 * @returns {{ credential: string, from: string } | { refused: string[] }}
 */
export function readCredential({ source, env, runner }) {
  if (source.kind === "op") {
    const r = runner("op", ["read", "--no-newline", source.ref]);
    if (r.status !== 0) {
      return {
        refused: [
          `Could not read the model credential with op read: ${firstLine(r.stderr) || `exit ${r.status}`}`,
          "Sign in to the 1Password CLI (op signin, or unlock the desktop app's integration) and check the reference, then run deep-scan again.",
        ],
      };
    }
    return checked(r.stdout.replace(/\r?\n$/, ""), "the op read result", "1Password (op read)");
  }
  const { name } = source;
  if (name.toUpperCase() === OAUTH_TOKEN_VAR) return subscription(name);
  const value = valueOf(env, name);
  if (!value) {
    return {
      refused: [
        `No model credential: ${name} is not set. deep-scan needs an Anthropic API key, which stays outside the sandbox, in its model proxy.`,
        `Set ${name} for this run, or read it from 1Password: --credential-from op://<vault>/<item>/<field>, or op run -- npx @mnaimfaizy/agent-kit deep-scan with ${name} set to an op:// reference.`,
      ],
    };
  }
  if (value.startsWith("op://")) {
    return {
      refused: [
        `${name} holds a 1Password reference, not a key: run deep-scan under op run, which resolves it, for example:`,
        "  op run -- npx @mnaimfaizy/agent-kit deep-scan",
        "or pass the reference with --credential-from instead.",
      ],
    };
  }
  return checked(value, name, name);
}

/** The variable's value, by name in any letter case (as Windows matches it). */
function valueOf(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function checked(value, what, from) {
  if (!value) return { refused: [`No model credential: ${what} is empty.`] };
  // The key goes into an HTTP header: printable ASCII with no space only.
  if (!/^[\x21-\x7e]+$/.test(value)) {
    return {
      refused: [
        `${what} holds whitespace or a control character, so it is not an API key (its value is not shown).`,
      ],
    };
  }
  if (value.startsWith(OAUTH_TOKEN_PREFIX)) return subscription(what);
  return { credential: value, from };
}

// The model proxy sends the credential as x-api-key, which a subscription
// token is not: the model API would answer 401 once the sandbox is built.
function subscription(what) {
  return {
    refused: [
      `${what} holds a Claude subscription token, not an API key (its value is not shown). deep-scan runs on the API-key path only: the subscription path is #375 and is not built yet.`,
      "Make an API key in a dedicated Anthropic Console workspace with its own spend limit, and pass that instead.",
    ],
  };
}

/**
 * `runner`, with the model credential variables (and `extra`) removed from
 * every command's environment, so no runtime CLI, and nothing it starts,
 * inherits the key.
 * @param {import("../exec.mjs").Runner} runner
 * @param {Record<string, string | undefined>[]} envs  the environments the
 *   variables could come from (the launcher's and the process's)
 * @param {string[]} [extra]
 * @returns {import("../exec.mjs").Runner}
 */
export function withoutCredentials(runner, envs, extra = []) {
  const names = new Set([...CREDENTIAL_VARS, ...extra]);
  for (const env of envs) {
    for (const key of Object.keys(env)) {
      if ([...names].some((n) => n.toUpperCase() === key.toUpperCase())) names.add(key);
    }
  }
  const scrub = Object.fromEntries([...names].map((n) => [n, undefined]));
  const wrapped = (cmd, args, opts = {}) =>
    runner(cmd, args, { ...opts, env: { ...opts.env, ...scrub } });
  wrapped.start = (cmd, args, opts = {}) =>
    runner.start(cmd, args, { ...opts, env: { ...opts.env, ...scrub } });
  return wrapped;
}
