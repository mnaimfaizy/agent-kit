#!/usr/bin/env node
/**
 * The orchestrate records script: Run Events in, a Run Record out.
 *
 * Portable: Node built-ins and the tracker CLI only. One CLI, with
 * subcommands later tickets extend (upload, prune, dashboard, board):
 *
 *   node records.mjs event --file <events.jsonl> --kind <kind> --actor <actor> [--<field> <value>]...
 *   node records.mjs derive <run-folder>
 *   node records.mjs upload <run> [--yes]
 *   node records.mjs prune [--declined]
 *   node records.mjs dashboard [--local-logs]
 *
 * `main(argv, io)` is the one seam. `io` injects the clock (`now`), the files
 * root (`cwd`, which relative paths resolve against), the environment (`env`)
 * and a transport (`exec`: tracker CLI and git calls, `(command, args) =>
 * {code, out}`), so a test never touches the network or the real clock.
 *
 * A Run Record holds only counts, ids, SHAs, issue and pull request numbers,
 * times, durations, enum values and outcomes. Every value is checked against
 * a type that cannot hold prose, and a field outside the schema is an error,
 * never stripped.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { effectiveConfig, readConfig } from "./config.mjs";

export const SCHEMA = "run-record/1";
export const ACTORS = /** @type {const} */ (["human", "chief-of-staff", "delegation"]);

/**
 * The curated `cause` list. A cause is either avoidable (a fix to the skill,
 * the config, the harness or the spec would remove the step) or by design
 * (an expected step). `by-design` and `teammate-blocker` are by design.
 */
export const CAUSES = Object.freeze({
  "harness-limit": "avoidable",
  "permission-refusal": "avoidable",
  "tool-missing": "avoidable",
  "skill-bug": "avoidable",
  "spec-gap": "avoidable",
  "missing-config": "avoidable",
  "human-choice": "avoidable",
  other: "avoidable",
  "by-design": "by-design",
  "teammate-blocker": "by-design",
});

/** What a human step was: one touch of one kind. QA kinds carry a `qa-` prefix. */
export const STEP_KINDS = /** @type {const} */ ([
  "plan-approval",
  "card-start",
  "decision-request",
  "write-as-human",
  "typed-command",
  "readiness-answer",
  "permission-refusal",
  "review-label",
  "post-replies",
  "ruling-review",
  "merge",
  "close-out",
  "teammate-blocker",
  "qa-command",
  "qa-readiness",
  "qa-plan-delivery",
  "qa-run-need",
  "qa-host",
  "qa-held",
  "other",
]);

const RUN_KINDS = ["tickets", "spec", "team"];
const SUPPORT = ["verified", "tried", "documented"];
const AUTHORITY = ["relay", "autonomous"];
const LANDINGS = ["integration-branch", "per-ticket"];
const RUN_OUTCOMES = ["merged", "partly-merged", "abandoned"];
const DELEGATION_KINDS = ["building", "fix", "qa", "analysis"];
const EXECUTORS = ["live-session", "sub-agent", "headless", "human-started"];
const ROUTES = ["direct", "card"];
const DELEGATION_OUTCOMES = [
  "open",
  "landed",
  "sent-back",
  "abandoned",
  "analysis-delivered",
  "qa-pass",
  "qa-fail",
];
const HOW = ["chat", "card", "github"];
const TRACKERS = ["github", "gitlab"];
const VERDICTS = ["upheld", "overturned"];
const CI_RESULTS = ["pass", "fail"];
const QA_TARGETS = ["stack", "url"];
const QA_ROUTES = ["brief", "typed"];
const QA_RESULTS = ["pass", "fail", "waiting"];
const WRITE_KINDS = [
  "add-label",
  "post-replies",
  "post-comment",
  "open-pull-request",
  "edit-pull-request",
  "move-label",
  "close-issue",
  "other",
];

// --- Value types. Every one is closed: an enum, a number, or a pattern that cannot hold a sentence.

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}$/;
const REPO = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][\w.-]*\/[\w.-]+$/;
const SHA = /^[0-9a-f]{7,64}$/;

const t = {
  int: { type: "int" },
  bool: { type: "bool" },
  iso: { type: "iso" },
  id: { type: "id" },
  sha: { type: "sha" },
  repo: { type: "repo" },
  login: { type: "login" },
  enum: (values) => ({ type: "enum", values }),
  list: (item) => ({ type: "list", item }),
  nullable: (inner) => ({ type: "nullable", inner }),
  object: (fields) => ({ type: "object", fields }),
  /** A map from an id to a count, such as the number of human steps by cause. */
  counts: (keys) => ({ type: "counts", keys }),
};

/**
 * Check one value against a type. Returns null when it fits, otherwise a
 * short reason that never repeats the value (a rejected value may be prose).
 */
function violates(type, value) {
  switch (type.type) {
    case "int":
      return Number.isInteger(value) && value >= 0 ? null : "must be a whole number";
    case "bool":
      return typeof value === "boolean" ? null : "must be true or false";
    case "iso":
      return typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value))
        ? null
        : "must be a UTC time like 2026-11-19T03:10:20Z";
    case "id":
      return typeof value === "string" && ID.test(value)
        ? null
        : "must be an id (letters, digits, . _ : -), and is free text otherwise";
    case "sha":
      return typeof value === "string" && SHA.test(value) ? null : "must be a git SHA";
    case "repo":
      return typeof value === "string" && REPO.test(value) ? null : "must be host/owner/repo";
    case "login":
      return typeof value === "string" && LOGIN.test(value) ? null : "must be a tracker login";
    case "enum":
      return type.values.includes(value) ? null : `must be one of ${type.values.join(" | ")}`;
    case "nullable":
      return value === null ? null : violates(type.inner, value);
    default:
      return "has a shape the schema does not allow here";
  }
}

/**
 * Walk a value against a schema type and collect every violation as a dotted
 * path with a reason. Objects are closed: a key the type does not list is
 * "outside the schema". A key ending in `?` is optional.
 */
function check(type, value, path, problems) {
  if (type.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`${path}: must be an object`);
      return;
    }
    const known = new Map(
      Object.entries(type.fields).map(([key, inner]) => [key.replace(/\?$/, ""), [key, inner]]),
    );
    for (const key of Object.keys(value)) {
      if (!known.has(key)) problems.push(`${dotted(path, key)}: is outside the schema`);
    }
    for (const [name, [key, inner]] of known) {
      if (!Object.hasOwn(value, name)) {
        if (!key.endsWith("?")) problems.push(`${dotted(path, name)}: is missing`);
        continue;
      }
      check(inner, value[name], dotted(path, name), problems);
    }
    return;
  }
  if (type.type === "list") {
    if (!Array.isArray(value)) problems.push(`${path}: must be a list`);
    else value.forEach((item, n) => check(type.item, item, `${path}[${n}]`, problems));
    return;
  }
  if (type.type === "counts") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return void problems.push(`${path}: must be an object of counts`);
    for (const [key, count] of Object.entries(value)) {
      if (!type.keys.includes(key)) problems.push(`${dotted(path, key)}: is outside the schema`);
      else if (violates(t.int, count))
        problems.push(`${dotted(path, key)}: must be a whole number`);
    }
    return;
  }
  if (type.type === "nullable" && value !== null && ["object", "list"].includes(type.inner.type))
    return check(type.inner, value, path, problems);
  const reason = violates(type, value);
  if (reason) problems.push(`${path}: ${reason}`);
}

const dotted = (path, key) => (path === "" ? key : `${path}.${key}`);

// --- The Run Record schema.

const CAUSE_KEYS = Object.keys(CAUSES);

