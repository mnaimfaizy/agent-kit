#!/usr/bin/env node
/**
 * The orchestrate records script: Run Events in, a Run Record out.
 *
 * Portable: Node built-ins and the tracker CLI only. One CLI, with
 * subcommands later tickets extend (upload, prune, dashboard, board):
 *
 *   node records.mjs event --file <events.jsonl> --kind <kind> --actor <actor> [--<field> <value>]...
 *   node records.mjs derive <run-folder>
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
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
      if (!known.has(key)) problems.push(`${join_(path, key)}: is outside the schema`);
    }
    for (const [name, [key, inner]] of known) {
      if (!Object.hasOwn(value, name)) {
        if (!key.endsWith("?")) problems.push(`${join_(path, name)}: is missing`);
        continue;
      }
      check(inner, value[name], join_(path, name), problems);
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
      if (!type.keys.includes(key)) problems.push(`${join_(path, key)}: is outside the schema`);
      else if (violates(t.int, count)) problems.push(`${join_(path, key)}: must be a whole number`);
    }
    return;
  }
  if (type.type === "nullable" && value !== null && ["object", "list"].includes(type.inner.type))
    return check(type.inner, value, path, problems);
  const reason = violates(type, value);
  if (reason) problems.push(`${path}: ${reason}`);
}

const join_ = (path, key) => (path === "" ? key : `${path}.${key}`);

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
const USAGE = `${EVENT_USAGE}${DERIVE_USAGE}`;

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
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order);
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
  const [command, args, field] =
    tracker === "gitlab" ? ["glab", ["api", "user"], "username"] : ["gh", ["api", "user"], "login"];
  const result = exec(command, args);
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.out)[field] ?? null;
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
      default:
    }
  }

  for (const s of steps)
    for (const id of s.covers)
      if (!dr.has(id)) problems.push(`covers: \`${id}\` names no \`decision-request\` event`);

  const approved = first("plan-approved");
  const byCause = {};
  for (const s of steps) byCause[s.cause] = (byCause[s.cause] ?? 0) + 1;
  const human = steps.filter((s) => s.actor === "human");
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
      human_wait_seconds: steps.reduce((sum, s) => sum + (s.waited_seconds ?? 0), 0),
    },
  };
  return { record, problems };
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
    `${built.record.delegations.length} Delegations, ${s.human_steps} human steps (${s.avoidable} avoidable, ${s.by_design} by design), ${built.record.run.open_waits} waits still open`,
    ...notes,
  ];
  return { code: 0, out: `${lines.join("\n")}\n` };
}

function defaultExec(command, args) {
  try {
    const out = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error?.status ?? 1, out: "" };
  }
}

/**
 * @param {string[]} argv the arguments after the script
 * @param {{now?: () => Date, cwd?: string, env?: Record<string, string | undefined>, exec?: (command: string, args: string[]) => {code: number, out: string}}} [io]
 * @returns {Promise<{code: number, out: string}>}
 */
export async function main(argv, io = {}) {
  const [command, ...rest] = argv;
  if (command === "event") return appendEvent(rest, io);
  if (command === "derive") return derive(rest, io);
  return { code: 2, out: USAGE };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, out } = await main(process.argv.slice(2));
  process.stdout.write(out);
  process.exitCode = code;
}
