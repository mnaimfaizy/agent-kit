// The Scan recipe: where it lives, how it is read, and what a valid one holds.
//
// The recipe is read at the trusted ref (the default branch's tip) with git,
// never from the working tree and never from issue or pull request text, so
// nothing an outsider writes can change what a Deep scan builds or runs.
// Validation returns every problem at once, each naming its field.

import { CLI_VERSION } from "../tags.mjs";
import { checkSafePath } from "../safe-paths.mjs";
import { groundingUrlProblem, isGroundingUrl } from "./grounding-url.mjs";
import {
  isMapping,
  parseScalar,
  parseYamlSubset,
  stripBom,
  stripComment,
} from "../yaml-subset.mjs";

export const DEFAULT_RECIPE_PATH = ".security/scan-recipe.yml";

/** The recipe-format docs, at the tag this CLI was published from. */
export const RECIPE_DOCS_URL = `https://github.com/mnaimfaizy/agent-kit/blob/v${CLI_VERSION}/docs/security-audit.md#scan-recipe`;

/** A recipe larger than this is refused unread: a real one is a page or two. */
export const MAX_RECIPE_BYTES = 256 * 1024;

export const RECIPE_FIELDS = [
  "image",
  "dockerfile",
  "setup",
  "registries",
  "start",
  "ready",
  "seed",
  "entry_points",
  "fixtures",
  "grounding",
  "notes",
];

const ENTRY_KINDS = ["url", "port", "command"];

// Keys that would set a limit. Limits come from launcher flags or workflow
// inputs only, so a merged recipe change can never raise a run's spend.
const LIMIT_KEY =
  /(?:^|_)(?:limits?|timeouts?|turns|max_turns|tokens?|token_cap|budget|spend|wall_clock|minutes|seconds|duration)(?:$|_)/i;
const COMPOSE_KEY =
  /^(?:compose|compose_file|docker_compose|services|containers|sidecars|sibling_containers)$/i;