export const RECORD_SCHEMA = t.object({
  schema: t.enum([SCHEMA]),
  run: t.object({
    id: t.id,
    repo: t.nullable(t.repo),
    operator: t.nullable(t.login),
    kind: t.enum(RUN_KINDS),
    "spec?": t.int,
    team: t.bool,
    took_over: t.list(t.id),
    tickets: t.list(t.int),
    harness: t.id,
    support_level: t.enum(SUPPORT),
    decision_authority: t.enum(AUTHORITY),
    landing: t.nullable(t.enum(LANDINGS)),
    started_at: t.iso,
    plan_approved_at: t.nullable(t.iso),
    closed_at: t.iso,
    duration_seconds: t.int,
    outcome: t.enum(RUN_OUTCOMES),
    pull_requests: t.list(t.int),
    open_waits: t.int,
  }),
  delegations: t.list(
    t.object({
      id: t.id,
      issue: t.nullable(t.int),
      kind: t.enum(DELEGATION_KINDS),
      executor: t.enum(EXECUTORS),
      model: t.id,
      start_route: t.enum(ROUTES),
      started_at: t.iso,
      landed_at: t.nullable(t.iso),
      ended_at: t.nullable(t.iso),
      duration_seconds: t.nullable(t.int),
      outcome: t.enum(DELEGATION_OUTCOMES),
      send_backs: t.int,
      decision_requests: t.int,
      rulings: t.int,
    }),
  ),
  human_steps: t.list(
    t.object({
      at: t.iso,
      opened_at: t.nullable(t.iso),
      delegation: t.nullable(t.id),
      kind: t.enum(STEP_KINDS),
      cause: t.enum(CAUSE_KEYS),
      avoidable: t.bool,
      "issue?": t.int,
      actor: t.enum(ACTORS),
      wait_id: t.nullable(t.id),
      waited_seconds: t.nullable(t.int),
      how: t.nullable(t.enum(HOW)),
      "card?": t.id,
      "blocker?": t.int,
      "blocker_login?": t.login,
      covers: t.list(t.id),
    }),
  ),
  writes: t.list(
    t.object({
      at: t.iso,
      kind: t.enum(WRITE_KINDS),
      actor: t.enum(ACTORS),
      as_human: t.bool,
      delegation: t.nullable(t.id),
    }),
  ),
  reviews: t.list(
    t.object({
      pr: t.int,
      round: t.int,
      "head?": t.sha,
      findings: t.int,
      fixed: t.int,
      answered: t.int,
    }),
  ),
  ci: t.list(
    t.object({
      pr: t.int,
      head: t.sha,
      result: t.enum(CI_RESULTS),
      failed_checks: t.int,
    }),
  ),
  rulings: t.object({ made: t.int, upheld: t.int, overturned: t.int }),
  qa: t.list(
    t.object({
      delegation: t.id,
      target: t.enum(QA_TARGETS),
      route: t.enum(QA_ROUTES),
      result: t.enum(QA_RESULTS),
    }),
  ),
  summary: t.object({
    human_steps: t.int,
    avoidable: t.int,
    by_design: t.int,
    by_cause: t.counts(CAUSE_KEYS),
    human_wait_seconds: t.int,
  }),
});

/**
 * The safe-field check. Returns the problems, each naming the dotted path of
 * the field; an empty list means the record is safe to keep and share.
 */
export function checkRecord(record) {
  const problems = [];
  check(RECORD_SCHEMA, record, "", problems);
  return problems;
}

// --- The Run Event schema: one entry per kind, each field typed as above.

const actor = t.enum(ACTORS);
const ISSUE = t.int;
/** What every event carries: when (set by the clock, never typed), what, and who wrote it. */
const COMMON = { at: t.iso, kind: t.id, actor };

export const EVENT_KINDS = Object.freeze({
  "run-opened": {
    "repo?": t.repo,
    "tracker?": t.enum(TRACKERS),
    run_kind: t.enum(RUN_KINDS),
    "spec?": t.int,
    team: t.bool,
    "took_over?": t.list(t.id),
    "tickets?": t.list(t.int),
    harness: t.id,
    support_level: t.enum(SUPPORT),
    decision_authority: t.enum(AUTHORITY),
    "landing?": t.enum(LANDINGS),
  },
  "plan-approved": { "decision_authority?": t.enum(AUTHORITY) },
  "delegation-started": {
    delegation: t.id,
    "issue?": ISSUE,
    delegation_kind: t.enum(DELEGATION_KINDS),
    executor: t.enum(EXECUTORS),
    model: t.id,
    start_route: t.enum(ROUTES),
  },
  "delegation-landed": { delegation: t.id, "head?": t.sha },
  "delegation-ended": { delegation: t.id, outcome: t.enum(DELEGATION_OUTCOMES) },
  "send-back": { delegation: t.id },
  "decision-request": { "delegation?": t.id, id: t.id },
  "ruling-made": { delegation: t.id, ruling: t.id },
  "ruling-verdict": { ruling: t.id, verdict: t.enum(VERDICTS) },
  "wait-opened": {
    wait_id: t.id,
    "delegation?": t.id,
    step_kind: t.enum(STEP_KINDS),
    cause: t.enum(CAUSE_KEYS),
    how: t.enum(HOW),
    "card?": t.id,
    "issue?": ISSUE,
    "blocker?": t.int,
    "blocker_login?": t.login,
  },
  "wait-closed": { wait_id: t.id, "covers?": t.list(t.id) },
  "human-step": {
    "delegation?": t.id,
    step_kind: t.enum(STEP_KINDS),
    cause: t.enum(CAUSE_KEYS),
    how: t.enum(HOW),
    "card?": t.id,
    "issue?": ISSUE,
    "covers?": t.list(t.id),
  },
  write: { "delegation?": t.id, write_kind: t.enum(WRITE_KINDS), as_human: t.bool },
  review: {
    pr: t.int,
    round: t.int,
    "head?": t.sha,
    findings: t.int,
    fixed: t.int,
    answered: t.int,
  },
  ci: { pr: t.int, head: t.sha, result: t.enum(CI_RESULTS), failed_checks: t.int },
  "qa-result": {
    delegation: t.id,
    target: t.enum(QA_TARGETS),
    route: t.enum(QA_ROUTES),
    result: t.enum(QA_RESULTS),
  },
  "pull-request": { pr: t.int },
  "run-closed": { outcome: t.enum(RUN_OUTCOMES), "pull_requests?": t.list(t.int) },
});

/** Problems with one Run Event, as dotted field paths. */
export function checkEvent(event) {
  const problems = [];
  if (event === null || typeof event !== "object" || Array.isArray(event))
    return ["event: must be an object"];
  const fields = EVENT_KINDS[event.kind];
  if (!fields) return [`kind: must be one of ${Object.keys(EVENT_KINDS).join(" | ")}`];
  check(t.object({ ...COMMON, kind: t.enum([event.kind]), ...fields }), event, "", problems);
  return problems;
}

// --- Appending an event.

/** Read a CLI value as the type of the field it sets. Null when it does not read. */
function coerce(type, raw) {
  const inner = type.type === "nullable" ? type.inner : type;
  if (inner.type === "int") return /^\d+$/.test(raw) ? Number(raw) : raw;
  if (inner.type === "bool") return raw === "true" ? true : raw === "false" ? false : raw;
  if (inner.type === "list") {
    if (raw === "") return [];
    return raw
      .split(",")
      .map((item) => (inner.item.type === "int" ? coerce(inner.item, item) : item));
  }
  return raw;
}

function nowIso(io) {
  const now = io.now ? io.now() : new Date();
  return (now instanceof Date ? now : new Date(now)).toISOString().replace(/\.\d+Z$/, "Z");
}

/** Parse `--name value` pairs. Null on a bare word, a repeated name or a missing value. */
function pairs(args) {
  const out = {};
  for (let n = 0; n < args.length; n += 2) {
    const [name, value] = [args[n], args[n + 1]];
    if (!name?.startsWith("--") || value === undefined || Object.hasOwn(out, name)) return null;
    out[name.slice(2)] = value;
  }
  return out;
}

