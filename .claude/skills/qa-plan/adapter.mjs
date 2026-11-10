// The QA config reader: one place that turns `qa.config.{yml,yaml,json}` into
// an object, for `qa-plan` and `manual-qa` alike (ADAPTER.md).
//
// ONE FILE, TWO SKILLS
//   `qa-plan` owns this file and `manual-qa` carries a byte-identical copy,
//   enforced by a contract test (DESIGN.md, "Two skills, one format"). Each
//   skill reads its own section and ignores the other's: `plan:` is checked
//   here in full, `run:` is accepted as it is and left to `manual-qa`.
//
// WHY A PARSER, AND WHY THIS SMALL
//   Both skills import only Node built-ins, and Node ships no YAML parser.
//   This reader takes JSON whole, and YAML only in the subset ADAPTER.md
//   documents. Anything outside that subset, any unknown key and any value of
//   the wrong shape is a **problem**, reported with its line, never a silent
//   default. The approach is copied from the `instruction-drift-audit` skill's
//   reader, not imported: a Portable skill carries everything it runs.
//
// THE YAML SUBSET
//   - block mappings and block sequences, indented with spaces; a sequence may
//     sit at its key's own indent (`suites:` then `- name: backend`);
//   - plain, single-quoted or double-quoted scalars;
//   - flow lists and flow mappings that open and close on one line, nested
//     freely (`{ name: api, surfaces: ["api/**"] }`, `[]`, `{}`);
//   - full-line `#` comments anywhere, and a trailing ` # comment`.
//   Every scalar is a string. Tabs, anchors, aliases, multi-line scalars,
//   escapes inside quotes and duplicate keys are outside it; JSON is the
//   dialect for anything the subset cannot say.
//
// CLI (run from the repository root; `--repo <dir>` points elsewhere)
//   node adapter.mjs check --for plan      config, problems, effective values, readiness
//   node adapter.mjs hazards < files.txt   Hazard packs matching the changed paths
//   node adapter.mjs delivery [--label L]… where the plan goes, by `plan.publish`
//   node adapter.mjs render [--write] < answers.json
//                                          the config with the answers merged in
//   Each prints JSON (render prints the new file body, or writes it with --write)
//   and exits 1 on any problem, 2 on bad usage.

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Lookup order: the first file present is the config (ADAPTER.md). */
export const CONFIG_FILES = /** @type {const} */ ([
  "qa.config.yml",
  "qa.config.yaml",
  "qa.config.json",
]);

export const TOP_KEYS = /** @type {const} */ (["working_dir", "plan", "hazards", "run"]);
export const PLAN_KEYS = /** @type {const} */ (["base_ref", "suites", "publish", "tracker"]);
export const SUITE_KEYS = /** @type {const} */ (["name", "command", "junit", "surfaces"]);
export const PUBLISH_KEYS = /** @type {const} */ (["when_label", "default", "to", "label"]);
export const HAZARD_KEYS = /** @type {const} */ (["pack"]);
export const PUBLISH_TARGETS = /** @type {const} */ ([
  "working-copy",
  "tracker-issue",
  "pr-comment",
]);
export const TRACKERS = /** @type {const} */ (["github", "none"]);

/** ADAPTER.md's defaults. `base_ref` and `suites` have none: the readiness check asks. */
export const DEFAULTS = Object.freeze({
  working_dir: "tmp/qa",
  publish: Object.freeze([Object.freeze({ default: true, to: "working-copy" })]),
  tracker: "none",
});

// ── YAML subset ─────────────────────────────────────────────────────────────

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*?)|[ \t]*)$/;
const SEQUENCE_LINE = /^-(?:[ \t]|$)/;
const indentOf = (line) => line.text.length - line.text.trimStart().length;

/** Problems a plain scalar raises: the YAML features outside the subset. */
function plainProblems(value, problem) {
  if (value.startsWith("&") || value.startsWith("*"))
    problem(
      `\`${value[0]}\` (anchor or alias) is outside the YAML subset ADAPTER.md documents — ` +
        "write the config as JSON instead",
    );
  if (/^[|>][+-]?$/.test(value))
    problem("multi-line scalars are outside the YAML subset ADAPTER.md documents");
}

/**
 * One flow value starting at `text[i]`: a list, a mapping, a quoted or a
 * plain scalar. Plain scalars end at `,`, `]` or `}`; a mapping key also ends
 * at `:`.
 *
 * @returns {[unknown, number]} the value and the index after it
 */