const SOCKET_KEY = /^(?:docker_socket|socket|docker_host)$/i;
const COMPOSE_FILE = /(?:^|\/)(?:docker-)?compose\.ya?ml$/i;
const CONTAINER_COMMAND = /(?:^|[\s;&|(`])(?:docker|docker-compose|podman|nerdctl)(?=\s|$)/m;

// Shapes of real credentials. Fixtures and every other field hold fake
// values only: the recipe is committed, and the sandbox is not a secret store.
const CREDENTIALS = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, "an Anthropic API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
];

export class RecipeError extends Error {}

/**
 * Read the recipe at `ref` (a commit). Returns `{ found: false }` when the
 * ref has no file at `path`, else `{ found: true, text, oid }`. Throws
 * RecipeError when `path` is unsafe, or names a folder, a symbolic link or a
 * submodule, or the file is too large.
 *
 * @param {{ runner: import("../exec.mjs").Runner, root: string, ref: string, path: string }} opts
 */
export function readRecipeAtRef({ runner, root, ref, path }) {
  const listed = runner("git", ["-C", root, "ls-tree", "--full-tree", "-z", ref, "--", path]);
  if (listed.status !== 0) {
    throw new RecipeError(`git could not list ${path} at ${ref}: ${listed.stderr.trim()}`);
  }
  const entry = listed.stdout.split("\0").find((e) => e.endsWith(`\t${path}`));
  if (!entry) return { found: false };
  const [mode, type, oid] = entry.slice(0, entry.indexOf("\t")).split(" ");
  if (type !== "blob")
    throw new RecipeError(`${path} is a ${type === "tree" ? "folder" : type}, not a file.`);
  if (mode === "120000")
    throw new RecipeError(`${path} is a symbolic link; commit the recipe itself.`);
  const size = runner("git", ["-C", root, "cat-file", "-s", oid]);
  if (size.status !== 0) throw new RecipeError(`git could not read ${path}: ${size.stderr.trim()}`);
  if (Number(size.stdout.trim()) > MAX_RECIPE_BYTES) {
    throw new RecipeError(`${path} is larger than ${MAX_RECIPE_BYTES / 1024} KiB.`);
  }
  const blob = runner("git", ["-C", root, "cat-file", "blob", oid]);
  if (blob.status !== 0) throw new RecipeError(`git could not read ${path}: ${blob.stderr.trim()}`);
  return { found: true, text: blob.stdout, oid };
}

/**
 * A note for a recipe `image` named by tag alone, or null when it carries a
 * `@sha256:` digest. The image is trusted like the recipe, and is pulled and
 * built on the host's Docker, outside the sandbox runtime, so what a tag
 * names should not change between runs unseen. A warning, not a refusal, so
 * existing recipes still run.
 *
 * @param {string} image
 * @returns {string | null}
 */
export function imageDigestNote(image) {
  if (/@sha256:[0-9a-f]{64}$/.test(String(image))) return null;
  return `Note: the recipe's image ${image} has no @sha256: digest, so what it names can change between runs. Pin it as ${String(image).split("@")[0]}@sha256:<digest>; the image is pulled and built on this machine's Docker, outside the sandbox runtime, and is trusted like the recipe.`;
}

/**
 * Every problem with a recipe's text, each one line naming its field. An
 * empty list means the recipe is valid.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function validateRecipe(text) {
  const problems = [];
  const say = (field, problem) => problems.push(`${field}: ${problem}`);
  if (stripBom(text).trim() === "") return ["the recipe is empty."];

  const lines = lineProblems(text);
  for (const key of lines.twice) say(key, "is given more than once.");
  for (const problem of lines.problems) problems.push(problem);
  // A null-prototype copy: a `__proto__:` key becomes an ordinary key that
  // the field checks see and refuse, never a hidden prototype.
  const recipe = ownCopy(parseYamlSubset(text, { problems }));

  for (const key of Object.keys(recipe)) {
    const problem = keyProblem(key, RECIPE_FIELDS);
    if (problem) say(key, problem);
  }

  // image or dockerfile, at most one: without either, the scan runs on the
  // Harness image (ADR 0029).
  const hasImage = "image" in recipe;
  const hasDockerfile = "dockerfile" in recipe;
  if (hasImage && hasDockerfile) {
    say("image and dockerfile", "give one of them, not both.");
  }
  if (hasImage && !isWord(recipe.image)) {
    say("image", "must be one image reference, such as node:22-bookworm@sha256:<digest>.");
  }
  if (hasDockerfile) {
    const file = recipe.dockerfile;
    if (typeof file !== "string" || file === "") {
      say("dockerfile", "must be a path in the repository, such as Dockerfile.");
    } else if (COMPOSE_FILE.test(file)) {
      say("dockerfile", composeProblem());
    } else {
      try {
        checkSafePath(file, "dockerfile");
      } catch (err) {
        say("dockerfile", `${err.message}; give a path relative to the repository root.`);
      }
    }
  }

  // Commands: setup is required, start, ready and seed are optional.
  const commands = {};
  for (const field of ["setup", "start", "ready", "seed"]) {
    if (!(field in recipe)) continue;
    commands[field] = commandList(recipe[field], field, say);
    if ((field === "start" || field === "ready") && commands[field]?.length === 0) {
      say(field, "is empty; leave start and ready out when every entry point is a command.");
    }
  }
  if (!("setup" in recipe)) {
    say("setup", "is missing; list the commands that install dependencies (or write setup: []).");
  }

  if (!("registries" in recipe)) {
    say("registries", "is missing; list the hosts setup may reach (or write registries: []).");
  } else {
    const list = asList(recipe.registries, "registries", say);
    list?.forEach((r, i) => {
      if (!isWord(r)) say(`registries[${i}]`, "must be one host name or URL.");
    });
  }

  // Entry points: at least one, each a url, port or command with a note.
  let entries = null;
  if (!("entry_points" in recipe)) {
    say("entry_points", "is missing; list what the scan may probe, each with a note.");
  } else {
    entries = asList(recipe.entry_points, "entry_points", say);
    if (entries && entries.length === 0) {
      say("entry_points", "is empty; list at least one url, port or command to probe.");
    }
    entries?.forEach((entry, i) => entryProblems(entry, `entry_points[${i}]`, say));
  }

  // start and ready come as a pair, and are optional only when every entry
  // point is a command (a CLI needs no server).
  const hasStart = "start" in recipe;
  const hasReady = "ready" in recipe;
  if (hasStart && !hasReady) {
    say(
      "start",
      "is given without ready; add ready, the commands that confirm the services are up.",
    );
  } else if (hasReady && !hasStart) {
    say("ready", "is given without start; add start, the commands that start the services.");
  } else if (!hasStart && entries) {
    const i = entries.findIndex((e) => isMapping(e) && !("command" in e));
    if (i >= 0) {
      const kind = ENTRY_KINDS.find((k) => k in entries[i]);
      say(
        "start and ready",
        `are missing, and entry_points[${i}] ${kind ? `is a ${kind}` : "is not a command"}: they may be left out only when every entry point is a command.`,
      );
    }
  }

  if (!("fixtures" in recipe)) {
    say(
      "fixtures",
      "is missing; list the test users and roles, with fake values (or write fixtures: []).",
    );
  } else {
    asList(recipe.fixtures, "fixtures", say)?.forEach((f, i) => {
      if (!isMapping(f)) say(`fixtures[${i}]`, "must be a mapping, such as user: alice.");
    });
  }

  if ("grounding" in recipe) {
    asList(recipe.grounding, "grounding", say)?.forEach((g, i) => {
      if (!isWord(g)) say(`grounding[${i}]`, "must be one URL or repository path.");
      else if (isGroundingUrl(g)) {
        // Fetched on the host, so only a public https:// page (see grounding-url.mjs).
        const problem = groundingUrlProblem(g);
        if (problem) say(`grounding[${i}]`, `${problem}.`);
      }
    });
  }

  if (!("notes" in recipe)) {
    say("notes", "is missing; say what stays static-only (what this scan never exercises).");
  } else if (typeof recipe.notes === "string") {
    if (recipe.notes.trim() === "") say("notes", "is empty; say what stays static-only.");
  } else {
    const list = asList(recipe.notes, "notes", say);
    if (list && list.length === 0) say("notes", "is empty; say what stays static-only.");
    list?.forEach((t, i) => {
      if (typeof t !== "string" || t.trim() === "") say(`notes[${i}]`, "must be a line of text.");
    });
  }

  // Anywhere in the recipe: no Docker socket, no real credential.
  let socket = false;
  walkStrings(recipe, "", (where, value) => {
    if (/docker\.sock/i.test(value)) {
      socket = true;
      say(where, socketProblem());
    }
    for (const [pattern, kind] of CREDENTIALS) {
      if (pattern.test(value)) {
        say(where, `looks like ${kind}; the recipe is committed, so it holds fake values only.`);
        break;
      }
    }
  });

  // Even on a line the reader dropped.
  if (!socket && /docker\.sock/i.test(text)) say("(recipe)", socketProblem());

  for (const [field, list] of Object.entries(commands)) {
    list?.forEach((cmd, i) => {
      if (CONTAINER_COMMAND.test(cmd)) say(`${field}[${i}]`, composeProblem());
    });
  }
  entries?.forEach((entry, i) => {
    if (
      isMapping(entry) &&
      typeof entry.command === "string" &&
      CONTAINER_COMMAND.test(entry.command)
    ) {
      say(`entry_points[${i}].command`, composeProblem());
    }
  });
  return problems;
}

function composeProblem() {
  return "no compose file and no sibling containers; start each service as a process with start and ready, inside the one sandbox.";
}

function socketProblem() {
  return "names the Docker socket; the sandbox never gets one.";
}

/** Why `key` cannot be in a mapping whose fields are `known`, or null. */
function keyProblem(key, known) {
  if (known.includes(key)) return null;
  if (LIMIT_KEY.test(key)) {
    return "the recipe holds no limits; set time, turn and token limits with deep-scan's options or the deep-scan workflow's inputs.";
  }
  if (COMPOSE_KEY.test(key)) return composeProblem();
  if (SOCKET_KEY.test(key)) return socketProblem();
  return `is not a Scan recipe field (fields: ${known.join(", ")}).`;
}

function entryProblems(entry, where, say) {
  if (!isMapping(entry)) {
    say(where, "must be a mapping with one of url, port or command, and a note.");
    return;
  }
  for (const key of Object.keys(entry)) {
    const problem = keyProblem(key, [...ENTRY_KINDS, "note"]);
    if (problem)
      say(`${where}.${key}`, problem.replace("a Scan recipe field", "an entry point field"));
  }
  const kinds = ENTRY_KINDS.filter((k) => k in entry);
  if (kinds.length === 0) say(where, "has none of url, port or command.");
  if (kinds.length > 1) say(where, `gives ${kinds.join(" and ")}; give exactly one.`);
  if ("url" in entry && !/^https?:\/\/\S+$/.test(String(entry.url ?? ""))) {
    say(`${where}.url`, "must be an http:// or https:// URL.");
  }
  if ("port" in entry) {
    const port = Number(entry.port);
    if (!/^[1-9]\d*$/.test(String(entry.port ?? "")) || port > 65535) {
      say(`${where}.port`, "must be a port number from 1 to 65535.");
    }
  }
  if ("command" in entry && (typeof entry.command !== "string" || entry.command.trim() === "")) {
    say(`${where}.command`, "must be a command line.");
  }
  if (!("note" in entry) || typeof entry.note !== "string" || entry.note.trim() === "") {
    say(where, "has no note; give each entry point a one-line note on what it is.");
  } else if (entry.note.trim().includes("\n")) {
    say(`${where}.note`, "must be one line.");
  }
}

/** A field that holds commands: one command, or a list of them. */
function commandList(value, field, say) {
  if (typeof value === "string" && value.trim() !== "" && !/^[[{]/.test(value)) return [value];
  const list = asList(value, field, say);
  list?.forEach((cmd, i) => {
    if (typeof cmd !== "string" || cmd.trim() === "")
      say(`${field}[${i}]`, "must be a command line.");
  });
  return list?.filter((c) => typeof c === "string") ?? null;
}

/** `value` as a list, or null after saying why it is not one. */
function asList(value, field, say) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim() === "[]") return [];
  if (typeof value === "string" && /^[[{]/.test(value.trim())) {
    say(field, "write it as a block list, one `- item` per line (only an empty [] may be inline).");
  } else {
    say(field, "must be a list, one `- item` per line.");
  }
  return null;
}

/** One non-empty token with no spaces: an image, a host, a URL or a path. */
function isWord(value) {
  return typeof value === "string" && /^\S+$/.test(value);
}

/** Call `visit(where, value)` for every string in `value`, with its field path. */
function walkStrings(value, where, visit) {
  if (typeof value === "string") visit(where || "(recipe)", value);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${where}[${i}]`, visit));
  else if (isMapping(value)) {
    for (const [k, v] of Object.entries(value)) walkStrings(v, where ? `${where}.${k}` : k, visit);
  }
}