const EVENT_USAGE =
  "usage: node records.mjs event --file <events.jsonl> --kind <kind> --actor <human|chief-of-staff|delegation> [--<field> <value>]...\n";
const DERIVE_USAGE = "usage: node records.mjs derive <run-folder>\n";
const UPLOAD_USAGE = "usage: node records.mjs upload <run id or run folder> [--yes]\n";
const PRUNE_USAGE = "usage: node records.mjs prune [--declined]\n";
const DASHBOARD_USAGE =
  "usage: node records.mjs dashboard [--repo <host/owner/repo>] [--local-logs]\n";
const USAGE = `${EVENT_USAGE}${DERIVE_USAGE}${UPLOAD_USAGE}${PRUNE_USAGE}${DASHBOARD_USAGE}`;

function appendEvent(args, io) {
  const given = pairs(args);
  if (!given) return { code: 2, out: EVENT_USAGE };
  const { file, kind, ...rest } = given;
  if (!file || !kind) return { code: 2, out: EVENT_USAGE };
  if (basename(file) !== "events.jsonl")
    return { code: 2, out: "the events file must be named `events.jsonl`\n" };
  const fields = EVENT_KINDS[kind];
  if (!fields)
    return {
      code: 1,
      out: `kind: must be one of ${Object.keys(EVENT_KINDS).join(" | ")}\n`,
    };
  const event = { at: nowIso(io), kind };
  const problems = [];
  for (const [flag, raw] of Object.entries(rest)) {
    const name = flag.replaceAll("-", "_");
    if (name === "at") {
      problems.push("at: is set by the clock, never typed");
      continue;
    }
    const type = name === "actor" ? actor : (fields[name] ?? fields[`${name}?`] ?? null);
    if (!type) {
      problems.push(`${name}: is outside the schema for a \`${kind}\` event`);
      continue;
    }
    event[name] = coerce(type, raw);
  }
  problems.push(...checkEvent(event));
  if (problems.length) return { code: 1, out: `${[...new Set(problems)].join("\n")}\n` };
  const path = resolve(io.cwd ?? process.cwd(), file);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`);
  return { code: 0, out: `recorded ${kind} at ${event.at}\n` };
}

// --- Deriving the record.

const seconds = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));

/** The events of a run folder: the Chief of Staff's, then each Delegation's, each checked. */
function readEvents(runFolder) {
  const files = [];
  const own = join(runFolder, "events.jsonl");
  if (existsSync(own)) files.push(own);
  const delegations = join(runFolder, "delegations");
  if (existsSync(delegations))
    for (const name of readdirSync(delegations).sort()) {
      const path = join(delegations, name, "events.jsonl");
      if (existsSync(path)) files.push(path);
    }
  const events = [];
  const problems = [];
  for (const file of files) {
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, n) => {
        if (line.trim() === "") return;
        const where = `${file.slice(runFolder.length + 1)}:${n + 1}`;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return void problems.push(`${where}: is not JSON`);
        }
        const bad = checkEvent(event);
        if (bad.length) return void problems.push(...bad.map((p) => `${where}: ${p}`));
        events.push({ ...event, order: events.length });
      });
  }
  // Times have one-second resolution, so a Delegation's start sorts first among events of its second.
  const rank = (e) => (e.kind === "delegation-started" ? 0 : 1);
  events.sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || rank(a) - rank(b) || a.order - b.order,
  );
  return { events, problems };
}

/** `host/owner/repo` from a git remote URL, lowercased. Null when it does not read. */
export function repoFromRemote(url) {
  const bare = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+)$/i.exec(bare);
  if (!match || !match[2].includes("/")) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

/** The tracker CLI login: ORCHESTRATE_OPERATOR, or `gh api user` / `glab api user`. */
function operatorOf(io, tracker) {
  const env = io.env ?? process.env;
  if (env.ORCHESTRATE_OPERATOR) return env.ORCHESTRATE_OPERATOR;
  const exec = io.exec ?? defaultExec;
  // GitHub unless the run says it is on GitLab.
  const [command, args, field] =
    tracker === "gitlab" ? ["glab", ["api", "user"], "username"] : ["gh", ["api", "user"], "login"];
  const result = exec(command, args);
  if (result.code !== 0) return null;
  try {
    const login = JSON.parse(result.out)[field];
    return typeof login === "string" && LOGIN.test(login) ? login : null;
  } catch {
    return null;
  }
}

/** `host/owner/repo` from the `origin` remote, or the only remote. Null when there is none, or several and none is `origin`. */
function repoOf(io) {
  const exec = io.exec ?? defaultExec;
  const cwd = io.cwd ?? process.cwd();
  const git = (...args) => exec("git", ["-C", cwd, ...args]);
  const listed = git("remote");
  if (listed.code !== 0) return null;
  const remotes = listed.out.split(/\r?\n/).filter(Boolean);
  const name = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  if (name === null) return null;
  const url = git("remote", "get-url", name);
  return url.code === 0 ? repoFromRemote(url.out) : null;
}

/**
 * Build the record from the merged, time-ordered events. Returns `{record,
 * problems}`: problems are things the events themselves get wrong (a close
 * with no open, a Decision Request nobody raised), named so they can be fixed.
 */
function build(events, runId, operator) {
  const problems = [];
  const first = (kind) => events.find((e) => e.kind === kind);
  const opened = first("run-opened");
  const closed = events.findLast((e) => e.kind === "run-closed");
  if (!opened) problems.push("the run has no `run-opened` event");
  if (!closed) problems.push("the run has no `run-closed` event: derive at close-out");
  if (!opened || !closed) return { record: null, problems };

  const delegations = new Map();
  const steps = [];
  const open = new Map();
  const dr = new Set();
  const rulings = new Map();
  const writes = [];
  const reviews = [];
  const ci = [];
  const qa = [];
  const pulls = new Set();

  const delegation = (id, event) => {
    const found = delegations.get(id);
    if (!found)
      problems.push(`${event.kind}: \`${id}\` has no \`delegation-started\` event before it`);
    return found;
  };

  for (const e of events) {
    switch (e.kind) {
      case "delegation-started":
        delegations.set(e.delegation, {
          id: e.delegation,
          issue: e.issue ?? null,
          kind: e.delegation_kind,
          executor: e.executor,
          model: e.model,
          start_route: e.start_route,
          started_at: e.at,
          landed_at: null,
          ended_at: null,
          duration_seconds: null,
          outcome: "open",
          send_backs: 0,
          decision_requests: 0,
          rulings: 0,
        });
        break;
      case "delegation-landed": {
        const d = delegation(e.delegation, e);
        if (d) d.landed_at ??= e.at;
        break;
      }
      case "delegation-ended": {
        const d = delegation(e.delegation, e);
        if (d) {
          d.ended_at = e.at;
          d.outcome = e.outcome;
          d.duration_seconds = seconds(d.started_at, e.at);
        }
        break;
      }
      case "send-back": {
        const d = delegation(e.delegation, e);
        if (d) d.send_backs += 1;
        break;
      }
      case "decision-request": {
        dr.add(e.id);
        const d = e.delegation === undefined ? null : delegation(e.delegation, e);
        if (d) d.decision_requests += 1;
        break;
      }
      case "ruling-made": {
        rulings.set(e.ruling, null);
        const d = delegation(e.delegation, e);
        if (d) d.rulings += 1;
        break;
      }
      case "ruling-verdict":
        if (!rulings.has(e.ruling))
          problems.push(`ruling-verdict: \`${e.ruling}\` has no \`ruling-made\` event before it`);
        rulings.set(e.ruling, e.verdict);
        break;
      case "wait-opened":
        if (open.has(e.wait_id)) problems.push(`wait-opened: \`${e.wait_id}\` is already open`);
        open.set(e.wait_id, e);
        break;
      case "wait-closed": {
        const o = open.get(e.wait_id);
        if (!o) {
          problems.push(`wait-closed: \`${e.wait_id}\` has no \`wait-opened\` event before it`);
          break;
        }
        open.delete(e.wait_id);
        steps.push(step(o, e, { opened_at: o.at, waited_seconds: seconds(o.at, e.at) }));
        break;
      }
      case "human-step":
        steps.push(step(e, e, { opened_at: null, waited_seconds: null, wait_id: null }));
        break;
      case "write":
        writes.push({
          at: e.at,
          kind: e.write_kind,
          actor: e.actor,
          as_human: e.as_human,
          delegation: e.delegation ?? null,
        });
        break;
      case "review":
        reviews.push({
          pr: e.pr,
          round: e.round,
          ...(e.head ? { head: e.head } : {}),
          findings: e.findings,
          fixed: e.fixed,
          answered: e.answered,
        });
        break;
      case "ci":
        ci.push({ pr: e.pr, head: e.head, result: e.result, failed_checks: e.failed_checks });
        break;
      case "qa-result":
        qa.push({
          delegation: e.delegation,
          target: e.target,
          route: e.route,
          result: e.result,
        });
        break;
      case "pull-request":
        pulls.add(e.pr);
        break;
    }
  }

  // An open wait is held to the same rules as a closed one: it never becomes a step.
  const openWaits = [...open.values()].map((o) => ({ ...o, kind: o.step_kind }));
  for (const s of [...steps, ...openWaits]) {
    if (["plan-approval", "close-out"].includes(s.kind) && s.cause !== "by-design")
      problems.push(`human_steps: a \`${s.kind}\` step must have cause \`by-design\``);
    if (s.cause === "harness-limit" && s.card === undefined)
      problems.push("human_steps: a `harness-limit` step must name its `card`");
    if (s.cause === "teammate-blocker") {
      if (s.kind !== "teammate-blocker")
        problems.push(
          "human_steps: a `teammate-blocker` step must have step kind `teammate-blocker`",
        );
      if (s.blocker === undefined || s.blocker_login === undefined)
        problems.push(
          "human_steps: a `teammate-blocker` step must name its `blocker` ticket and `blocker_login`",
        );
    }
  }
  for (const s of steps)
    for (const id of s.covers)
      if (!dr.has(id)) problems.push(`covers: \`${id}\` names no \`decision-request\` event`);

  const approved = first("plan-approved");
  const byCause = {};
  const human = steps.filter((s) => s.actor === "human");
  for (const s of human) byCause[s.cause] = (byCause[s.cause] ?? 0) + 1;
  const verdicts = [...rulings.values()];
  const record = {
    schema: SCHEMA,
    run: {
      id: runId,
      repo: opened.repo ?? null,
      operator,
      kind: opened.run_kind,
      ...(opened.spec === undefined ? {} : { spec: opened.spec }),
      team: opened.team,
      took_over: opened.took_over ?? [],
      tickets: opened.tickets ?? [],
      harness: opened.harness,
      support_level: opened.support_level,
      decision_authority: approved?.decision_authority ?? opened.decision_authority,
      landing: opened.landing ?? null,
      started_at: opened.at,
      plan_approved_at: approved?.at ?? null,
      closed_at: closed.at,
      duration_seconds: seconds(opened.at, closed.at),
      outcome: closed.outcome,
      pull_requests: [...new Set([...(closed.pull_requests ?? []), ...pulls])].sort(
        (a, b) => a - b,
      ),
      open_waits: open.size,
    },
    delegations: [...delegations.values()],
    human_steps: steps,
    writes,
    reviews,
    ci,
    rulings: {
      made: rulings.size,
      upheld: verdicts.filter((v) => v === "upheld").length,
      overturned: verdicts.filter((v) => v === "overturned").length,
    },
    qa,
    summary: {
      human_steps: human.length,
      avoidable: human.filter((s) => s.avoidable).length,
      by_design: human.filter((s) => !s.avoidable).length,
      by_cause: byCause,
      human_wait_seconds: human.reduce((sum, s) => sum + (s.waited_seconds ?? 0), 0),
    },
  };
  return { record, problems, open: [...open.values()] };
}