function parseFlow(text, i, problem, stops = ",]}") {
  const skip = (j) => {
    while (j < text.length && /\s/.test(text[j])) j += 1;
    return j;
  };
  i = skip(i);
  const open = text[i];
  if (open === "[" || open === "{") {
    const close = open === "[" ? "]" : "}";
    const out = open === "[" ? [] : {};
    i = skip(i + 1);
    if (text[i] === close) return [out, i + 1];
    while (i < text.length) {
      if (open === "[") {
        const [item, next] = parseFlow(text, i, problem);
        out.push(item);
        i = skip(next);
      } else {
        const [key, afterKey] = parseFlow(text, i, problem, ":,}");
        i = skip(afterKey);
        if (text[i] !== ":") {
          problem(`expected \`key: value\` inside \`{…}\` after \`${key}\``);
          return [out, text.length];
        }
        const [value, next] = parseFlow(text, i + 1, problem);
        if (Object.hasOwn(out, String(key))) problem(`duplicate key \`${key}\``);
        out[String(key)] = value;
        i = skip(next);
      }
      if (text[i] === ",") {
        i = skip(i + 1);
        continue;
      }
      if (text[i] === close) return [out, i + 1];
      break;
    }
    problem(
      `a flow ${open === "[" ? "list" : "mapping"} must close on the same line with \`${close}\``,
    );
    return [out, text.length];
  }
  if (open === "'" || open === '"') {
    const end = text.indexOf(open, i + 1);
    if (end === -1) {
      problem(`unterminated ${open} quote`);
      return [text.slice(i + 1), text.length];
    }
    const quoted = text.slice(i + 1, end);
    // Real YAML reads `\` escapes inside "…"; this subset does not, so a
    // backslash there would be read differently from every other YAML tool.
    if (open === '"' && quoted.includes("\\"))
      problem(
        'escapes inside "…" are outside the YAML subset ADAPTER.md documents — ' +
          "use single quotes, or write the config as JSON",
      );
    return [quoted, end + 1];
  }
  let j = i;
  while (j < text.length && !stops.includes(text[j])) j += 1;
  const value = text.slice(i, j).trim();
  plainProblems(value, problem);
  if (value === "") problem("an empty value inside a flow collection");
  return [value, j];
}

/**
 * The value after `key:` or `- ` on one line.
 *
 * @param {string} raw
 * @param {(message: string) => void} problem
 */
