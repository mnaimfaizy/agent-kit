// The Deep scan's model credential (#370): where it is read from, and the
// checks it passes before anything starts. It is an Anthropic API key (the
// default, `--credential api-key`) or, opted into with `--credential
// subscription` (#375), a Claude subscription token from `claude
// setup-token`. It is read from an environment variable (ANTHROPIC_API_KEY,
// or CLAUDE_CODE_OAUTH_TOKEN for a subscription token, by default; `op run`
// can fill either) or from 1Password with `op read`, never from the command
// line, where other processes could see it. Once read, it lives only in the
// launcher's memory, for the model proxy: every command the launcher runs
// gets an environment with the model credential variables removed, and the
// sandbox gets only a placeholder.

import { firstLine } from "../exec.mjs";
import { claudeCode } from "../harness/claude-code.mjs";
import { GITHUB_TOKEN_VARS } from "./preflight.mjs";

/**
 * The credentials the harness accepts, from its launch plan: each kind's
 * variable is also the one it is read from by default.
 */
const { accepted, scrub } = claudeCode().credentials;

/** The kinds `--credential` takes: an API key (the default) or the opt-in. */
export const API_KEY = "api-key";
export const SUBSCRIPTION = "subscription";
const CREDENTIAL_KINDS = Object.freeze([API_KEY, SUBSCRIPTION]);

/** Model credential variables, removed from every command the launcher runs. */
export const CREDENTIAL_VARS = Object.freeze(scrub);

/** How a Claude subscription (OAuth) token starts; an API key starts sk-ant-api. */
const OAUTH_TOKEN_PREFIX = "sk-ant-oat";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OP_REF = /^op:\/\/[^/\s][^\r\n]*$/;
const USAGE =
  "--credential-from takes env:<NAME> or an op:// reference (for example op://Private/Anthropic/credential), never the key itself: a command line is visible to other processes.";

/**
 * The credential kind, from `--credential` (undefined: an API key). The
 * value is never echoed: it may be a key passed by mistake.
 * @param {string | undefined} value
 * @returns {{ kind: "api-key" | "subscription" } | { error: string }}
 */
export function credentialKind(value) {
  if (value === undefined) return { kind: API_KEY };
  if (value === API_KEY || value === SUBSCRIPTION) return { kind: value };
  return {
    error: `--credential takes ${CREDENTIAL_KINDS[0]} (the default) or ${CREDENTIAL_KINDS[1]} (a Claude subscription token, opted into at your own risk).`,
  };
}

/**
 * Where the credential comes from, from `--credential-from` (undefined: the
 * default variable for `kind`). The value is never echoed: it may be the
 * key itself.
 * @param {string | undefined} value
 * @param {"api-key" | "subscription"} [kind]
 * @returns {{ kind: "env", name: string } | { kind: "op", ref: string } | { error: string }}
 */
export function credentialSource(value, kind = API_KEY) {
  if (value === undefined) {
    return { kind: "env", name: accepted[kind].env };
  }
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
 * Read the credential of `kind`. Returns it with a description of where it
 * came from (never the value), or refusal lines that never hold it.
 * @param {{
 *   source: { kind: "env", name: string } | { kind: "op", ref: string },
 *   env: Record<string, string | undefined>,
 *   runner: import("../exec.mjs").Runner,
 *   kind?: "api-key" | "subscription",
 * }} opts
 * @returns {{ credential: string, from: string } | { refused: string[] }}
 */
export function readCredential({ source, env, runner, kind = API_KEY }) {
  const token = kind === SUBSCRIPTION;
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
    return checked(
      r.stdout.replace(/\r?\n$/, ""),
      "the op read result",
      "1Password (op read)",
      kind,
    );
  }
  const { name } = source;
  if (!token && name.toUpperCase() === accepted[SUBSCRIPTION].env) return notAnApiKey(name);
  const command = `npx @mnaimfaizy/agent-kit deep-scan${token ? " --credential subscription" : ""}`;
  const value = valueOf(env, name);
  if (!value) {
    return {
      refused: token
        ? [
            `No model credential: ${name} is not set. deep-scan --credential subscription needs a Claude subscription token, which stays outside the sandbox, in its model proxy.`,
            `Make one with claude setup-token, keep it in 1Password, and read it from there: --credential-from op://<vault>/<item>/<field>, or op run -- ${command} with ${name} set to an op:// reference.`,
          ]
        : [
            `No model credential: ${name} is not set. deep-scan needs an Anthropic API key, which stays outside the sandbox, in its model proxy.`,
            `Set ${name} for this run, or read it from 1Password: --credential-from op://<vault>/<item>/<field>, or op run -- ${command} with ${name} set to an op:// reference.`,
          ],
    };
  }
  if (value.startsWith("op://")) {
    return {
      refused: [
        `${name} holds a 1Password reference, not a ${token ? "token" : "key"}: run deep-scan under op run, which resolves it, for example:`,
        `  op run -- ${command}`,
        "or pass the reference with --credential-from instead.",
      ],
    };
  }
  return checked(value, name, name, kind);
}

/** The variable's value, by name in any letter case (as Windows matches it). */
function valueOf(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function checked(value, what, from, kind) {
  if (!value) return { refused: [`No model credential: ${what} is empty.`] };
  // The credential goes into an HTTP header: printable ASCII with no space only.
  if (!/^[\x21-\x7e]+$/.test(value)) {
    return {
      refused: [
        `${what} holds whitespace or a control character, so it is not a model credential (its value is not shown).`,
      ],
    };
  }
  const isToken = value.startsWith(OAUTH_TOKEN_PREFIX);
  if (kind !== SUBSCRIPTION && isToken) return notAnApiKey(what);
  if (kind === SUBSCRIPTION && !isToken) {
    return {
      refused: [
        `${what} does not hold a Claude subscription token (one starts sk-ant-oat; its value is not shown). --credential subscription takes the token claude setup-token prints.`,
        "For an Anthropic API key, leave out --credential subscription: the API-key path is the default, and the supported one.",
      ],
    };
  }
  return { credential: value, from };
}

// Without the opt-in, the model proxy sends the credential as x-api-key,
// which a subscription token is not: the model API would answer 401 once
// the sandbox is built.
function notAnApiKey(what) {
  return {
    refused: [
      `${what} holds a Claude subscription token, not an API key (its value is not shown). deep-scan runs on an API key unless you opt into the subscription path with --credential subscription, at your own risk: it relies on undocumented behaviour (see the caveats in the docs).`,
      "Or make an API key in a dedicated Anthropic Console workspace with its own spend limit, and pass that instead.",
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