/** One human step: the touch that closed a wait, or a touch with no wait. */
function step(source, touch, extra) {
  const wait = Object.hasOwn(extra, "wait_id") ? extra.wait_id : source.wait_id;
  return {
    at: touch.at,
    opened_at: extra.opened_at,
    delegation: source.delegation ?? null,
    kind: source.step_kind,
    cause: source.cause,
    avoidable: CAUSES[source.cause] === "avoidable",
    ...(source.issue === undefined ? {} : { issue: source.issue }),
    actor: touch.actor,
    wait_id: wait ?? null,
    waited_seconds: extra.waited_seconds,
    how: source.how ?? null,
    ...(source.card === undefined ? {} : { card: source.card }),
    ...(source.blocker === undefined ? {} : { blocker: source.blocker }),
    ...(source.blocker_login === undefined ? {} : { blocker_login: source.blocker_login }),
    covers: touch.covers ?? source.covers ?? [],
  };
}

function derive(args, io) {
  if (args.length !== 1) return { code: 2, out: DERIVE_USAGE };
  const runFolder = resolve(io.cwd ?? process.cwd(), args[0]);
  if (!existsSync(runFolder)) return { code: 2, out: `no run folder at \`${args[0]}\`\n` };
  const runId = basename(runFolder);
  const { events, problems } = readEvents(runFolder);
  if (problems.length) return { code: 1, out: `${problems.join("\n")}\n` };
  const opened = events.find((e) => e.kind === "run-opened");
  if (opened && !opened.repo) {
    const repo = repoOf(io);
    if (repo) opened.repo = repo;
  }
  const notes = [];
  const operator = opened ? operatorOf(io, opened.tracker ?? "github") : null;
  if (opened && operator === null)
    notes.push(
      "run.operator is null: no tracker login (set ORCHESTRATE_OPERATOR); nothing can be uploaded",
    );
  const built = build(events, runId, operator);
  const refused = [...built.problems, ...(built.record ? checkRecord(built.record) : [])];
  if (refused.length) return { code: 1, out: `${[...new Set(refused)].join("\n")}\n` };

  // Outside the run folder, so pruning or deleting it leaves the record.
  const dir = join(dirname(runFolder), "records");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${runId}.json`);
  const temporary = `${out}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(built.record, null, 2)}\n`);
  renameSync(temporary, out);
  const s = built.record.summary;
  const lines = [
    `wrote ${out}`,
    `${built.record.delegations.length} Delegations, ${s.human_steps} human steps (${s.avoidable} avoidable, ${s.by_design} by design), ${built.record.run.open_waits} waits still open${built.open.length ? `: ${built.open.map((o) => `${o.wait_id} (${o.step_kind})`).join(", ")}` : ""}`,
    ...notes,
  ];
  return { code: 0, out: `${lines.join("\n")}\n` };
}

// --- Sinks: one interface, `local`, `github` and `gitlab` behind it.
//
//   list(prefix)          the paths under a prefix, as a sorted list
//   read(path)            {status: "found", text} | {status: "missing"} | {status: "error", detail}
//   create(path, text)    create-only: {status: "created"} | {status: "exists"} | {status: "conflict"} | {status: "error", detail}
//   privacy()             {private, visibility}; both null when it cannot be read
//   access()              how many people can read the sink, or null when it cannot be read
//   kind                  what the disclosure calls the sink: "GitHub repository", "GitLab project"
//
// `create` never overwrites: it reports `exists` and writes nothing. What a
// caller does about an existing path (identical bytes count as uploaded,
// different bytes stop) is `createOnly`, shared by every sink.

const DOTS = /^\.+$/;
/** A sink path segment: lowercase, and never empty or only dots. */
const segmentOf = (value) => {
  const segment = String(value).toLowerCase();
  return segment === "" || DOTS.test(segment) || /[/\\\s]/.test(segment) ? null : segment;
};

/**
 * Open a sink by type.
 *
 * @param {"local" | "github" | "gitlab"} type
 * @param {{dir?: string, repo?: string, branch?: string | null, exec?: Function}} options
 */
export function openSink(type, options = {}) {
  if (type === "local") return localSink(options.dir);
  if (type === "github") return githubSink(options);
  if (type === "gitlab") return gitlabSink(options);
  throw new Error(`unknown sink type \`${type}\``);
}