function inlineValue(raw, problem) {
  const text = raw.trim();
  if (/^[[{'"]/.test(text)) {
    const [value, end] = parseFlow(text, 0, problem);
    const rest = text.slice(end);
    if (rest.trim() !== "" && !/^\s+#/.test(rest))
      problem(`unexpected text after the value: ${rest.trim()}`);
    return value;
  }
  const value = text.replace(/\s+#.*$/, "").trim();
  plainProblems(value, problem);
  return value;
}

/**
 * Parse the documented YAML subset, with no shape check.
 *
 * @param {string} text
 * @returns {{value: Record<string, unknown>, problems: string[], lines: Map<string, number>}}
 *   `lines` maps a key path (`plan.suites[0]`) to the line it starts on.
 */
export function parseYamlSubset(text) {
  const problems = [];
  const lines = [];
  const where = new Map();
  String(text)
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const no = index + 1;
      if (raw.trim() === "" || /^\s*#/.test(raw)) return;
      if (/^\s*\t/.test(raw)) {
        problems.push(`line ${no}: indented with a tab; use spaces`);
        return;
      }
      lines.push({ text: raw.replace(/\s+$/, ""), no });
    });

  let pos = 0;
  const at = (line, message) => problems.push(`line ${line.no}: ${message}`);

  function parseBlock(indent, path) {
    return SEQUENCE_LINE.test(lines[pos].text.trimStart())
      ? parseSequence(indent, path)
      : parseMapping(indent, {}, path);
  }

  /** The value of `key:`: inline on its line, or the block below it. */
  function valueFor(line, rest, indent, path) {
    if (rest !== undefined && rest !== "" && !/^#/.test(rest))
      return inlineValue(rest, (message) => at(line, message));
    const next = lines[pos];
    if (!next) return null;
    const nextIndent = indentOf(next);
    if (nextIndent > indent) return parseBlock(nextIndent, path);
    if (nextIndent === indent && SEQUENCE_LINE.test(next.text.trimStart()))
      return parseSequence(indent, path);
    return null;
  }

  function parseMapping(indent, map, path) {
    while (pos < lines.length) {
      const line = lines[pos];
      const lineIndent = indentOf(line);
      if (lineIndent < indent) break;
      if (lineIndent > indent) {
        at(line, "unexpected indentation");
        pos += 1;
        continue;
      }
      const body = line.text.slice(lineIndent);
      if (SEQUENCE_LINE.test(body)) break; // a sequence at the parent's indent
      const match = body.match(KEY_LINE);
      pos += 1;
      if (!match) {
        at(line, `expected \`key: value\`, found \`${body}\``);
        continue;
      }
      const [, key, rest] = match;
      const keyPath = path ? `${path}.${key}` : key;
      if (Object.hasOwn(map, key)) at(line, `duplicate key \`${key}\``);
      where.set(keyPath, line.no);
      map[key] = valueFor(line, rest, indent, keyPath);
    }
    return map;
  }

  function parseSequence(indent, path) {
    const items = [];
    while (pos < lines.length) {
      const line = lines[pos];
      const lineIndent = indentOf(line);
      const body = line.text.slice(lineIndent);
      if (lineIndent < indent) break;
      if (lineIndent > indent) {
        at(line, "unexpected indentation");
        pos += 1;
        continue;
      }
      if (!SEQUENCE_LINE.test(body)) break;
      pos += 1;
      const itemPath = `${path}[${items.length}]`;
      where.set(itemPath, line.no);
      const content = body.replace(/^-[ \t]*/, "");
      if (content === "") {
        const next = lines[pos];
        items.push(next && indentOf(next) > indent ? parseBlock(indentOf(next), itemPath) : null);
        continue;
      }
      const match = /^[[{'"]/.test(content) ? null : content.match(KEY_LINE);
      if (match) {
        // `- key: value` opens a mapping whose keys sit where `key` sits.
        const keyIndent = lineIndent + (body.length - content.length);
        const map = {};
        where.set(`${itemPath}.${match[1]}`, line.no);
        map[match[1]] = valueFor(line, match[2], keyIndent, `${itemPath}.${match[1]}`);
        items.push(parseMapping(keyIndent, map, itemPath));
        continue;
      }
      items.push(inlineValue(content, (message) => at(line, message)));
    }
    return items;
  }

  let value = {};
  if (lines.length) {
    if (indentOf(lines[0]) !== 0) at(lines[0], "the first key must start at column 1");
    if (SEQUENCE_LINE.test(lines[0].text.trimStart())) {
      at(lines[0], "the config must be a mapping, not a list");
      pos = lines.length;
    } else value = parseMapping(0, {}, "");
    while (pos < lines.length) {
      at(lines[pos], "unexpected indentation");
      pos += 1;
    }
  }
  return { value, problems, lines: where };
}

// ── Shapes ──────────────────────────────────────────────────────────────────

const isMapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStringList = (v) => Array.isArray(v) && v.every((item) => typeof item === "string");
const isTrue = (v) => v === true || v === "true";

/**
 * A checker that names each problem with its key path, and its line when the
 * source was YAML. A path with no line of its own (a value inside a flow
 * collection) takes the line of the nearest enclosing path that has one.
 */
function problemSink(lines) {
  const problems = [];
  const lineOf = (path) => {
    let p = path;
    while (p) {
      if (lines?.has(p)) return lines.get(p);
      const parent = p.replace(/(?:\.[^.[\]]+|\[\d+\])$/, "");
      if (parent === p) break;
      p = parent;
    }
    return undefined;
  };
  return {
    problems,
    add(path, message) {
      const line = lineOf(path);
      problems.push(`${line ? `line ${line}: ` : ""}\`${path}\`: ${message}`);
    },
  };
}

function unknownKeys(sink, map, path, known) {
  for (const key of Object.keys(map))
    if (!known.includes(key))
      sink.add(
        path ? `${path}.${key}` : key,
        `unknown key (ADAPTER.md documents: ${known.join(", ")})`,
      );
}

const present = (v) => v !== null && v !== undefined;

/** Repository-relative, forward slashes, never leaving the repository. */
const isRepoPath = (v) =>
  typeof v === "string" &&
  v !== "" &&
  !/^(?:[A-Za-z]:)?[\\/]/.test(v) &&
  !v.split(/[\\/]/).includes("..");

/**
 * Every problem in a parsed config. `run:` is accepted as it is: `manual-qa`
 * owns that section and checks it.
 *
 * @param {Record<string, unknown>} config
 * @param {Map<string, number>} [lines]
 * @returns {string[]}
 */
export function configProblems(config, lines) {
  const sink = problemSink(lines);
  unknownKeys(sink, config, "", TOP_KEYS);

  const workingDir = config.working_dir;
  if (present(workingDir) && !isRepoPath(workingDir))
    sink.add("working_dir", "expected a relative path inside the repository");

  const plan = config.plan;
  if (present(plan) && !isMapping(plan)) sink.add("plan", "expected a mapping");
  if (isMapping(plan)) planProblems(sink, plan);

  const hazards = config.hazards;
  if (present(hazards)) {
    if (!Array.isArray(hazards)) sink.add("hazards", "expected a list of `{ pack: <path> }`");
    else
      hazards.forEach((entry, n) => {
        const path = `hazards[${n}]`;
        if (!isMapping(entry)) return sink.add(path, "expected a mapping with a `pack` path");
        unknownKeys(sink, entry, path, HAZARD_KEYS);
        if (!isRepoPath(entry.pack))
          sink.add(`${path}.pack`, "expected a relative path inside the repository");
      });
  }
  return sink.problems;
}

function planProblems(sink, plan) {
  unknownKeys(sink, plan, "plan", PLAN_KEYS);

  if (present(plan.base_ref) && (typeof plan.base_ref !== "string" || plan.base_ref === ""))
    sink.add("plan.base_ref", "expected a git ref, such as `origin/main`");

  if (present(plan.tracker) && !TRACKERS.includes(plan.tracker))
    sink.add("plan.tracker", `expected one of: ${TRACKERS.join(", ")}`);

  if (present(plan.suites)) {
    if (!Array.isArray(plan.suites)) sink.add("plan.suites", "expected a list of suites");
    else {
      const names = new Set();
      plan.suites.forEach((suite, n) => {
        const path = `plan.suites[${n}]`;
        if (!isMapping(suite)) return sink.add(path, "expected a mapping");
        unknownKeys(sink, suite, path, SUITE_KEYS);
        for (const key of ["name", "command"])
          if (typeof suite[key] !== "string" || suite[key] === "")
            sink.add(`${path}.${key}`, "required: expected a string");
        if (typeof suite.name === "string") {
          if (names.has(suite.name))
            sink.add(`${path}.name`, `duplicate suite name \`${suite.name}\``);
          names.add(suite.name);
        }
        if (present(suite.junit) && !isRepoPath(suite.junit))
          sink.add(`${path}.junit`, "expected a relative path inside the repository");
        if (present(suite.surfaces) && !isStringList(suite.surfaces))
          sink.add(`${path}.surfaces`, "expected a list of globs");
      });
    }
  }

  if (present(plan.publish)) {
    if (!Array.isArray(plan.publish)) sink.add("plan.publish", "expected a list of rules");
    else {
      let defaultAt = -1;
      plan.publish.forEach((rule, n) => {
        const path = `plan.publish[${n}]`;
        if (!isMapping(rule)) return sink.add(path, "expected a mapping");
        unknownKeys(sink, rule, path, PUBLISH_KEYS);
        if (defaultAt !== -1)
          sink.add(
            path,
            `never reached: rule ${defaultAt} is a \`default\` rule, and the first match wins`,
          );
        const byLabel = present(rule.when_label);
        const byDefault = present(rule.default);
        if (byLabel && byDefault)
          sink.add(path, "give one of `when_label` or `default: true`, not both");
        else if (!byLabel && !byDefault) sink.add(path, "give a `when_label` or `default: true`");
        if (byLabel && (typeof rule.when_label !== "string" || rule.when_label === ""))
          sink.add(`${path}.when_label`, "expected a label name");
        if (byDefault && !isTrue(rule.default)) sink.add(`${path}.default`, "expected `true`");
        if (byDefault && !byLabel && isTrue(rule.default) && defaultAt === -1) defaultAt = n;
        if (!PUBLISH_TARGETS.includes(rule.to))
          sink.add(`${path}.to`, `required: expected one of: ${PUBLISH_TARGETS.join(", ")}`);
        if (present(rule.label)) {
          if (rule.to !== "tracker-issue")
            sink.add(`${path}.label`, "only a `tracker-issue` rule labels what it creates");
          else if (typeof rule.label !== "string" || rule.label === "")
            sink.add(`${path}.label`, "expected a label name");
        }
        if (
          PUBLISH_TARGETS.includes(rule.to) &&
          rule.to !== "working-copy" &&
          !present(plan.tracker)
        )
          sink.add(
            `${path}.to`,
            `\`${rule.to}\` needs \`plan.tracker\` set: \`github\`, or \`none\` to keep plans in the working copy`,
          );
      });
    }
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Parse a config's text in the dialect its name says.
 *
 * @param {string} path
 * @param {string} text
 * @returns {{config: Record<string, unknown>, problems: string[]}}
 */
export function parseConfig(path, text) {
  if (path.endsWith(".json")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        config: {},
        problems: [`not valid JSON: ${error instanceof Error ? error.message : error}`],
      };
    }
    if (!isMapping(parsed)) return { config: {}, problems: ["the config must be a JSON object"] };
    return { config: parsed, problems: configProblems(parsed) };
  }
  const { value, problems, lines } = parseYamlSubset(text);
  return { config: value, problems: [...problems, ...configProblems(value, lines)] };
}

/**
 * Find and parse the config.
 *
 * @param {(path: string) => string | null | undefined} read a repository
 *   file's text, or null when it is not there
 * @returns {{path: string | null, config: Record<string, any>, problems: string[]}}
 *   `path` is null when the repository has no config: not an error, the
 *   readiness check says what to ask for.
 */
export function readQaConfig(read) {
  for (const path of CONFIG_FILES) {
    const text = read(path);
    if (text === null || text === undefined) continue;
    return { path, ...parseConfig(path, text) };
  }
  return { path: null, config: {}, problems: [] };
}

/**
 * The values each step uses: the config's own, or ADAPTER.md's defaults.
 * Read a config with no problems; a key with a problem is not defaulted.
 *
 * @param {Record<string, any>} config
 */
export function effectiveConfig(config) {
  const plan = isMapping(config.plan) ? config.plan : {};
  return {
    working_dir: present(config.working_dir) ? config.working_dir : DEFAULTS.working_dir,
    plan: {
      base_ref: present(plan.base_ref) ? plan.base_ref : null,
      suites: Array.isArray(plan.suites) ? plan.suites : [],
      publish: Array.isArray(plan.publish) && plan.publish.length ? plan.publish : DEFAULTS.publish,
      tracker: present(plan.tracker) ? plan.tracker : DEFAULTS.tracker,
    },
    hazards: Array.isArray(config.hazards) ? config.hazards : [],
    run: present(config.run) ? config.run : null,
  };
}

/**
 * What `qa-plan` still needs before it composes. `needs` are asked for; a
 * `note` is said, and compose goes on.
 *
 * @param {{path: string | null, config: Record<string, any>, problems: string[]}} read
 * @returns {{ready: boolean, needs: string[], notes: string[]}}
 */
export function planReadiness({ path, config, problems }) {
  if (problems.length)
    return { ready: false, needs: ["a config with no problems: fix each one listed"], notes: [] };
  const needs = [];
  const notes = [];
  if (path === null) notes.push(`no ${CONFIG_FILES.join(" / ")} at the repository root`);
  const { plan } = effectiveConfig(config);
  if (!plan.base_ref)
    needs.push("plan.base_ref: the ref this pull request merges into, such as `origin/main`");
  if (!plan.suites.length)
    needs.push(
      "plan.suites: each test suite CI runs, with its `name`, the `command` that runs it, " +
        "the `junit` XML path it writes, and the `surfaces` globs it covers",
    );
  for (const suite of plan.suites)
    if (!present(suite.junit))
      notes.push(
        `suite \`${suite.name}\` has no \`junit\` path: what it proves is read from its exit code only, tagged [reconstructed]`,
      );
  return { ready: needs.length === 0, needs, notes };
}

/**
 * Where a plan goes: the first `plan.publish` rule that matches wins.
 * `tracker: none` keeps every plan in the working copy.
 *
 * @param {Record<string, any>} config a config with no problems
 * @param {{labels?: string[]}} subject the subject issue's labels
 * @returns {{to: string, label: string | null, rule: number | null, why: string}}
 */
export function pickDelivery(config, { labels = [] } = {}) {
  const { plan } = effectiveConfig(config);
  const rules = plan.publish;
  const index = rules.findIndex(
    (rule) =>
      isTrue(rule.default) ||
      // GitHub label names are case-insensitive.
      (present(rule.when_label) &&
        labels.some((label) => label.toLowerCase() === String(rule.when_label).toLowerCase())),
  );
  if (index === -1)
    return { to: "working-copy", label: null, rule: null, why: "no `plan.publish` rule matched" };
  const rule = rules[index];
  const ruleName = rules === DEFAULTS.publish ? "the default rule" : `plan.publish[${index}]`;
  if (plan.tracker === "none" && rule.to !== "working-copy")
    return {
      to: "working-copy",
      label: null,
      rule: rules === DEFAULTS.publish ? null : index,
      why: `${ruleName} says \`${rule.to}\`, but \`plan.tracker\` is \`none\``,
    };
  return {
    to: rule.to,
    label: rule.to === "tracker-issue" && present(rule.label) ? rule.label : null,
    rule: rules === DEFAULTS.publish ? null : index,
    why: isTrue(rule.default)
      ? `${ruleName} (default)`
      : `${ruleName}: label \`${rule.when_label}\``,
  };
}

// ── Hazard packs ────────────────────────────────────────────────────────────

/**
 * A glob as a regular expression over a `/`-separated, repository-relative
 * path. `**` spans directories, `*` and `?` stay inside one; nothing else is
 * special. A pattern matches the whole path.
 *
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slashAfter = glob[i + 2] === "/";
      const atSegmentStart = i === 0 || glob[i - 1] === "/";
      if (atSegmentStart && slashAfter) {
        source += "(?:[^/]+/)*";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[\\^$.+()|{}[\]]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

const SECTIONS = /** @type {const} */ ([
  ["ruleOutFirst", "Rule out first"],
  ["captureRules", "Capture rules"],
]);

/**
 * A Hazard pack: `when:` globs in frontmatter, then a *Rule out first* and a
 * *Capture rules* section (ADAPTER.md, "Hazard packs").
 *
 * @param {string} text
 * @returns {{when: string[], ruleOutFirst: string, captureRules: string, problems: string[]}}
 */
export function parseHazardPack(text) {
  const problems = [];
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  const out = { when: [], ruleOutFirst: "", captureRules: "", problems };
  if (lines[0]?.trimEnd() !== "---") {
    problems.push("line 1: expected `---` opening frontmatter with `when:` globs");
    return out;
  }
  const end = lines.findIndex((line, n) => n > 0 && line.trimEnd() === "---");
  if (end === -1) {
    problems.push("the frontmatter opened on line 1 never closes with `---`");
    return out;
  }
  const front = parseYamlSubset(lines.slice(1, end).join("\n"));
  // Frontmatter lines start on line 2 of the pack.
  problems.push(
    ...front.problems.map((p) => p.replace(/^line (\d+)/, (_, n) => `line ${Number(n) + 1}`)),
  );
  const shifted = new Map([...front.lines].map(([k, n]) => [k, n + 1]));
  const sink = problemSink(shifted);
  unknownKeys(sink, front.value, "", ["when"]);
  if (!isStringList(front.value.when) || front.value.when.length === 0)
    sink.add("when", "required: expected a non-empty list of globs");
  else out.when = front.value.when;
  problems.push(...sink.problems);

  const body = lines.slice(end + 1);
  // A `#` line inside a fenced code block (a shell comment, say) is not a heading.
  const fenced = [];
  let fence = null;
  for (const line of body) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && marker) {
      fence = marker;
      fenced.push(true);
    } else if (fence !== null) {
      fenced.push(true);
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      )
        fence = null;
    } else fenced.push(false);
  }
  const headingLevel = (n) =>
    fenced[n] ? 0 : (/^ {0,3}(#{1,6})\s/.exec(body[n])?.[1].length ?? 0);
  for (const [key, title] of SECTIONS) {
    const pattern = new RegExp(`^#{2,6}\\s+${title}\\s*#*\\s*$`, "i");
    const start = body.findIndex((line, n) => !fenced[n] && pattern.test(line.trim()));
    if (start === -1) {
      problems.push(`no \`## ${title}\` section`);
      continue;
    }
    const level = headingLevel(start);
    let stop = body.length;
    for (let n = start + 1; n < body.length; n += 1) {
      const heading = headingLevel(n);
      if (heading && heading <= level) {
        stop = n;
        break;
      }
    }
    const content = body
      .slice(start + 1, stop)
      .join("\n")
      .trim();
    if (content === "") problems.push(`line ${end + 2 + start}: the \`${title}\` section is empty`);
    out[key] = content;
  }
  return out;
}

/**
 * The Hazard packs whose `when:` globs match any changed path.
 *
 * @param {(path: string) => string | null | undefined} read
 * @param {Record<string, any>} config a config with no problems
 * @param {string[]} changed repository-relative paths the diff touches
 * @returns {{packs: {pack: string, matched: string[], ruleOutFirst: string, captureRules: string}[], problems: string[]}}
 */
export function matchHazards(read, config, changed) {
  const packs = [];
  const problems = [];
  const paths = changed.map((p) => p.trim().replace(/\\/g, "/")).filter(Boolean);
  for (const { pack } of effectiveConfig(config).hazards) {
    const text = read(pack);
    if (text === null || text === undefined) {
      problems.push(`${pack}: no such file (named in \`hazards\`)`);
      continue;
    }
    const parsed = parseHazardPack(text);
    if (parsed.problems.length) {
      problems.push(...parsed.problems.map((p) => `${pack}: ${p}`));
      continue;
    }
    const globs = parsed.when.map(globToRegExp);
    const matched = paths.filter((p) => globs.some((glob) => glob.test(p)));
    if (matched.length)
      packs.push({
        pack,
        matched,
        ruleOutFirst: parsed.ruleOutFirst,
        captureRules: parsed.captureRules,
      });
  }
  return { packs, problems };
}

// ── Writing ─────────────────────────────────────────────────────────────────

const PLAIN_SAFE = /^[A-Za-z0-9_./@~+-][A-Za-z0-9_./@~+=-]*$/;
const RESERVED = /^(?:true|false|null|yes|no|on|off|~)$/i;

/** A scalar the subset reads back unchanged. */
function emitScalar(value) {
  const text = String(value);
  const cannot = () =>
    new Error(`cannot write ${JSON.stringify(text)} in the YAML subset; use qa.config.json`);
  // A value spans one line, and a backslash inside "…" is an escape to real YAML.
  if (/[\r\n]/.test(text)) throw cannot();
  if (PLAIN_SAFE.test(text) && !RESERVED.test(text) && !/^[-?]/.test(text)) return text;
  if (!text.includes('"') && !text.includes("\\")) return `"${text}"`;
  if (!text.includes("'")) return `'${text}'`;
  throw cannot();
}

function emitFlow(value) {
  if (Array.isArray(value)) return `[${value.map(emitFlow).join(", ")}]`;
  if (isMapping(value))
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${k}: ${emitFlow(v)}`)
      .join(", ")} }`;
  return value === true ? "true" : emitScalar(value);
}

function emitBlock(map, indent) {
  const pad = " ".repeat(indent);
  return Object.entries(map)
    .filter(([, v]) => present(v))
    .flatMap(([key, v]) => {
      if (Array.isArray(v) && v.length && v.every(isMapping))
        // Block style, one key per line: a formatter never wraps it out of the subset.
        return [
          `${pad}${key}:`,
          ...v.flatMap((item) => {
            const lines = emitBlock(item, indent + 4);
            if (!lines.length) return [`${pad}  - {}`];
            return lines.map((line, n) => (n === 0 ? `${pad}  - ${line.trimStart()}` : line));
          }),
        ];
      if (Array.isArray(v))
        return v.length
          ? [`${pad}${key}:`, ...v.map((item) => `${pad}  - ${emitFlow(item)}`)]
          : [`${pad}${key}: []`];
      if (isMapping(v)) return [`${pad}${key}:`, ...emitBlock(v, indent + 2)];
      return [`${pad}${key}: ${emitFlow(v)}`];
    });
}

/**
 * A `qa.config.yml` body for a config, in the subset this reader takes.
 * Written only with the person's consent (SKILL.md, step 2).
 *
 * @param {Record<string, any>} config
 * @returns {string}
 */
export function renderConfigYaml(config) {
  const problems = configProblems(config);
  if (problems.length) throw new Error(`the answers have problems:\n- ${problems.join("\n- ")}`);
  const ordered = Object.fromEntries(
    TOP_KEYS.filter((key) => present(config[key])).map((key) => [key, config[key]]),
  );
  return `${emitBlock(ordered, 0).join("\n")}\n`;
}

/**
 * The repository's config with the person's answers laid over it: a top-level
 * answer replaces that key, except `plan` and `run`, whose keys are merged one
 * level down. Nothing the answers do not name is lost.
 *
 * @param {Record<string, any>} existing
 * @param {Record<string, any>} answers
 */
export function mergeAnswers(existing, answers) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(answers))
    merged[key] =
      (key === "plan" || key === "run") && isMapping(existing[key]) && isMapping(value)
        ? { ...existing[key], ...value }
        : value;
  return merged;
}

/**
 * The file to write the answers to, and its new body: the config file the
 * lookup found (in its own dialect), or `qa.config.yml` when there is none.
 * Writing anywhere else would leave a second file that one of the two
 * shadows. YAML comments in the old file are not kept.
 *
 * @param {{path: string | null, config: Record<string, any>, problems: string[]}} loaded
 * @param {Record<string, any>} answers
 * @returns {{path: string, body: string}}
 */
export function renderConfigUpdate(loaded, answers) {
  if (loaded.problems.length)
    throw new Error(
      `${loaded.path} has problems; fix them first:\n- ${loaded.problems.join("\n- ")}`,
    );
  if (!isMapping(answers)) throw new Error("the answers must be a JSON object");
  const merged = mergeAnswers(loaded.config, answers);
  const path = loaded.path ?? CONFIG_FILES[0];
  if (path.endsWith(".json")) {
    const problems = configProblems(merged);
    if (problems.length) throw new Error(`the answers have problems:\n- ${problems.join("\n- ")}`);
    return { path, body: `${JSON.stringify(merged, null, 2)}\n` };
  }
  return { path, body: renderConfigYaml(merged) };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function repoReader(repo) {
  return (path) => {
    const absolute = join(repo, path);
    if (!existsSync(absolute)) return null;
    try {
      return readFileSync(absolute, "utf8");
    } catch {
      return null;
    }
  };
}

function option(argv, name) {
  const values = [];
  argv.forEach((arg, n) => {
    if (arg === name && argv[n + 1] !== undefined) values.push(argv[n + 1]);
  });
  return values;
}

const readStdin = () => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

/**
 * @param {string[]} argv the arguments after the script
 * @param {{read?: (path: string) => string | null, stdin?: () => string}} [io]
 * @returns {{code: number, out: string}}
 */
export function main(argv, io = {}) {
  const [command] = argv;
  const repo = option(argv, "--repo")[0] ?? process.cwd();
  const read = io.read ?? repoReader(repo);
  const stdin = io.stdin ?? readStdin;
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const loaded = readQaConfig(read);
  const usage = {
    code: 2,
    out:
      "usage: node adapter.mjs check --for plan | hazards < changed-paths | " +
      "delivery [--label <name>]… | render [--write] < answers.json   [--repo <dir>]\n",
  };

  if (command === "render") {
    try {
      const { path, body } = renderConfigUpdate(loaded, JSON.parse(stdin()));
      if (!argv.includes("--write")) return { code: 0, out: body };
      (io.write ?? ((p, text) => writeFileSync(join(repo, p), text)))(path, body);
      return { code: 0, out: `wrote ${path}\n` };
    } catch (error) {
      return { code: 1, out: `${error instanceof Error ? error.message : error}\n` };
    }
  }
  if (command === "check") {
    const section = option(argv, "--for")[0];
    if (section !== "plan") return usage;
    const readiness = planReadiness(loaded);
    return {
      code: loaded.problems.length ? 1 : 0,
      out: json({
        path: loaded.path,
        problems: loaded.problems,
        effective: loaded.problems.length ? null : effectiveConfig(loaded.config),
        readiness,
      }),
    };
  }
  if (loaded.problems.length)
    return { code: 1, out: json({ path: loaded.path, problems: loaded.problems }) };
  if (command === "hazards") {
    const result = matchHazards(read, loaded.config, stdin().split(/\r?\n/));
    return { code: result.problems.length ? 1 : 0, out: json(result) };
  }
  if (command === "delivery")
    return { code: 0, out: json(pickDelivery(loaded.config, { labels: option(argv, "--label") })) };
  return usage;
}

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// Compared as real paths: `file://${argv[1]}` never matches on Windows, and a
// symlinked skills directory must still count as running this file.
if (process.argv[1] && real(fileURLToPath(import.meta.url)) === real(process.argv[1])) {
  const { code, out } = main(process.argv.slice(2));
  process.stdout.write(out);
  process.exitCode = code;
}