/**
 * A copy of the reader's output in which every mapping has a null
 * prototype. The reader assigns keys with `obj[key] = value`, so a
 * `__proto__:` mapping became the object's prototype: it comes back here as
 * an own `__proto__` key.
 */
function ownCopy(value) {
  if (Array.isArray(value)) return value.map(ownCopy);
  if (!isMapping(value)) return value;
  const copy = Object.create(null);
  for (const [k, v] of Object.entries(value)) copy[k] = ownCopy(v);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) copy.__proto__ = ownCopy(proto);
  return copy;
}

const TOP_KEY = /^("[^"]*"|'[^']*'|[^\s#:"'-][^:]*?):(?:\s+(.*))?$/;

/**
 * Problems the YAML reader would pass over without a word, found from the
 * top-level lines: a line that is not `key: value`, a line indented under a
 * key that holds a single value (the reader drops it), and a key given twice
 * (the reader keeps the last). Keys are compared unquoted.
 */
function lineProblems(text) {
  const problems = [];
  const seen = new Set();
  const twice = new Set();
  let current = null; // { key, single } for the last top-level key
  const all = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
  all.forEach((raw, index) => {
    const line = stripComment(raw).trimEnd();
    if (line.trim() === "") return;
    const n = index + 1;
    if (/^\s/.test(line)) {
      if (current?.single) {
        problems.push(
          `line ${n}: is indented under ${current.key}, which holds a single value; the reader would drop it.`,
        );
      }
      return;
    }
    if (line === "---" && seen.size === 0) return;
    if (line === "-" || line.startsWith("- ")) {
      // A list at the key's own indent: valid only under a key with no value.
      if (current && !current.single) return;
      problems.push(`line ${n}: is a list item with no key above it to belong to.`);
      return;
    }
    const m = TOP_KEY.exec(line);
    if (!m) {
      problems.push(`line ${n}: is not a \`key: value\` line; the reader would drop it.`);
      current = null;
      return;
    }
    const key = parseScalar(m[1]);
    if (seen.has(key)) twice.add(key);
    seen.add(key);
    const value = (m[2] ?? "").trim();
    current = { key, single: value !== "" && !/^[|>][-+0-9]*$/.test(value) };
  });
  return { problems, twice: [...twice] };
}

/**
 * What the sandbox lifecycle runs and copies from a recipe that
 * `validateRecipe` passed: the image or Dockerfile, each command field as a
 * list, and the registries and grounding lists.
 *
 * @param {string} text
 * @returns {{ image?: string, dockerfile?: string, setup: string[], start: string[],
 *   ready: string[], seed: string[], registries: string[], grounding: string[] }}
 */
export function recipeSteps(text) {
  const recipe = parseYamlSubset(text);
  const strings = (value) =>
    Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  const commands = (value) =>
    typeof value === "string" && value.trim() !== "" && !/^[[{]/.test(value)
      ? [value]
      : strings(value);
  return {
    ...(typeof recipe.image === "string" ? { image: recipe.image } : {}),
    ...(typeof recipe.dockerfile === "string" ? { dockerfile: recipe.dockerfile } : {}),
    setup: commands(recipe.setup),
    start: commands(recipe.start),
    ready: commands(recipe.ready),
    seed: commands(recipe.seed),
    registries: strings(recipe.registries),
    grounding: strings(recipe.grounding),
  };
}