/** The records folder on this machine: always on, never private to anyone but its owner. */
function localSink(dir) {
  const file = (path) => join(dir, path);
  return {
    name: "local",
    async list(prefix = "") {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => name.endsWith(".json") && name.startsWith(prefix))
        .sort();
    },
    async read(path) {
      try {
        return { status: "found", text: readFileSync(file(path), "utf8") };
      } catch (error) {
        return error?.code === "ENOENT"
          ? { status: "missing" }
          : { status: "error", detail: String(error?.code ?? error) };
      }
    },
    async create(path, text) {
      mkdirSync(dirname(file(path)), { recursive: true });
      try {
        writeFileSync(file(path), text, { flag: "wx" });
        return { status: "created" };
      } catch (error) {
        return error?.code === "EEXIST"
          ? { status: "exists" }
          : { status: "error", detail: String(error?.code ?? error) };
      }
    },
    async privacy() {
      return { private: true, visibility: "local" };
    },
    async access() {
      return null;
    },
  };
}

/** `owner/name` or `host/owner/name`, as the config reader checked it. */
function splitSinkRepo(repo, type = "github") {
  const parts = repo.split("/");
  return parts.length === 3
    ? { host: parts[0], owner: parts[1], name: parts[2] }
    : { host: type === "gitlab" ? "gitlab.com" : "github.com", owner: parts[0], name: parts[1] };
}

const NOT_FOUND = /HTTP 404|"status":\s*"404"/;

/** A private GitHub repository, written with `gh api` Contents calls. */
function githubSink({ repo, branch = null, exec = defaultExec }) {
  const { host, owner, name } = splitSinkRepo(repo);
  const gh = (args, options) =>
    exec("gh", ["api", ...(host === "github.com" ? [] : ["--hostname", host]), ...args], options);
  const base = `repos/${owner}/${name}`;
  const contents = (path) =>
    `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : "";
  const detail = (r) => (r.err || r.out || `exit ${r.code}`).trim().split("\n")[0];
  return {
    name: repo,
    kind: "GitHub repository",
    async list(prefix = "") {
      const first = gh([`${base}/git/trees/${branch ?? "HEAD"}?recursive=1`]);
      if (first.code !== 0) return null;
      let body;
      try {
        body = JSON.parse(first.out);
      } catch {
        return null;
      }
      // A truncated recursive listing is walked level by level instead.
      const entries = body.truncated ? walkTree(gh, base, branch ?? "HEAD") : body.tree;
      if (entries === null) return null;
      return entries
        .filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix))
        .map((entry) => entry.path)
        .sort();
    },
    async read(path) {
      const r = gh(["-H", "Accept: application/vnd.github.raw+json", `${contents(path)}${ref}`]);
      if (r.code === 0) return { status: "found", text: r.out };
      return NOT_FOUND.test(`${r.err}${r.out}`)
        ? { status: "missing" }
        : { status: "error", detail: detail(r) };
    },
    async create(path, text) {
      const body = {
        message: `Add Run Record ${basename(path, ".json")}`,
        content: Buffer.from(text, "utf8").toString("base64"),
        ...(branch ? { branch } : {}),
      };
      const r = gh(["-X", "PUT", contents(path), "--input", "-"], { input: JSON.stringify(body) });
      if (r.code === 0) return { status: "created" };
      const said = `${r.err}${r.out}`;
      if (/HTTP 409/.test(said)) return { status: "conflict" };
      // Contents refuses a create over an existing path with 422 (the sha it would need is missing).
      if (/HTTP 422/.test(said)) return { status: "exists" };
      return { status: "error", detail: detail(r) };
    },
    async privacy() {
      const r = gh(["--jq", ".visibility", base]);
      const visibility = r.code === 0 ? r.out.trim() : "";
      return visibility === ""
        ? { private: null, visibility: null }
        : { private: visibility === "private", visibility };
    },
    async access() {
      const r = gh(["--paginate", "--jq", ".[].login", `${base}/collaborators`]);
      return r.code === 0 ? r.out.split(/\r?\n/).filter(Boolean).length : null;
    },
  };
}

/** A GitLab 404: `glab api` prints the status in its message, or the body's own. */
const GITLAB_NOT_FOUND = /HTTP 404|\b404 (?:[A-Za-z]+ )*Not Found/i;
/** The most pages a listing follows: a stop for a server that never runs out. */
const MAX_PAGES = 1000;

/**
 * A private GitLab project, written with `glab api` Repository Files calls.
 * `--hostname` is always passed: inside a clone, `glab api` otherwise sends the request to that clone's host.
 * GitLab does not document create-only, so `createOnly` reads the path before
 * every create. Pages are followed by hand until one comes back empty, since a
 * server may cap `per_page` below what was asked.
 */
function gitlabSink({ repo, branch = null, exec = defaultExec }) {
  const { host, owner, name } = splitSinkRepo(repo, "gitlab");
  const glab = (args, options) => exec("glab", ["api", "--hostname", host, ...args], options);
  const project = `projects/${encodeURIComponent(`${owner}/${name}`)}`;
  const file = (path) => `${project}/repository/files/${encodeURIComponent(path)}`;
  const detail = (r) => (r.err || r.out || `exit ${r.code}`).trim().split("\n")[0];
  const json = (r) => {
    if (r.code !== 0) return null;
    try {
      return JSON.parse(r.out);
    } catch {
      return null;
    }
  };
  /** Every item of a paginated list endpoint, or null when a page cannot be read. */
  const pages = (endpoint) => {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = json(
        glab([`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`]),
      );
      if (!Array.isArray(body)) return null;
      if (body.length === 0) return items;
      items.push(...body);
    }
    return null;
  };
  // The Files API always wants a ref: the configured branch, else the project's default.
  let defaultBranch;
  const refOf = () => {
    if (branch) return branch;
    if (defaultBranch === undefined) defaultBranch = json(glab([project]))?.default_branch ?? null;
    return defaultBranch;
  };
  return {
    name: repo,
    kind: "GitLab project",
    async list(prefix = "") {
      const ref = refOf();
      if (ref === null) return null;
      const folder = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
      const query = `?recursive=true&ref=${encodeURIComponent(ref)}${folder ? `&path=${encodeURIComponent(folder)}` : ""}`;
      const tree = `${project}/repository/tree${query}`;
      let entries = pages(tree);
      if (entries === null) {
        // A folder that is not there yet is an empty listing, when the project itself can be read.
        const first = glab([`${tree}&per_page=100&page=1`]);
        if (!GITLAB_NOT_FOUND.test(`${first.err}${first.out}`) || json(glab([project])) === null)
          return null;
        entries = [];
      }
      return entries
        .filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix))
        .map((entry) => entry.path)
        .sort();
    },
    async read(path) {
      const ref = refOf();
      if (ref === null)
        return { status: "error", detail: "the project's default branch cannot be read" };
      const r = glab([`${file(path)}/raw?ref=${encodeURIComponent(ref)}`]);
      if (r.code === 0) return { status: "found", text: r.out };
      return GITLAB_NOT_FOUND.test(`${r.err}${r.out}`)
        ? { status: "missing" }
        : { status: "error", detail: detail(r) };
    },
    async create(path, text) {
      const ref = refOf();
      if (ref === null)
        return { status: "error", detail: "the project's default branch cannot be read" };
      const body = {
        branch: ref,
        commit_message: `Add Run Record ${basename(path, ".json")}`,
        encoding: "base64",
        content: Buffer.from(text, "utf8").toString("base64"),
      };
      const r = glab(
        ["-X", "POST", "-H", "Content-Type: application/json", file(path), "--input", "-"],
        {
          input: JSON.stringify(body),
        },
      );
      if (r.code === 0) return { status: "created" };
      const said = `${r.err}${r.out}`;
      if (/already exists/i.test(said)) return { status: "exists" };
      if (/\b409\b/.test(said)) return { status: "conflict" };
      return { status: "error", detail: detail(r) };
    },
    async privacy() {
      const body = json(glab([project]));
      const visibility = typeof body?.visibility === "string" ? body.visibility : "";
      return visibility === ""
        ? { private: null, visibility: null }
        : { private: visibility === "private", visibility };
    },
    async access() {
      const members = pages(`${project}/members/all`);
      return members === null ? null : members.length;
    },
  };
}

/** Every blob under a tree, read one level at a time. Null when a level cannot be read. */
function walkTree(gh, base, sha, prefix = "") {
  const r = gh([`${base}/git/trees/${sha}`]);
  if (r.code !== 0) return null;
  let body;
  try {
    body = JSON.parse(r.out);
  } catch {
    return null;
  }
  const out = [];
  for (const entry of body.tree) {
    const path = `${prefix}${entry.path}`;
    if (entry.type === "tree") {
      const below = walkTree(gh, base, entry.sha ?? entry.path, `${path}/`);
      if (below === null) return null;
      out.push(...below);
    } else out.push({ ...entry, path });
  }
  return out;
}

/**
 * The create-only rule for any sink: identical bytes at the path count as
 * already uploaded, different bytes stop the upload, and a conflict from
 * parallel writes is retried (the next read decides again).
 */
async function createOnly(sink, path, text, tries = 4) {
  let last = "";
  for (let n = 0; n < tries; n += 1) {
    const there = await sink.read(path);
    if (there.status === "error") return { status: "error", detail: there.detail };
    if (there.status === "found") return { status: there.text === text ? "already" : "different" };
    const made = await sink.create(path, text);
    if (made.status === "created") return { status: "created" };
    if (made.status === "error") return { status: "error", detail: made.detail };
    last = made.status;
  }
  return {
    status: "error",
    detail: `still ${last === "conflict" ? "a 409 conflict" : "in conflict"} after ${tries} tries`,
  };
}

// --- Uploading a closed run's Run Record.

const RECORD_KEPT = "It is kept indefinitely (git cannot expire it).";

/** The namespaced sink path: `records/<host>/<owner>/<repo>/<login>/<run-id>.json`, every segment lowercased. */
function sinkPath(repository, login, runId) {
  const segments = [...repository.split("/"), login, runId].map(segmentOf);
  return repository.split("/").length === 3 && segments.every(Boolean)
    ? `records/${segments.join("/")}.json`
    : null;
}

async function upload(args, io) {
  const yes = args.includes("--yes");
  const rest = args.filter((a) => a !== "--yes");
  if (rest.length !== 1 || rest[0].startsWith("--")) return { code: 2, out: UPLOAD_USAGE };
  const cwd = io.cwd ?? process.cwd();

  // The config: a problem in it is named, and nothing is uploaded.
  const read = (path) => {
    try {
      return readFileSync(resolve(cwd, path), "utf8");
    } catch {
      return null;
    }
  };
  const loaded = readConfig(read);
  if (loaded.problems.length) return { code: 1, out: `${loaded.problems.join("\n")}\n` };
  const { records, run_dir: runDir } = effectiveConfig(loaded.config);

  // Find the record: by id under the run folder, or beside a run folder given by path.
  const arg = rest[0];
  const asPath = arg.includes("/");
  const runId = asPath ? basename(resolve(cwd, arg)) : arg;
  const recordsDir = asPath
    ? join(dirname(resolve(cwd, arg)), "records")
    : resolve(cwd, runDir, "records");
  const local = openSink("local", { dir: recordsDir });
  const found = ID.test(runId) ? await local.read(`${runId}.json`) : { status: "missing" };
  if (found.status !== "found")
    return {
      code: 1,
      out: `no Run Record for \`${runId}\` in ${recordsDir}: derive it at close-out (\`records.mjs derive <run-folder>\`)\n`,
    };
  let record;
  try {
    record = JSON.parse(found.text);
  } catch {
    return { code: 1, out: `the Run Record for \`${runId}\` is not JSON: nothing uploaded\n` };
  }
  // The safe-field check runs again at upload: a record edited since it was derived is refused.
  const unsafe = checkRecord(record);
  if (unsafe.length) return { code: 1, out: `${unsafe.join("\n")}\nnothing uploaded\n` };

  if (records.sink === null)
    return {
      code: 1,
      out: `no \`records.sink\` in the config: the Run Record stays at ${join(recordsDir, `${runId}.json`)}\n`,
    };

  const login = record.run.operator;
  if (login === null)
    return {
      code: 1,
      out: "no tracker login: nothing is uploaded under no name. Sign in with `gh`, or set ORCHESTRATE_OPERATOR, and derive the record again\n",
    };
  const exec = io.exec ?? defaultExec;
  const repository = (
    records.repository ??
    record.run.repo ??
    repoOf({ ...io, exec })
  )?.toLowerCase();
  if (!repository) {
    return {
      code: 3,
      out: "cannot tell which repository this run belongs to: there are several remotes and none is `origin`, or there is no remote. Ask which one, then pin it as `records.repository`\n",
    };
  }
  const path = sinkPath(repository, login, record.run.id);
  if (path === null)
    return {
      code: 1,
      out: `\`${repository}\` is not a \`host/owner/repo\` name: nothing uploaded\n`,
    };

  const sink = openSink(records.sink.type, {
    repo: records.sink.repo,
    branch: records.sink.branch,
    exec,
  });

  // The privacy check, at every upload: visibility can change, and there is no override.
  const where = records.sink.repo;
  const privacy = await sink.privacy();
  if (privacy.private === null)
    return {
      code: 1,
      out: `cannot read whether \`${where}\` is private: nothing uploaded\n`,
    };
  if (!privacy.private)
    return {
      code: 1,
      out: `\`${where}\` is not private (${privacy.visibility}): a Run Record is never uploaded to it, and there is no override. Nothing uploaded\n`,
    };

  const people = await sink.access();
  const access =
    people === null ? "" : `, ${people} ${people === 1 ? "person" : "people"} with access`;
  const steps = record.summary.human_steps;
  const disclosure = `**Upload this run's Run Record?** To \`${where}\` (private ${sink.kind}${access}) at \`${path}\`. It holds counts, ids, times, outcomes and ${steps} human ${steps === 1 ? "step" : "steps"} with their kind and cause: no issue text, no command output, no prose. ${RECORD_KEPT} [Show the record] [Upload] [Not now]\n`;
  if (!yes) return { code: 0, out: `${disclosure}record: ${join(recordsDir, `${runId}.json`)}\n` };

  const done = await createOnly(sink, path, found.text);
  if (done.status === "error")
    return { code: 1, out: `${disclosure}upload failed: ${done.detail}\n` };
  if (done.status === "different")
    return {
      code: 1,
      out: `${disclosure}different bytes are already at \`${path}\` in \`${where}\`: the upload stopped and nothing was overwritten\n`,
    };
  const verb = done.status === "already" ? "already uploaded" : "uploaded";
  return { code: 0, out: `${disclosure}${verb} \`${path}\` to \`${where}\`\n` };
}

// --- Pruning closed-out run folders, on opt-in.

/** Where a "no" to the close-out's prune ask is remembered: a file beside the run folders, never a folder. */
const PRUNE_DECLINED = "prune-declined";
const DAY_MS = 86_400_000;

/**
 * Delete the closed-out run folders older than `prune.after_days`, and
 * nothing else. A run folder is closed out when its Run Record sits beside it
 * in `records/` (derived at close-out) and names the same run; its age is the
 * record's `closed_at` against the clock. An open run has no record, so it
 * stays; `records/` and every file in the run directory stay; a link is
 * never followed. Without the key nothing is deleted.
 *
 * `--declined` records the human's "no" to the close-out ask, so it is not asked again.
 */
function prune(args, io) {
  const declined = args.includes("--declined");
  if (args.length > (declined ? 1 : 0)) return { code: 2, out: PRUNE_USAGE };
  const cwd = io.cwd ?? process.cwd();
  const read = (path) => {
    try {
      return readFileSync(resolve(cwd, path), "utf8");
    } catch {
      return null;
    }
  };
  const loaded = readConfig(read);
  if (loaded.problems.length) return { code: 1, out: `${loaded.problems.join("\n")}\n` };
  const { prune: setting, run_dir: runDir } = effectiveConfig(loaded.config);
  const base = resolve(cwd, runDir);

  if (declined) {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, PRUNE_DECLINED), "declined at close-out; not asked again\n");
    return { code: 0, out: `recorded that pruning was declined: ${join(base, PRUNE_DECLINED)}\n` };
  }
  if (setting.after_days === null)
    return {
      code: 0,
      out: "pruning is off: set `prune.after_days` to turn it on. Nothing deleted\n",
    };
  if (!existsSync(base)) return { code: 0, out: "nothing to prune\n" };

  const now = new Date(io.now ? io.now() : Date.now()).getTime();
  const cutoff = now - setting.after_days * DAY_MS;
  if (!Number.isFinite(cutoff)) return { code: 1, out: "cannot read the clock: nothing deleted\n" };
  const deleted = [];
  let failed = null;
  for (const name of readdirSync(base).sort()) {
    if (name === "records" || !ID.test(name)) continue;
    const folder = join(base, name);
    if (!lstatSync(folder).isDirectory()) continue;
    const closed = closedAt(join(base, "records", `${name}.json`), name);
    if (closed === null || closed >= cutoff) continue;
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch (error) {
      failed = `${name}: ${error?.code ?? error}`;
      break;
    }
    deleted.push(name);
  }
  const done = deleted.map((name) => `pruned ${name}`);
  if (failed) return { code: 1, out: `${[...done, `could not delete ${failed}`].join("\n")}\n` };
  if (deleted.length === 0) return { code: 0, out: "nothing to prune\n" };
  return {
    code: 0,
    out: `${done.join("\n")}\n${deleted.length} closed-out run ${deleted.length === 1 ? "folder" : "folders"} older than ${setting.after_days} days deleted; every Run Record kept\n`,
  };
}

/** When a run closed (ms), from its Run Record. Null when the record is missing, unreadable, another run's, or has no valid time. */
function closedAt(path, runId) {
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    const closed = record?.run?.closed_at;
    if (record?.run?.id !== runId || typeof closed !== "string" || !ISO.test(closed)) return null;
    const time = Date.parse(closed);
    return Number.isNaN(time) ? null : time;
  } catch {
    return null;
  }
}

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

// --- The past-runs dashboard, built from the local Run Records.
//
// The pages live in `pages/` (one shell, one stylesheet, the dashboard's page
// builder); this is the command that reads the records, writes the files and
// prints the links. It never opens a browser.

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY/i;
const SECRET_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/** Prose with every credential the environment holds, and the usual token shapes, replaced. */
function redact(text, env) {
  let out = text;
  for (const [name, value] of Object.entries(env))
    if (SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8)
      out = out.split(value).join("[redacted]");
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[redacted]");
  return out;
}

/** Write a file whole or not at all: beside it first, then renamed over it. */
function writeWhole(path, text) {
  const beside = `${path}.${process.pid}.tmp`;
  writeFileSync(beside, text);
  renameSync(beside, path);
}

/** The sink path of a record, parsed: `records/<host>/<owner>/<repo>/<login>/<run-id>.json`. Null when it does not parse. */
export function parseSinkPath(path) {
  const parts = path.split("/");
  if (parts.length !== 6 || parts[0] !== "records" || !parts[5].endsWith(".json")) return null;
  const [, host, owner, repo, login, file] = parts;
  const id = file.slice(0, -".json".length);
  const named = [host, owner, repo, login].every((s) => segmentOf(s) === s);
  const repository = `${host}/${owner}/${repo}`;
  if (!named || !REPO.test(repository) || !LOGIN.test(login) || !ID.test(id) || DOTS.test(id))
    return null;
  return { repository, login, id };
}

/** Where the dashboard keeps the records it fetched: a folder that mirrors the sink's paths. Null when the sink's name is not a safe folder name. */
function cacheFolder(runDir, sinkConfig) {
  const { host, owner, name } = splitSinkRepo(sinkConfig.repo, sinkConfig.type);
  const segments = [host, owner, name].map(segmentOf);
  if (!segments.every(Boolean)) return null;
  if (sinkConfig.branch) segments.push(`@${encodeURIComponent(sinkConfig.branch)}`);
  return join(runDir, "records-cache", ...segments);
}

/** A record's text, parsed and checked again. `{record}` or `{why}`. */
function checkedRecord(text) {
  try {
    const record = JSON.parse(text);
    const problems = checkRecord(record);
    return problems.length ? { why: `fails the safe-field check (${problems[0]})` } : { record };
  } catch {
    return { why: "is not JSON" };
  }
}

/**
 * Read the configured sink: its records, through the adapter every upload
 * uses, and the paths it skipped. Reads only paths the cache does not hold.
 * A sink that cannot be read is one warning and no records.
 */
async function readSink(sinkConfig, { cache, exec }) {
  const where = sinkConfig.repo;
  const out = { read: false, found: new Map(), skipped: [], warnings: [] };
  const sink = openSink(sinkConfig.type, { repo: where, branch: sinkConfig.branch, exec });
  // The privacy check runs before anything is listed or read; a sink turned public warns, and the read goes ahead.
  const privacy = await sink.privacy();
  if (privacy.private === null) {
    out.warnings.push(
      `could not read \`${where}\`: it does not exist, you have no read access to it, or the call failed. The page is built from the local records only`,
    );
    return out;
  }
  if (!privacy.private)
    out.warnings.push(
      `\`${where}\` is not private (${privacy.visibility}): its records are read anyway, but make it private`,
    );
  const listed = await sink.list("records/");
  if (listed === null) {
    out.warnings.push(
      `could not read \`${where}\`: its file list is not readable. The page is built from the local records only`,
    );
    return out;
  }
  out.read = true;
  for (const path of listed) {
    const parsed = parseSinkPath(path);
    if (parsed === null) {
      out.skipped.push(path);
      continue;
    }
    const file = cache ? join(cache, ...path.split("/")) : null;
    let text = null;
    try {
      if (file && existsSync(file)) text = readFileSync(file, "utf8");
    } catch {
      text = null;
    }
    if (text === null) {
      const got = await sink.read(path);
      if (got.status !== "found") {
        out.warnings.push(
          `skipped ${path}: ${got.status === "missing" ? "gone from the sink" : `could not be read (${got.detail})`}`,
        );
        continue;
      }
      text = got.text;
      if (file)
        try {
          mkdirSync(dirname(file), { recursive: true });
          writeWhole(file, text);
        } catch {
          // A cache that cannot be written only costs the next build a fetch.
        }
    }
    out.found.set(path, { ...parsed, text });
  }
  return out;
}

async function dashboard(args, io) {
  let localLogs = false;
  let only = null;
  for (let n = 0; n < args.length; n += 1) {
    if (args[n] === "--local-logs" && !localLogs) localLogs = true;
    else if (args[n] === "--repo" && only === null && args[n + 1] && !args[n + 1].startsWith("--"))
      only = args[(n += 1)].toLowerCase();
    else return { code: 2, out: DASHBOARD_USAGE };
  }
  if (only !== null && !REPO.test(only)) return { code: 2, out: DASHBOARD_USAGE };
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const exec = io.exec ?? defaultExec;

  const loaded = readConfig((path) => {
    try {
      return readFileSync(resolve(cwd, path), "utf8");
    } catch {
      return null;
    }
  });
  if (loaded.problems.length) return { code: 1, out: `${loaded.problems.join("\n")}\n` };
  const { records, run_dir } = effectiveConfig(loaded.config);
  const runDir = resolve(cwd, run_dir);
  const recordsDir = join(runDir, "records");
  const current = (records.repository ?? repoOf({ ...io, exec }))?.toLowerCase() ?? null;

  // The local records, each checked again: a record edited since it was derived is skipped, never shown.
  const sink = openSink("local", { dir: recordsDir });
  const locals = [];
  const warnings = [];
  const seen = new Set();
  for (const name of await sink.list()) {
    const found = await sink.read(name);
    let checked = { why: "is not readable" };
    if (found.status === "found") {
      checked = checkedRecord(found.text);
      if (checked.record && seen.has(checked.record.run.id))
        checked = { why: "repeats a run id already shown" };
    }
    if (!checked.record) warnings.push(`skipped ${name}: ${checked.why}`);
    else {
      seen.add(checked.record.run.id);
      locals.push({ record: checked.record, text: found.text });
    }
  }

  // The configured sink, if any: one more place the same records may be.
  const configured = records.sink;
  const far = configured
    ? await readSink(configured, { cache: cacheFolder(runDir, configured), exec })
    : null;
  warnings.push(...(far?.warnings ?? []));

  const entries = [];
  const inSink = new Set();
  for (const [path, got] of far?.found ?? []) {
    const checked = checkedRecord(got.text);
    if (!checked.record) {
      warnings.push(`skipped ${path}: ${checked.why}`);
      continue;
    }
    inSink.add(path);
    entries.push({
      record: checked.record,
      repository: got.repository,
      login: got.login,
      source: "sink",
      path,
    });
  }
  for (const { record, text } of locals) {
    const repository = (records.repository ?? record.run.repo ?? current)?.toLowerCase() ?? null;
    const login = record.run.operator;
    const path = repository && login ? sinkPath(repository, login, record.run.id) : null;
    const twin = path === null ? undefined : far?.found.get(path);
    if (twin) {
      // Identical bytes are one record. When they differ the sink's copy, already added, wins.
      if (twin.text !== text)
        warnings.push(
          `\`${path}\`: the local copy and the sink's copy differ; the sink's copy is shown`,
        );
      const shown = entries.find((e) => e.path === path);
      if (shown) shown.source = "both";
      continue;
    }
    entries.push({
      record,
      repository,
      login,
      source: "local",
      ...(far?.read ? { notUploaded: true } : {}),
    });
  }
  const skipped = far?.skipped ?? [];
  const lines = [...warnings, ...skipped.map((p) => `skipped ${p}: not a Run Record path`)];
  if (entries.length === 0)
    return {
      code: 1,
      out: `${lines.map((w) => `${w}\n`).join("")}no Run Records in ${recordsDir}${configured ? ` or in \`${configured.repo}\`` : ""}: derive one at close-out (\`records.mjs derive <run-folder>\`)\n`,
    };

  const namespaces = [...new Set(entries.map((e) => e.repository).filter(Boolean))].sort();
  if (only !== null && !namespaces.includes(only))
    return {
      code: 1,
      out: `${lines.map((w) => `${w}\n`).join("")}no Run Records for \`${only}\`. Repositories with records: ${namespaces.join(", ") || "none"}\n`,
    };
  const home = only ?? (namespaces.includes(current) ? current : null);

  const { renderDashboard } = await import("./pages/dashboard.mjs");
  const script = fileURLToPath(import.meta.url);
  const shown = relative(cwd, script);
  const path = shown.startsWith("..") || isAbsolute(shown) ? script : shown;
  const node = `node ${/\s/.test(path) ? `"${path}"` : path} dashboard${only ? ` --repo ${only}` : ""}`;
  const slash = `/orchestrate --dashboard${only ? ` --repo ${only}` : ""}`;
  const builtAt = nowIso(io);
  mkdirSync(runDir, { recursive: true });
  const common = {
    vocabulary: { causes: CAUSES, stepKinds: STEP_KINDS },
    builtAt,
    warnings,
    skipped,
    home,
    sink: configured ? { name: configured.repo, read: far.read } : null,
  };

  const sharedFile = join(runDir, "dashboard.html");
  writeWhole(sharedFile, renderDashboard(entries, { ...common, rebuild: { slash, node } }));
  const links = [pathToFileURL(sharedFile).href];

  if (localLogs) {
    // Prose only for a run whose folder, with its Activity Log, is still on this machine.
    const logs = {};
    for (const { record } of locals) {
      const file = join(runDir, record.run.id, "activity.md");
      if (existsSync(file)) logs[record.run.id] = redact(readFileSync(file, "utf8"), env);
    }
    const localFile = join(runDir, "dashboard.local.html");
    writeWhole(
      localFile,
      renderDashboard(entries, {
        ...common,
        rebuild: { slash: `${slash} --local-logs`, node: `${node} --local-logs` },
        banner: "contains private prose from this machine, don't share this file",
        logs,
      }),
    );
    links.push(pathToFileURL(localFile).href);
  }

  const from = far?.read ? ` (local and \`${configured.repo}\`)` : "";
  return {
    code: 0,
    out: `${lines.map((w) => `${w}\n`).join("")}built the dashboard from ${plural(entries.length, "Run Record")}${from}${localLogs ? "; the prose is only in the .local file, which holds private prose from this machine: do not share it" : ""}\n${links.join("\n")}\n`,
  };
}

/** The real transport: a command run to the end, its output and its error text. `options.input` goes to its stdin. */
function defaultExec(command, args, options = {}) {
  try {
    const out = execFileSync(command, args, {
      encoding: "utf8",
      input: options.input,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (error) {
    return {
      code: error?.status ?? 1,
      out: String(error?.stdout ?? ""),
      err: String(error?.stderr ?? ""),
    };
  }
}

/**
 * @param {string[]} argv the arguments after the script
 * @param {{now?: () => Date, cwd?: string, env?: Record<string, string | undefined>, exec?: (command: string, args: string[], options?: {input?: string}) => {code: number, out: string, err?: string}}} [io]
 * @returns {Promise<{code: number, out: string}>}
 */
export async function main(argv, io = {}) {
  const [command, ...rest] = argv;
  if (command === "event") return appendEvent(rest, io);
  if (command === "derive") return derive(rest, io);
  if (command === "upload") return upload(rest, io);
  if (command === "prune") return prune(rest, io);
  if (command === "dashboard") return dashboard(rest, io);
  return { code: 2, out: USAGE };
}

const realOrSelf = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

if (process.argv[1] && realOrSelf(fileURLToPath(import.meta.url)) === realOrSelf(process.argv[1])) {
  const { code, out } = await main(process.argv.slice(2));
  process.stdout.write(out);
  process.exitCode = code;
}
