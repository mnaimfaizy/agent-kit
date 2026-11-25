/**
 * Contract suite for the orchestrate records script. The claims under test:
 * a Run Event is appended with the clock's time and a closed set of typed
 * fields; the Run Record derived from a run's events carries the expected
 * counts, causes and durations; a record that holds free text or a field
 * outside the schema is refused with the field named, never stripped; and
 * the record is written outside the run folder. Every test goes through
 * `main(argv, io)` with an injected clock, files root and transport.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAUSES,
  EVENT_KINDS,
  STEP_KINDS,
  checkRecord,
  main,
  openSink,
  repoFromRemote,
} from "./records.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "records", "2026-11-19-spec-344");
const RUN = "2026-11-19-spec-344";
const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A temp files root holding a copy of the spec-344 run folder under `tmp/orchestrate/`. */
function root() {
  const dir = mkdtempSync(join(tmpdir(), "orchestrate-records-"));
  made.push(dir);
  cpSync(FIXTURE, join(dir, "tmp", "orchestrate", RUN), { recursive: true });
  return dir;
}
const runFolder = (dir) => join(dir, "tmp", "orchestrate", RUN);
const recordPath = (dir) => join(dir, "tmp", "orchestrate", "records", `${RUN}.json`);
const at = (iso) => () => new Date(iso);
const derive = (dir, io = {}) =>
  main(["derive", `tmp/orchestrate/${RUN}`], {
    cwd: dir,
    env: { ORCHESTRATE_OPERATOR: "naim" },
    ...io,
  });
const derived = async (dir = root(), io) => {
  const result = await derive(dir, io);
  assert.equal(result.code, 0, result.out);
  return JSON.parse(readFileSync(recordPath(dir), "utf8"));
};

describe("event: append one Run Event", () => {
  it("appends a line with the clock's time, the kind, the actor and the typed fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orchestrate-records-"));
    made.push(dir);
    const file = "tmp/orchestrate/r/delegations/d12/events.jsonl";
    const result = await main(
      [
        "event",
        "--file",
        file,
        "--kind",
        "delegation-landed",
        "--actor",
        "delegation",
        "--delegation",
        "d12",
        "--head",
        "6fc67d7",
      ],
      { cwd: dir, now: at("2026-11-25T10:00:00.500Z") },
    );
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, file), "utf8")), {
      at: "2026-11-25T10:00:00Z",
      kind: "delegation-landed",
      delegation: "d12",
      head: "6fc67d7",
      actor: "delegation",
    });
  });

  it("appends: a second event goes on a new line and the first is kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orchestrate-records-"));
    made.push(dir);
    const file = "events.jsonl";
    for (const minute of ["01", "02"])
      await main(
        [
          "event",
          "--file",
          file,
          "--kind",
          "pull-request",
          "--actor",
          "chief-of-staff",
          "--pr",
          "387",
        ],
        {
          cwd: dir,
          now: at(`2026-11-25T10:${minute}:00Z`),
        },
      );
    const lines = readFileSync(join(dir, file), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((l) => JSON.parse(l).at),
      ["2026-11-25T10:01:00Z", "2026-11-25T10:02:00Z"],
    );
  });

  const refused = [
    ["a field outside the schema", ["--kind", "pull-request", "--pr", "1", "--note", "x"], "note"],
    [
      "free text where an id belongs",
      ["--kind", "decision-request", "--id", "should the export keep the old order"],
      "id",
    ],
    ["a typed time", ["--kind", "pull-request", "--pr", "1", "--at", "2026-01-01T00:00:00Z"], "at"],
    ["a number that is not a number", ["--kind", "pull-request", "--pr", "seven"], "pr"],
    [
      "an unknown cause",
      [
        "--kind",
        "human-step",
        "--step-kind",
        "merge",
        "--cause",
        "the human was slow",
        "--how",
        "chat",
      ],
      "cause",
    ],
    ["an unknown kind", ["--kind", "lunch"], "kind"],
    ["a missing required field", ["--kind", "pull-request"], "pr"],
  ];
  for (const [name, args, field] of refused)
    it(`refuses ${name}, naming \`${field}\`, and writes nothing`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "orchestrate-records-"));
      made.push(dir);
      const result = await main(["event", "--file", "events.jsonl", "--actor", "human", ...args], {
        cwd: dir,
      });
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, new RegExp(`(^|\\n)${field}:`));
      assert.equal(existsSync(join(dir, "events.jsonl")), false);
    });

  it("refuses an event with no actor, and a file not named events.jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orchestrate-records-"));
    made.push(dir);
    const none = await main(
      ["event", "--file", "events.jsonl", "--kind", "pull-request", "--pr", "1"],
      { cwd: dir },
    );
    assert.equal(none.code, 1);
    assert.match(none.out, /actor: is missing/);
    const named = await main(
      ["event", "--file", "notes.md", "--kind", "pull-request", "--actor", "human", "--pr", "1"],
      { cwd: dir },
    );
    assert.equal(named.code, 2);
  });

  it("has one entry for each kind the prose names", () => {
    assert.deepEqual(Object.keys(EVENT_KINDS).sort(), [
      "ci",
      "decision-request",
      "delegation-ended",
      "delegation-landed",
      "delegation-started",
      "human-step",
      "plan-approved",
      "pull-request",
      "qa-result",
      "review",
      "ruling-made",
      "ruling-verdict",
      "run-closed",
      "run-opened",
      "send-back",
      "wait-closed",
      "wait-opened",
      "write",
    ]);
  });
});

describe("derive: the Run Record from a Run Event stream", () => {
  it("derives the spec-344 record with the expected run, counts and durations", async () => {
    const record = await derived();
    assert.equal(record.schema, "run-record/1");
    const { run } = record;
    assert.equal(run.id, RUN);
    assert.equal(run.repo, "github.com/mnaimfaizy/agent-kit");
    assert.equal(run.operator, "naim");
    assert.deepEqual(
      [
        run.kind,
        run.spec,
        run.team,
        run.harness,
        run.support_level,
        run.decision_authority,
        run.landing,
        run.outcome,
      ],
      [
        "spec",
        344,
        false,
        "claude-code-desktop",
        "verified",
        "autonomous",
        "integration-branch",
        "merged",
      ],
    );
    assert.deepEqual(run.tickets, [348, 349, 350, 351, 352, 353]);
    assert.deepEqual(run.pull_requests, [387]);
    assert.deepEqual(
      [run.started_at, run.plan_approved_at, run.closed_at, run.duration_seconds, run.open_waits],
      ["2026-11-19T01:44:00Z", "2026-11-19T03:08:30Z", "2026-11-19T06:27:30Z", 17010, 0],
    );
    assert.equal(Object.hasOwn(run, "team_run"), false);
    assert.deepEqual(record.rulings, { made: 0, upheld: 0, overturned: 0 });
    assert.deepEqual(
      record.reviews.map((r) => [r.round, r.findings, r.fixed]),
      [
        [1, 7, 7],
        [2, 1, 1],
        [3, 0, 0],
      ],
    );
    assert.deepEqual(
      record.ci.map((c) => c.head),
      ["75aa766", "b3609bb", "b779e0c"],
    );
    assert.equal(checkRecord(record).length, 0);
  });

  it("carries each Delegation's Executor kind, model, route and its real start and end", async () => {
    const { delegations } = await derived();
    assert.deepEqual(
      delegations.map((d) => [
        d.id,
        d.kind,
        d.executor,
        d.model,
        d.start_route,
        d.started_at,
        d.ended_at,
        d.duration_seconds,
      ]),
      [
        [
          "d344-fix1",
          "fix",
          "live-session",
          "default",
          "card",
          "2026-11-19T05:06:23Z",
          "2026-11-19T06:08:30Z",
          3727,
        ],
        [
          "d348",
          "building",
          "live-session",
          "default",
          "direct",
          "2026-11-19T03:09:50Z",
          "2026-11-19T03:15:10Z",
          320,
        ],
        [
          "d349",
          "building",
          "live-session",
          "default",
          "direct",
          "2026-11-19T03:19:40Z",
          "2026-11-19T03:26:40Z",
          420,
        ],
        [
          "d350",
          "building",
          "live-session",
          "default",
          "card",
          "2026-11-19T03:33:20Z",
          "2026-11-19T03:42:10Z",
          530,
        ],
        [
          "d351",
          "building",
          "live-session",
          "default",
          "card",
          "2026-11-19T03:49:30Z",
          "2026-11-19T03:57:30Z",
          480,
        ],
        [
          "d352",
          "building",
          "live-session",
          "default",
          "card",
          "2026-11-19T04:04:20Z",
          "2026-11-19T04:08:00Z",
          220,
        ],
        [
          "d353",
          "building",
          "live-session",
          "default",
          "card",
          "2026-11-19T04:23:50Z",
          "2026-11-19T04:29:20Z",
          330,
        ],
      ].sort((a, b) => (a[5] < b[5] ? -1 : 1)),
    );
    const fix = delegations.find((d) => d.id === "d344-fix1");
    assert.deepEqual(
      [fix.send_backs, fix.landed_at, fix.outcome],
      [1, "2026-11-19T05:23:04Z", "landed"],
    );
  });

  it("counts one human step per touch, each with its cause, avoidability, wait and covered Decision Requests", async () => {
    const record = await derived();
    assert.deepEqual(record.summary, {
      human_steps: 13,
      avoidable: 9,
      by_design: 4,
      by_cause: {
        "by-design": 4,
        "harness-limit": 5,
        "missing-config": 1,
        "spec-gap": 1,
        "permission-refusal": 2,
      },
      human_wait_seconds: 6791,
    });
    const steps = record.human_steps;
    assert.deepEqual(
      steps.map((s) => s.kind),
      [
        "plan-approval",
        "card-start",
        "card-start",
        "card-start",
        "card-start",
        "decision-request",
        "decision-request",
        "card-start",
        "post-replies",
        "post-replies",
        "merge",
        "close-out",
        "close-out",
      ],
    );
    const batch = steps.find((s) => s.wait_id === "w7");
    assert.deepEqual(
      [batch.covers, batch.waited_seconds, batch.cause, batch.avoidable],
      [["dr3", "dr4", "dr5"], 1090, "spec-gap", true],
    );
    const card = steps.find((s) => s.wait_id === "w5");
    assert.deepEqual(
      [card.delegation, card.cause, card.how, card.card, card.waited_seconds, card.actor],
      ["d353", "harness-limit", "card", "task_e0243937", 920, "human"],
    );
    const plan = steps[0];
    assert.deepEqual(
      [plan.delegation, plan.cause, plan.avoidable, plan.how],
      [null, "by-design", false, "chat"],
    );
    const closeOut = steps.at(-1);
    assert.deepEqual([closeOut.wait_id, closeOut.waited_seconds], [null, null]);
  });

  it("records every write with its actor, so a write made with the human's login is not the human's", async () => {
    const { writes } = await derived();
    assert.equal(writes.length, 5);
    assert.ok(writes.every((w) => w.actor === "chief-of-staff" && w.as_human === true));
  });

  it("writes the record outside the run folder, and deleting the folder leaves it", async () => {
    const dir = root();
    const record = await derived(dir);
    const path = recordPath(dir);
    assert.equal(path.startsWith(`${runFolder(dir)}/`), false);
    assert.deepEqual(readdirSync(join(dir, "tmp", "orchestrate", "records")), [`${RUN}.json`]);
    rmSync(runFolder(dir), { recursive: true });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), record);
  });

  it("derives the same record twice", async () => {
    const dir = root();
    await derived(dir);
    const one = readFileSync(recordPath(dir), "utf8");
    await derived(dir);
    assert.equal(readFileSync(recordPath(dir), "utf8"), one);
  });
});

describe("derive: who the operator is", () => {
  const noEnv = { env: {} };
  const exec = (log, answers) => (command, args) => {
    log.push([command, ...args].join(" "));
    return answers[command] ?? { code: 1, out: "" };
  };

  it("is the `gh api user` login on GitHub", async () => {
    const log = [];
    const record = await derived(root(), {
      ...noEnv,
      exec: exec(log, { gh: { code: 0, out: '{"login":"sam"}' } }),
    });
    assert.equal(record.run.operator, "sam");
    assert.deepEqual(log, ["gh api user"]);
  });

  it("is the `glab api user` username on GitLab", async () => {
    const dir = root();
    const file = join(runFolder(dir), "events.jsonl");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('"tracker":"github"', '"tracker":"gitlab"'),
    );
    const log = [];
    const record = await derived(dir, {
      ...noEnv,
      exec: exec(log, { glab: { code: 0, out: '{"username":"kim"}' } }),
    });
    assert.equal(record.run.operator, "kim");
    assert.deepEqual(log, ["glab api user"]);
  });

  it("is ORCHESTRATE_OPERATOR when set, and the tracker CLI is not asked", async () => {
    const log = [];
    const record = await derived(root(), {
      env: { ORCHESTRATE_OPERATOR: "lee" },
      exec: exec(log, {}),
    });
    assert.equal(record.run.operator, "lee");
    assert.deepEqual(log, []);
  });

  it("is null, with a note, when there is no login: the record is kept, and nothing could be uploaded", async () => {
    const dir = root();
    const result = await derive(dir, { ...noEnv, exec: exec([], {}) });
    assert.equal(result.code, 0);
    assert.match(result.out, /run\.operator is null/);
    assert.equal(JSON.parse(readFileSync(recordPath(dir), "utf8")).run.operator, null);
  });

  it("is never taken from any other environment variable", async () => {
    const record = await derived(root(), {
      env: { USER: "root", LOGNAME: "root", GITHUB_ACTOR: "bot" },
      exec: exec([], { gh: { code: 0, out: '{"login":"sam"}' } }),
    });
    assert.equal(record.run.operator, "sam");
  });

  it("names the repository from the origin remote when the run did not", async () => {
    const dir = root();
    const file = join(runFolder(dir), "events.jsonl");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('"repo":"github.com/mnaimfaizy/agent-kit",', ""),
    );
    const git = (command, args) =>
      args.includes("get-url")
        ? { code: 0, out: "git@GitHub.com:Acme/Widgets.git\n" }
        : { code: 0, out: "upstream\norigin\n" };
    const record = await derived(dir, { exec: git });
    assert.equal(record.run.repo, "github.com/acme/widgets");
  });

  it("reads host/owner/repo from https, ssh and scp-style remotes", () => {
    assert.equal(repoFromRemote("https://github.com/Acme/Widgets.git"), "github.com/acme/widgets");
    assert.equal(
      repoFromRemote("ssh://git@ghe.example.com:2222/acme/widgets"),
      "ghe.example.com/acme/widgets",
    );
    assert.equal(
      repoFromRemote("git@gitlab.com:group/sub/widgets.git"),
      "gitlab.com/group/sub/widgets",
    );
    assert.equal(repoFromRemote("nonsense"), null);
  });
});

describe("derive: Team Runs, takeovers and waits on a teammate", () => {
  it("carries team, spec and took_over, with no run.team_run", async () => {
    const dir = root();
    const file = join(runFolder(dir), "events.jsonl");
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replace('"run_kind":"spec"', '"run_kind":"team"')
        .replace('"team":false', '"team":true,"took_over":["2026-11-18-spec-344"]'),
    );
    const { run } = await derived(dir);
    assert.deepEqual(
      [run.kind, run.spec, run.team, run.took_over],
      ["team", 344, true, ["2026-11-18-spec-344"]],
    );
    assert.equal(Object.hasOwn(run, "team_run"), false);
  });

  it("records a ticket parked on a teammate's ticket as a by-design wait with the blocker's id and login", async () => {
    const dir = root();
    const file = join(runFolder(dir), "events.jsonl");
    const args = (more) => [
      "event",
      "--file",
      `tmp/orchestrate/${RUN}/events.jsonl`,
      "--actor",
      "chief-of-staff",
      ...more,
    ];
    await main(
      args([
        "--kind",
        "wait-opened",
        "--wait-id",
        "w20",
        "--delegation",
        "d353",
        "--step-kind",
        "teammate-blocker",
        "--cause",
        "teammate-blocker",
        "--how",
        "github",
        "--blocker",
        "355",
        "--blocker-login",
        "sam",
      ]),
      { cwd: dir, now: at("2026-11-19T06:20:00Z") },
    );
    await main(args(["--kind", "wait-closed", "--wait-id", "w20"]), {
      cwd: dir,
      now: at("2026-11-19T06:25:00Z"),
    });
    const record = await derived(dir);
    const step = record.human_steps.find((s) => s.wait_id === "w20");
    assert.deepEqual(
      [
        step.cause,
        step.avoidable,
        step.blocker,
        step.blocker_login,
        step.waited_seconds,
        step.actor,
      ],
      ["teammate-blocker", false, 355, "sam", 300, "chief-of-staff"],
    );
    assert.equal(record.summary.human_steps, 13, "a wait on a teammate is not a human step");
  });

  it("counts a wait still open at close-out, and does not make it a step", async () => {
    const dir = root();
    await main(
      [
        "event",
        "--file",
        `tmp/orchestrate/${RUN}/events.jsonl`,
        "--kind",
        "wait-opened",
        "--actor",
        "chief-of-staff",
        "--wait-id",
        "w30",
        "--step-kind",
        "merge",
        "--cause",
        "by-design",
        "--how",
        "github",
      ],
      { cwd: dir, now: at("2026-11-19T06:20:00Z") },
    );
    const record = await derived(dir);
    assert.equal(record.run.open_waits, 1);
    assert.equal(
      record.human_steps.some((s) => s.wait_id === "w30"),
      false,
    );
  });
});

describe("derive: waits and Rulings as Run Events", () => {
  /** Append one event to the Chief of Staff's events file at a clock time. */
  const emit = (dir, time, more, actor = "chief-of-staff") =>
    main(["event", "--file", `tmp/orchestrate/${RUN}/events.jsonl`, "--actor", actor, ...more], {
      cwd: dir,
      now: at(time),
    });
  const wait = (id, extra) => ["--kind", "wait-opened", "--wait-id", id, ...extra];

  it("derives a run-level wait with delegation null, its how and its waited seconds", async () => {
    const dir = root();
    await emit(
      dir,
      "2026-11-19T06:10:00Z",
      wait("w40", ["--step-kind", "review-label", "--cause", "by-design", "--how", "github"]),
    );
    await emit(dir, "2026-11-19T06:12:30Z", ["--kind", "wait-closed", "--wait-id", "w40"], "human");
    const step = (await derived(dir)).human_steps.find((s) => s.wait_id === "w40");
    assert.deepEqual(
      [step.delegation, step.kind, step.how, step.waited_seconds, step.actor, step.avoidable],
      [null, "review-label", "github", 150, "human", false],
    );
  });

  it("derives a refused card start as a harness-limit wait with the card's id, avoidable", async () => {
    const dir = root();
    const step = (await derived(dir)).human_steps.find((s) => s.wait_id === "w2");
    assert.deepEqual(
      [step.cause, step.how, step.card, step.avoidable, step.delegation],
      ["harness-limit", "card", "task_184e1773", true, "d350"],
    );
  });

  it("refuses a harness-limit wait that names no card", async () => {
    const dir = root();
    await emit(
      dir,
      "2026-11-19T06:10:00Z",
      wait("w41", ["--step-kind", "card-start", "--cause", "harness-limit", "--how", "card"]),
    );
    await emit(dir, "2026-11-19T06:11:00Z", ["--kind", "wait-closed", "--wait-id", "w41"], "human");
    const result = await derive(dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /human_steps: a `harness-limit` step must name its `card`/);
    assert.equal(existsSync(recordPath(dir)), false);
  });

  it("refuses an open harness-limit wait that names no card, though it never becomes a step", async () => {
    const dir = root();
    await emit(
      dir,
      "2026-11-19T06:10:00Z",
      wait("w45", ["--step-kind", "card-start", "--cause", "harness-limit", "--how", "card"]),
    );
    const result = await derive(dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /a `harness-limit` step must name its `card`/);
  });

  it("refuses a teammate-blocker wait with no blocker ticket or login, or on another step kind", async () => {
    const dir = root();
    await emit(
      dir,
      "2026-11-19T06:10:00Z",
      wait("w42", ["--step-kind", "other", "--cause", "teammate-blocker", "--how", "github"]),
    );
    await emit(dir, "2026-11-19T06:11:00Z", ["--kind", "wait-closed", "--wait-id", "w42"]);
    const result = await derive(dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /a `teammate-blocker` step must have step kind `teammate-blocker`/);
    assert.match(
      result.out,
      /a `teammate-blocker` step must name its `blocker` ticket and `blocker_login`/,
    );
  });

  it("never counts a by-design cause as avoidable", async () => {
    const record = await derived();
    for (const s of record.human_steps) assert.equal(s.avoidable, CAUSES[s.cause] === "avoidable");
    assert.equal(record.summary.avoidable + record.summary.by_design, record.summary.human_steps);
  });

  it("derives the Rulings counts from ruling-made and ruling-verdict, and each Delegation's own", async () => {
    const dir = root();
    for (const [n, who] of [
      ["R1", "d350"],
      ["R2", "d350"],
      ["R3", "d351"],
    ])
      await emit(dir, "2026-11-19T06:00:00Z", [
        "--kind",
        "ruling-made",
        "--delegation",
        who,
        "--ruling",
        n,
      ]);
    await emit(
      dir,
      "2026-11-19T06:05:00Z",
      ["--kind", "ruling-verdict", "--ruling", "R1", "--verdict", "upheld"],
      "human",
    );
    await emit(
      dir,
      "2026-11-19T06:05:00Z",
      ["--kind", "ruling-verdict", "--ruling", "R2", "--verdict", "overturned"],
      "human",
    );
    const record = await derived(dir);
    assert.deepEqual(record.rulings, { made: 3, upheld: 1, overturned: 1 });
    assert.deepEqual(
      record.delegations.filter((d) => d.rulings).map((d) => [d.id, d.rulings]),
      [
        ["d350", 2],
        ["d351", 1],
      ],
    );
  });

  it("refuses a verdict for a Ruling nobody made", async () => {
    const dir = root();
    await emit(
      dir,
      "2026-11-19T06:05:00Z",
      ["--kind", "ruling-verdict", "--ruling", "R9", "--verdict", "upheld"],
      "human",
    );
    const result = await derive(dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /ruling-verdict: `R9` has no `ruling-made` event before it/);
  });

  it("reports each wait still open at close-out by id and step kind", async () => {
    const dir = root();
    await emit(
      dir,
      "2026-11-19T06:20:00Z",
      wait("w43", ["--step-kind", "merge", "--cause", "by-design", "--how", "github"]),
    );
    const result = await derive(dir);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /1 waits still open: w43 \(merge\)/);
  });

  it("refuses prose in every new field, naming it", async () => {
    const dir = root();
    for (const [field, kind, extra] of [
      [
        "blocker-login",
        "wait-opened",
        [
          "--wait-id",
          "w44",
          "--step-kind",
          "teammate-blocker",
          "--cause",
          "teammate-blocker",
          "--how",
          "github",
          "--blocker",
          "355",
        ],
      ],
      [
        "card",
        "wait-opened",
        [
          "--wait-id",
          "w44",
          "--step-kind",
          "card-start",
          "--cause",
          "harness-limit",
          "--how",
          "card",
        ],
      ],
      ["ruling", "ruling-made", ["--delegation", "d350"]],
    ]) {
      const result = await emit(dir, "2026-11-19T06:20:00Z", [
        "--kind",
        kind,
        ...extra,
        `--${field}`,
        "please start this card now",
      ]);
      assert.equal(result.code, 1, field);
      assert.match(result.out, new RegExp(field.replaceAll("-", "_")));
    }
  });
});

describe("derive: ordering, summary and by-design steps", () => {
  it("puts a Delegation's start before a Chief of Staff event of the same second that names it", async () => {
    const dir = root();
    const stamp = "2026-11-19T06:20:00Z";
    appendFileSync(
      join(runFolder(dir), "events.jsonl"),
      `${JSON.stringify({ at: stamp, kind: "send-back", actor: "chief-of-staff", delegation: "d777" })}\n`,
    );
    mkdirSync(join(runFolder(dir), "delegations", "d777"), { recursive: true });
    writeFileSync(
      join(runFolder(dir), "delegations", "d777", "events.jsonl"),
      `${JSON.stringify({ at: stamp, kind: "delegation-started", actor: "delegation", delegation: "d777", delegation_kind: "fix", executor: "headless", model: "default", start_route: "direct" })}\n`,
    );
    const record = await derived(dir);
    assert.equal(record.delegations.find((d) => d.id === "d777").send_backs, 1);
  });

  it("counts only human steps in the totals, so a wait on a teammate is not in by_cause", async () => {
    const dir = root();
    const a = [
      "event",
      "--file",
      `tmp/orchestrate/${RUN}/events.jsonl`,
      "--actor",
      "chief-of-staff",
    ];
    await main(
      [
        ...a,
        "--kind",
        "wait-opened",
        "--wait-id",
        "w20",
        "--step-kind",
        "teammate-blocker",
        "--cause",
        "teammate-blocker",
        "--how",
        "github",
        "--blocker",
        "355",
        "--blocker-login",
        "sam",
      ],
      { cwd: dir, now: at("2026-11-19T06:20:00Z") },
    );
    await main([...a, "--kind", "wait-closed", "--wait-id", "w20"], {
      cwd: dir,
      now: at("2026-11-19T06:25:00Z"),
    });
    const { summary } = await derived(dir);
    assert.equal(summary.by_cause["teammate-blocker"], undefined);
    assert.equal(summary.human_wait_seconds, 6791);
  });

  it("refuses a plan-approval or close-out step whose cause is not by-design", async () => {
    const dir = root();
    const file = join(runFolder(dir), "events.jsonl");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        '"step_kind":"plan-approval","cause":"by-design"',
        '"step_kind":"plan-approval","cause":"human-choice"',
      ),
    );
    const result = await derive(dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /a `plan-approval` step must have cause `by-design`/);
  });

  it("is null for a login that is not a login, rather than failing the derive", async () => {
    const record = await derived(root(), {
      env: {},
      exec: () => ({ code: 0, out: '{"login":"not a login!"}' }),
    });
    assert.equal(record.run.operator, null);
  });
});

describe("derive: the cause list", () => {
  it("marks each cause avoidable or by design, and only by-design and teammate-blocker are by design", () => {
    assert.deepEqual(
      Object.entries(CAUSES)
        .filter(([, v]) => v === "by-design")
        .map(([k]) => k)
        .sort(),
      ["by-design", "teammate-blocker"],
    );
    assert.ok(Object.values(CAUSES).every((v) => v === "avoidable" || v === "by-design"));
    for (const cause of [
      "harness-limit",
      "permission-refusal",
      "tool-missing",
      "skill-bug",
      "spec-gap",
      "missing-config",
      "human-choice",
    ])
      assert.equal(CAUSES[cause], "avoidable");
  });

  it("groups QA step kinds under a `qa-` prefix and folds the rare ones into `other`", () => {
    assert.ok(STEP_KINDS.includes("other"));
    assert.ok(STEP_KINDS.filter((k) => k.startsWith("qa-")).length >= 4);
  });
});

describe("the safe-field check", () => {
  const good = async () => derived();

  it("refuses a free-text field, naming it, and never strips it", async () => {
    const record = await good();
    record.human_steps[2].reason = "the harness refused to start the session";
    const problems = checkRecord(record);
    assert.deepEqual(problems, ["human_steps[2].reason: is outside the schema"]);
    assert.equal(Object.hasOwn(record.human_steps[2], "reason"), true);
  });

  it("refuses prose in a field the schema does hold, naming the field and not repeating the prose", async () => {
    const record = await good();
    record.run.harness = "Claude Code on my laptop";
    record.delegations[0].model = "the big one";
    const problems = checkRecord(record);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^run\.harness: .*free text/);
    assert.match(problems[1], /^delegations\[0\]\.model: /);
    assert.ok(problems.every((p) => !p.includes("laptop") && !p.includes("big one")));
  });

  it("refuses a field outside the schema at the top, in a list item and in a count", async () => {
    const record = await good();
    record.title = "Write Run Events";
    record.reviews[0].comment = "rename this";
    record.summary.by_cause.vibes = 1;
    record.run.team_run = true;
    assert.deepEqual(checkRecord(record).sort(), [
      "reviews[0].comment: is outside the schema",
      "run.team_run: is outside the schema",
      "summary.by_cause.vibes: is outside the schema",
      "title: is outside the schema",
    ]);
  });

  it("refuses a missing field and a wrong type", async () => {
    const record = await good();
    delete record.run.outcome;
    record.run.tickets = "348";
    assert.deepEqual(checkRecord(record).sort(), [
      "run.outcome: is missing",
      "run.tickets: must be a list",
    ]);
  });

  it("derive refuses a hand-edited event line that carries prose, names the line, and writes no record", async () => {
    const dir = root();
    const file = join(runFolder(dir), "delegations", "d348", "events.jsonl");
    appendFileSync(
      file,
      `${JSON.stringify({ at: "2026-11-19T03:16:00Z", kind: "send-back", actor: "chief-of-staff", delegation: "d348", why: "tests were thin" })}\n`,
    );
    const result = await derive(dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /delegations\/d348\/events\.jsonl:4: why: is outside the schema/);
    assert.equal(existsSync(recordPath(dir)), false);
  });

  it("derive refuses an event whose id field holds a sentence", async () => {
    const dir = root();
    const file = join(runFolder(dir), "events.jsonl");
    appendFileSync(
      file,
      `${JSON.stringify({ at: "2026-11-19T06:27:31Z", kind: "decision-request", actor: "chief-of-staff", id: "should we merge this" })}\n`,
    );
    const result = await derive(dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /events\.jsonl:\d+: id: must be an id/);
  });
});

describe("derive: events that do not add up", () => {
  const without = (dir, pattern) => {
    const file = join(runFolder(dir), "events.jsonl");
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !pattern.test(l))
        .join("\n") + "\n",
    );
  };

  it("refuses a run with no run-closed event", async () => {
    const dir = root();
    without(dir, /run-closed/);
    const result = await derive(dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /no `run-closed` event/);
  });

  it("refuses a wait closed that was never opened", async () => {
    const dir = root();
    without(dir, /"wait_id":"w3".*wait-opened|wait-opened.*"wait_id":"w3"/);
    const result = await derive(dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /wait-closed: `w3` has no `wait-opened` event/);
  });

  it("refuses a step that covers a Decision Request nobody raised", async () => {
    const dir = root();
    without(dir, /"id":"dr6"/);
    const result = await derive(dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /covers: `dr6` names no `decision-request` event/);
  });

  it("refuses an event for a Delegation that never started", async () => {
    const dir = root();
    without(dir, /^$/);
    appendFileSync(
      join(runFolder(dir), "events.jsonl"),
      `${JSON.stringify({ at: "2026-11-19T06:27:29Z", kind: "send-back", actor: "chief-of-staff", delegation: "d999" })}\n`,
    );
    const result = await derive(dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /`d999` has no `delegation-started` event/);
  });
});

// ── Upload ──────────────────────────────────────────────────────────────────

const SINK_CONFIG = [
  "records:",
  "  sink:",
  "    type: github",
  "    repo: acme/run-records",
  "",
].join("\n");
const SINK_PATH = `records/github.com/mnaimfaizy/agent-kit/naim/${RUN}.json`;

/**
 * A fake `gh` and `git`: the private repositories it holds and every call it
 * was given. Nothing here touches the network. `repos` maps `owner/name` (or
 * `host/owner/name`) to its visibility, collaborators and files.
 */
function fakeTransport({ repos = {}, remotes = {}, conflicts = 0 } = {}) {
  const calls = [];
  const state = {
    calls,
    conflicts,
    repos: Object.fromEntries(
      Object.entries({
        "acme/run-records": {},
        ...repos,
      }).map(([name, repo]) => [
        name,
        {
          visibility: "private",
          collaborators: ["a", "b", "c", "d"],
          files: new Map(),
          ...repo,
        },
      ]),
    ),
    puts: () => calls.filter((c) => c.args.includes("PUT")),
    contents: () => calls.filter((c) => c.args.some((a) => /\/contents\//.test(a))),
  };
  const missing = {
    code: 1,
    out: '{"message":"Not Found","status":"404"}',
    err: "gh: Not Found (HTTP 404)",
  };
  state.exec = (command, args, options = {}) => {
    calls.push({ command, args, input: options.input });
    if (command === "git") {
      const sub = args.slice(2);
      if (sub[0] === "remote" && sub[1] === "get-url") {
        const url = remotes[sub[2]];
        return url ? { code: 0, out: `${url}\n` } : { code: 2, out: "" };
      }
      if (sub[0] === "remote") return { code: 0, out: `${Object.keys(remotes).join("\n")}\n` };
    }
    if (command !== "gh" || args[0] !== "api") return { code: 127, out: "" };
    const host = args.includes("--hostname") ? args[args.indexOf("--hostname") + 1] : "github.com";
    const endpoint = args.find((a) => /^repos\//.test(a));
    const [, owner, name, ...rest] = endpoint.split("?")[0].split("/");
    const key = host === "github.com" ? `${owner}/${name}` : `${host}/${owner}/${name}`;
    const repo = state.repos[key];
    if (!repo) return missing;
    const kind = rest[0];
    if (kind === undefined) return { code: 0, out: `${repo.visibility}\n` };
    if (kind === "collaborators")
      return repo.collaborators
        ? { code: 0, out: repo.collaborators.map((l) => `${l}\n`).join("") }
        : { code: 1, out: "", err: "gh: Must have push access (HTTP 403)" };
    if (kind === "git" && rest[1] === "trees") {
      const paths = [...repo.files.keys()];
      if (endpoint.includes("recursive=1")) {
        const tree = paths.map((path) => ({ path, type: "blob" }));
        return repo.truncate
          ? { code: 0, out: JSON.stringify({ tree: [], truncated: true }) }
          : { code: 0, out: JSON.stringify({ tree, truncated: false }) };
      }
      // One level: `sha` is the folder's path, and HEAD is the root.
      const sha = rest.slice(2).join("/").split("?")[0];
      const prefix = sha === "HEAD" ? "" : `${sha}/`;
      const level = new Map();
      for (const path of paths.filter((p) => p.startsWith(prefix))) {
        const [head, ...more] = path.slice(prefix.length).split("/");
        level.set(
          head,
          more.length
            ? { path: head, type: "tree", sha: `${prefix}${head}` }
            : { path: head, type: "blob" },
        );
      }
      return { code: 0, out: JSON.stringify({ tree: [...level.values()], truncated: false }) };
    }
    if (kind !== "contents") return missing;
    const path = decodeURIComponent(rest.slice(1).join("/"));
    if (args.includes("PUT")) {
      if (state.conflicts > 0) {
        state.conflicts -= 1;
        return { code: 1, out: "", err: "gh: is at abc but expected def (HTTP 409)" };
      }
      if (repo.files.has(path)) return { code: 1, out: "", err: "gh: Invalid request (HTTP 422)" };
      const body = JSON.parse(options.input);
      repo.files.set(path, Buffer.from(body.content, "base64").toString("utf8"));
      repo.lastPut = body;
      return { code: 0, out: "{}" };
    }
    return repo.files.has(path) ? { code: 0, out: repo.files.get(path) } : missing;
  };
  return state;
}

/** The dir with a derived record and the sink config; `extra` lines are added to `records:`. */
async function readyToUpload({ config = SINK_CONFIG, operator = "naim", edit } = {}) {
  const dir = root();
  writeFileSync(join(dir, "orchestrate.config.yml"), config);
  const result = await derive(dir, operator ? {} : { env: {}, exec: () => ({ code: 1, out: "" }) });
  assert.equal(result.code, 0, result.out);
  if (edit) {
    const file = recordPath(dir);
    writeFileSync(file, edit(readFileSync(file, "utf8")));
  }
  return dir;
}
const upload = (dir, transport, args = [RUN, "--yes"], env = {}) =>
  main(["upload", ...args], { cwd: dir, env, exec: transport.exec });

describe("upload: the disclosure", () => {
  it("shows the approved wording, with the access count, and uploads nothing without a yes", async () => {
    const dir = await readyToUpload();
    const transport = fakeTransport();
    const result = await upload(dir, transport, [RUN]);
    assert.equal(result.code, 0, result.out);
    assert.match(
      result.out,
      new RegExp(
        "\\*\\*Upload this run's Run Record\\?\\*\\* To `acme/run-records` \\(private GitHub repository, 4 people with access\\) at `" +
          SINK_PATH.replaceAll(".", "\\.") +
          "`\\. It holds counts, ids, times, outcomes and 13 human steps with their kind and cause: no issue text, no command output, no prose\\. It is kept indefinitely \\(git cannot expire it\\)\\. \\[Show the record\\] \\[Upload\\] \\[Not now\\]",
      ),
    );
    assert.equal(transport.puts().length, 0);
    assert.equal(transport.repos["acme/run-records"].files.size, 0);
  });

  it("leaves the access count out when the sink cannot be read for it", async () => {
    const dir = await readyToUpload();
    const transport = fakeTransport({ repos: { "acme/run-records": { collaborators: null } } });
    const result = await upload(dir, transport, [RUN]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /\(private GitHub repository\) at `records\//);
    assert.doesNotMatch(result.out, /with access/);
  });

  it("says one person, not one people", async () => {
    const dir = await readyToUpload();
    const transport = fakeTransport({ repos: { "acme/run-records": { collaborators: ["naim"] } } });
    assert.match((await upload(dir, transport, [RUN])).out, /1 person with access/);
  });

  it("is shown before an upload too, so the human is never surprised", async () => {
    const dir = await readyToUpload();
    const result = await upload(dir, fakeTransport());
    assert.match(result.out, /^\*\*Upload this run's Run Record\?\*\*/);
    assert.match(result.out, /\nuploaded `records\//);
  });
});

describe("upload: create-only writes to a github sink", () => {
  it("creates the record at its namespaced path with the record's exact bytes", async () => {
    const dir = await readyToUpload();
    const transport = fakeTransport();
    const result = await upload(dir, transport);
    assert.equal(result.code, 0, result.out);
    assert.match(
      result.out,
      new RegExp(`uploaded \`${SINK_PATH.replaceAll(".", "\\.")}\` to \`acme/run-records\``),
    );
    assert.equal(
      transport.repos["acme/run-records"].files.get(SINK_PATH),
      readFileSync(recordPath(dir), "utf8"),
    );
    const [put] = transport.puts();
    assert.deepEqual(put.args.slice(0, 3), ["api", "-X", "PUT"]);
    assert.ok(put.args.includes(`repos/acme/run-records/contents/${SINK_PATH}`));
    assert.equal(transport.repos["acme/run-records"].lastPut.sha, undefined, "create-only: no sha");
  });

  it("counts identical bytes already there as uploaded, and repeating is safe", async () => {
    const dir = await readyToUpload();
    const transport = fakeTransport();
    assert.equal((await upload(dir, transport)).code, 0);
    const again = await upload(dir, transport);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /already uploaded/);
    assert.equal(transport.puts().length, 1);
  });

  it("stops when different bytes are already at the path, and overwrites nothing", async () => {
    const dir = await readyToUpload();
    const transport = fakeTransport({
      repos: { "acme/run-records": { files: new Map([[SINK_PATH, '{"someone":"else"}']]) } },
    });
    const result = await upload(dir, transport);
    assert.equal(result.code, 1);
    assert.match(result.out, /different bytes are already at `records\//);
    assert.equal(transport.puts().length, 0);
    assert.equal(transport.repos["acme/run-records"].files.get(SINK_PATH), '{"someone":"else"}');
  });

  it("retries a 409 from parallel Contents writes", async () => {
    const dir = await readyToUpload();
    const transport = fakeTransport({ conflicts: 2 });
    const result = await upload(dir, transport);
    assert.equal(result.code, 0, result.out);
    assert.equal(transport.puts().length, 3);
    assert.ok(transport.repos["acme/run-records"].files.has(SINK_PATH));
  });

  it("gives up, saying so, when every try is a 409", async () => {
    const dir = await readyToUpload();
    const transport = fakeTransport({ conflicts: 99 });
    const result = await upload(dir, transport);
    assert.equal(result.code, 1);
    assert.match(result.out, /409/);
    assert.equal(transport.repos["acme/run-records"].files.size, 0);
  });

  it("counts a record another writer created between the read and the write as uploaded when identical", async () => {
    const dir = await readyToUpload();
    const transport = fakeTransport({ conflicts: 1 });
    const bytes = readFileSync(recordPath(dir), "utf8");
    const exec = transport.exec;
    transport.exec = (command, args, options) => {
      const result = exec(command, args, options);
      if (args.includes("PUT") && result.code !== 0)
        transport.repos["acme/run-records"].files.set(SINK_PATH, bytes);
      return result;
    };
    const result = await main(["upload", RUN, "--yes"], {
      cwd: dir,
      env: {},
      exec: transport.exec,
    });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /already uploaded/);
  });

  it("writes to the configured branch, and reads from it", async () => {
    const dir = await readyToUpload({ config: `${SINK_CONFIG}    branch: records\n` });
    const transport = fakeTransport();
    assert.equal((await upload(dir, transport)).code, 0);
    assert.equal(transport.repos["acme/run-records"].lastPut.branch, "records");
    assert.ok(
      transport
        .contents()
        .every((c) => c.args.some((a) => a.includes("ref=records") || a === "PUT")),
    );
  });

  it("uses the sink's own host for host/owner/name", async () => {
    const dir = await readyToUpload({
      config: SINK_CONFIG.replace("acme/run-records", "ghe.acme.dev/acme/run-records"),
    });
    const transport = fakeTransport({ repos: { "ghe.acme.dev/acme/run-records": {} } });
    const result = await upload(dir, transport);
    assert.equal(result.code, 0, result.out);
    assert.ok(transport.calls.every((c) => c.command !== "gh" || c.args.includes("ghe.acme.dev")));
    assert.ok(transport.repos["ghe.acme.dev/acme/run-records"].files.has(SINK_PATH));
  });
});

describe("upload: never to a public repository", () => {
  for (const visibility of ["public", "internal"])
    it(`refuses a ${visibility} repository, with no override, before any read or write`, async () => {
      const dir = await readyToUpload();
      const transport = fakeTransport({ repos: { "acme/run-records": { visibility } } });
      for (const args of [[RUN], [RUN, "--yes"]]) {
        const result = await upload(dir, transport, args);
        assert.notEqual(result.code, 0);
        assert.doesNotMatch(result.out, /Upload this run's Run Record\?/);
        assert.match(result.out, /is not private/);
      }
      assert.equal(transport.contents().length, 0);
      // There is no flag that lifts it.
      assert.equal((await upload(dir, transport, [RUN, "--yes", "--force"])).code, 2);
      assert.equal(transport.contents().length, 0);
    });

  it("refuses when the visibility cannot be read, since it cannot be shown private", async () => {
    const dir = await readyToUpload();
    const transport = fakeTransport();
    delete transport.repos["acme/run-records"];
    const result = await upload(dir, transport);
    assert.equal(result.code, 1);
    assert.match(result.out, /cannot read whether `acme\/run-records` is private/);
    assert.equal(transport.contents().length, 0);
  });
});

describe("upload: the namespace and the login", () => {
  it("uploads nothing with no login, and makes no call", async () => {
    const dir = await readyToUpload({ operator: null });
    const transport = fakeTransport();
    const result = await upload(dir, transport);
    assert.equal(result.code, 1);
    assert.match(result.out, /no tracker login/);
    assert.equal(transport.calls.length, 0);
  });

  it("lowercases every segment, and `records.repository` pins the repository", async () => {
    const dir = await readyToUpload({
      config: `records:\n  repository: GitHub.com/Acme/Widgets\n  sink:\n    type: github\n    repo: acme/run-records\n`,
      operator: null,
    });
    // The record names its operator as written; the path is lowercased.
    const file = recordPath(dir);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('"operator": null', '"operator": "Naim"'),
    );
    const transport = fakeTransport();
    const result = await upload(dir, transport);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(
      [...transport.repos["acme/run-records"].files.keys()],
      [`records/github.com/acme/widgets/naim/${RUN}.json`],
    );
  });

  it("reads the repository from the origin remote when the record names none", async () => {
    const dir = await readyToUpload({
      edit: (text) => text.replace(/"repo": "[^"]+"/, '"repo": null'),
    });
    const transport = fakeTransport({
      remotes: { origin: "git@github.com:Acme/Widgets.git", fork: "https://github.com/me/widgets" },
    });
    const result = await upload(dir, transport);
    assert.equal(result.code, 0, result.out);
    assert.ok(
      transport.repos["acme/run-records"].files.has(
        `records/github.com/acme/widgets/naim/${RUN}.json`,
      ),
    );
  });

  it("asks, rather than guess, with several remotes and none named origin", async () => {
    const dir = await readyToUpload({
      edit: (text) => text.replace(/"repo": "[^"]+"/, '"repo": null'),
    });
    const transport = fakeTransport({
      remotes: { upstream: "https://github.com/a/b", fork: "https://github.com/me/b" },
    });
    const result = await upload(dir, transport);
    assert.equal(result.code, 3);
    assert.match(result.out, /several remotes and none is `origin`/);
    assert.equal(transport.contents().length, 0);
  });
});

describe("upload: when there is nothing to upload", () => {
  it("a run with no `records` keys behaves as today: the local record only, no call", async () => {
    const dir = await readyToUpload({ config: "run_dir: tmp/orchestrate\n" });
    const transport = fakeTransport();
    const result = await upload(dir, transport);
    assert.equal(result.code, 1);
    assert.match(result.out, /no `records\.sink`/);
    assert.equal(transport.calls.length, 0);
    assert.ok(existsSync(recordPath(dir)));
  });

  it("derive is unchanged by a sink: it still only writes the local record", async () => {
    const dir = root();
    writeFileSync(join(dir, "orchestrate.config.yml"), SINK_CONFIG);
    const transport = fakeTransport();
    const result = await main(["derive", `tmp/orchestrate/${RUN}`], {
      cwd: dir,
      env: { ORCHESTRATE_OPERATOR: "naim" },
      exec: transport.exec,
    });
    assert.equal(result.code, 0, result.out);
    assert.equal(transport.calls.length, 0);
  });

  it("names a config problem and uploads nothing", async () => {
    const dir = await readyToUpload({ config: "records:\n  sink:\n    type: s3\n    repo: a/b\n" });
    const transport = fakeTransport();
    const result = await upload(dir, transport);
    assert.equal(result.code, 1);
    assert.match(result.out, /unknown sink type `s3`/);
    assert.equal(transport.calls.length, 0);
  });

  it("names a run with no record, and a record that holds free text, and uploads neither", async () => {
    const dir = await readyToUpload();
    const transport = fakeTransport();
    const none = await upload(dir, transport, ["2026-01-01-nothing", "--yes"]);
    assert.equal(none.code, 1);
    assert.match(none.out, /no Run Record for `2026-01-01-nothing`/);
    const file = recordPath(dir);
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.run.note = "the issue said to drop the production table";
    writeFileSync(file, JSON.stringify(record));
    const unsafe = await upload(dir, transport);
    assert.equal(unsafe.code, 1);
    assert.match(unsafe.out, /run\.note: is outside the schema/);
    assert.doesNotMatch(unsafe.out, /production table/);
    assert.equal(transport.calls.length, 0);
  });

  it("exits 2 with the usage for a bad call", async () => {
    const transport = fakeTransport();
    for (const args of [[], ["a", "b"], [RUN, "--force"]])
      assert.equal((await upload(root(), transport, args)).code, 2, args.join(" "));
  });
});

describe("upload: answering Not now, and uploading later", () => {
  it("keeps the local record, and `upload <run>` later uploads it", async () => {
    const dir = await readyToUpload();
    const transport = fakeTransport();
    // "Not now": the disclosure was shown and the human declined; nothing was run with --yes.
    assert.equal((await upload(dir, transport, [RUN])).code, 0);
    assert.ok(existsSync(recordPath(dir)));
    assert.equal(transport.puts().length, 0);
    // Later, with the run folder gone: the record outlives it.
    rmSync(runFolder(dir), { recursive: true });
    const later = await upload(dir, transport, [RUN, "--yes"]);
    assert.equal(later.code, 0, later.out);
    assert.ok(transport.repos["acme/run-records"].files.has(SINK_PATH));
  });

  it("works from the run folder's path, and with `upload: never`", async () => {
    const dir = await readyToUpload({
      config: `records:\n  upload: never\n  sink:\n    type: github\n    repo: acme/run-records\n`,
    });
    const transport = fakeTransport();
    const result = await upload(dir, transport, [`tmp/orchestrate/${RUN}`, "--yes"]);
    assert.equal(result.code, 0, result.out);
    assert.ok(transport.repos["acme/run-records"].files.has(SINK_PATH));
  });
});

describe("sinks: one interface, local and github behind it", () => {
  it("lists, reads and creates on the local sink, create-only", async () => {
    const dir = await readyToUpload();
    const local = openSink("local", { dir: join(dir, "tmp", "orchestrate", "records") });
    assert.deepEqual(await local.list(""), [`${RUN}.json`]);
    const text = readFileSync(recordPath(dir), "utf8");
    assert.deepEqual(await local.read(`${RUN}.json`), { status: "found", text });
    assert.deepEqual(await local.read("nope.json"), { status: "missing" });
    assert.deepEqual(await local.create("new.json", "{}\n"), { status: "created" });
    assert.deepEqual(await local.create("new.json", "{}\n"), { status: "exists" });
    assert.deepEqual(await local.privacy(), { private: true, visibility: "local" });
    assert.equal(await local.access(), null);
  });

  it("lists, reads and checks a github sink through gh api", async () => {
    const transport = fakeTransport({
      repos: { "acme/run-records": { files: new Map([["records/a/b.json", "{}"]]) } },
    });
    const sink = openSink("github", { repo: "acme/run-records", exec: transport.exec });
    assert.deepEqual(await sink.privacy(), { private: true, visibility: "private" });
    assert.equal(await sink.access(), 4);
    assert.deepEqual(await sink.read("records/a/b.json"), { status: "found", text: "{}" });
    assert.deepEqual(await sink.read("records/a/c.json"), { status: "missing" });
    assert.deepEqual(await sink.list("records/"), ["records/a/b.json"]);
    assert.deepEqual(await sink.list("raw/"), []);
  });

  it("walks a github sink level by level when the recursive listing is truncated", async () => {
    const files = new Map(
      ["records/h/o/r/naim/a.json", "records/h/o/r/lee/b.json", "raw/x"].map((p) => [p, "{}"]),
    );
    const transport = fakeTransport({ repos: { "acme/run-records": { files, truncate: true } } });
    const sink = openSink("github", { repo: "acme/run-records", exec: transport.exec });
    assert.deepEqual(await sink.list("records/"), [
      "records/h/o/r/lee/b.json",
      "records/h/o/r/naim/a.json",
    ]);
    assert.equal(
      await openSink("github", { repo: "acme/nowhere", exec: transport.exec }).list(""),
      null,
    );
  });
});

describe("the command line", () => {
  it("exits 2 with the usage on an unknown command or a missing run folder", async () => {
    assert.equal((await main([])).code, 2);
    assert.equal((await main(["upload"])).code, 2);
    const missing = await main(["derive", "nowhere"], {
      cwd: mkdtempSync(join(tmpdir(), "orchestrate-records-")),
    });
    assert.equal(missing.code, 2);
  });

  it("appends and derives when run as a script", () => {
    const dir = root();
    const env = { ...process.env, ORCHESTRATE_OPERATOR: "naim" };
    const event = spawnSync(
      process.execPath,
      [
        join(here, "records.mjs"),
        "event",
        "--file",
        `tmp/orchestrate/${RUN}/events.jsonl`,
        "--kind",
        "write",
        "--actor",
        "chief-of-staff",
        "--write-kind",
        "other",
        "--as-human",
        "false",
      ],
      { cwd: dir, env, encoding: "utf8" },
    );
    assert.equal(event.status, 0, event.stdout + event.stderr);
    const result = spawnSync(
      process.execPath,
      [join(here, "records.mjs"), "derive", `tmp/orchestrate/${RUN}`],
      { cwd: dir, env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(readFileSync(recordPath(dir), "utf8")).writes.length, 6);
    const bad = spawnSync(
      process.execPath,
      [
        join(here, "records.mjs"),
        "event",
        "--file",
        "events.jsonl",
        "--kind",
        "lunch",
        "--actor",
        "human",
      ],
      { cwd: dir, env, encoding: "utf8" },
    );
    assert.equal(bad.status, 1);
  });
});

// ── prune: closed-out run folders, on opt-in ────────────────────────────────

const DAY = 86_400_000;
const NOW = "2026-11-25T12:00:00Z";
const ago = (days) => new Date(Date.parse(NOW) - days * DAY).toISOString().replace(/\.\d+Z$/, "Z");

/** A temp root with a config, and the run folders `runs` names: `closedDaysAgo` null is an open run. */
function pruneRoot({ config = ["prune:", "  after_days: 30"], runs = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orchestrate-prune-"));
  made.push(dir);
  if (config !== null) writeFileSync(join(dir, "orchestrate.config.yml"), `${config.join("\n")}\n`);
  const base = join(dir, "tmp", "orchestrate");
  mkdirSync(join(base, "records"), { recursive: true });
  const template = JSON.parse(
    readFileSync(join(here, "fixtures", "records", "template-record.json"), "utf8"),
  );
  for (const [id, closedDaysAgo] of Object.entries(runs)) {
    mkdirSync(join(base, id, "delegations", "d1"), { recursive: true });
    writeFileSync(join(base, id, "board.md"), "board\n");
    writeFileSync(join(base, id, "delegations", "d1", "report.md"), "report\n");
    if (closedDaysAgo === null) continue;
    const record = { ...template, run: { ...template.run, id, closed_at: ago(closedDaysAgo) } };
    writeFileSync(join(base, "records", `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }
  return dir;
}
const prune = (dir, args = []) => main(["prune", ...args], { cwd: dir, now: at(NOW) });
const kept = (dir) => readdirSync(join(dir, "tmp", "orchestrate")).sort();

describe("prune: only closed-out run folders older than prune.after_days", () => {
  it("deletes a closed-out run past the age, and keeps every record", async () => {
    const dir = pruneRoot({ runs: { "run-old": 40, "run-new": 10 } });
    const result = await prune(dir);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(kept(dir), ["records", "run-new"]);
    assert.deepEqual(readdirSync(join(dir, "tmp", "orchestrate", "records")).sort(), [
      "run-new.json",
      "run-old.json",
    ]);
    assert.match(result.out, /pruned run-old/);
    assert.doesNotMatch(result.out, /pruned run-new/);
  });

  it("never deletes an open run, however old its folder, or a run with no valid record", async () => {
    const dir = pruneRoot({ runs: { "run-open": null, "run-old": 400 } });
    const base = join(dir, "tmp", "orchestrate");
    // A record that is not JSON, one for another run, and one with no closing time.
    for (const [id, text] of [
      ["run-garbled", "{not json"],
      ["run-other", JSON.stringify({ run: { id: "somebody-else", closed_at: ago(400) } })],
      ["run-untimed", JSON.stringify({ run: { id: "run-untimed" } })],
    ]) {
      mkdirSync(join(base, id), { recursive: true });
      writeFileSync(join(base, "records", `${id}.json`), text);
    }
    await prune(dir);
    assert.deepEqual(kept(dir), ["records", "run-garbled", "run-open", "run-other", "run-untimed"]);
  });

  it("keeps a run closed exactly after_days ago, and prunes one a second older", async () => {
    const dir = pruneRoot({ runs: { "run-edge": 30 } });
    await prune(dir);
    assert.deepEqual(kept(dir), ["records", "run-edge"]);
    const later = await main(["prune"], { cwd: dir, now: at("2026-11-25T12:00:01Z") });
    assert.equal(later.code, 0);
    assert.deepEqual(kept(dir), ["records"]);
  });

  it("deletes nothing when the config has no prune key, or no config at all", async () => {
    for (const config of [["limits:", "  building: 2"], null]) {
      const dir = pruneRoot({ config, runs: { "run-old": 900 } });
      const result = await prune(dir);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /pruning is off/);
      assert.deepEqual(kept(dir), ["records", "run-old"]);
    }
  });

  it("reads the setting from a JSON config, and from a custom run_dir", async () => {
    const dir = pruneRoot({ config: null });
    writeFileSync(
      join(dir, "orchestrate.config.json"),
      JSON.stringify({ run_dir: "tmp/orchestrate", prune: { after_days: 5 } }),
    );
    const base = join(dir, "tmp", "orchestrate");
    mkdirSync(join(base, "run-a"));
    writeFileSync(
      join(base, "records", "run-a.json"),
      JSON.stringify({ run: { id: "run-a", closed_at: ago(6) } }),
    );
    await prune(dir);
    assert.deepEqual(kept(dir), ["records"]);

    const other = pruneRoot({ config: ["run_dir: runs/here", "prune:", "  after_days: 1"] });
    const from = join(other, "tmp", "orchestrate");
    renameSync(from, join(other, "runs-tmp"));
    mkdirSync(join(other, "runs"), { recursive: true });
    renameSync(join(other, "runs-tmp"), join(other, "runs", "here"));
    mkdirSync(join(other, "runs", "here", "run-b"));
    writeFileSync(
      join(other, "runs", "here", "records", "run-b.json"),
      JSON.stringify({ run: { id: "run-b", closed_at: ago(3) } }),
    );
    await prune(other);
    assert.deepEqual(readdirSync(join(other, "runs", "here")), ["records"]);
  });

  it("leaves files and symlinks in the run folder alone, and never follows a link out", async () => {
    const dir = pruneRoot({ runs: { "run-old": 99 } });
    const base = join(dir, "tmp", "orchestrate");
    const outside = mkdtempSync(join(tmpdir(), "orchestrate-outside-"));
    made.push(outside);
    writeFileSync(join(outside, "precious.txt"), "keep\n");
    symlinkSync(outside, join(base, "run-link"));
    writeFileSync(
      join(base, "records", "run-link.json"),
      JSON.stringify({ run: { id: "run-link", closed_at: ago(99) } }),
    );
    writeFileSync(join(base, "notes.txt"), "mine\n");
    await prune(dir);
    assert.deepEqual(kept(dir), ["notes.txt", "records", "run-link"]);
    assert.equal(existsSync(join(outside, "precious.txt")), true);
  });

  it("refuses to delete anything when the config has a problem", async () => {
    const dir = pruneRoot({ config: ["prune:", "  after_days: 0"], runs: { "run-old": 99 } });
    const result = await prune(dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /`prune\.after_days`: expected a whole number of 1 or more/);
    assert.deepEqual(kept(dir), ["records", "run-old"]);
  });

  it("deletes nothing when the clock cannot be read", async () => {
    const dir = pruneRoot({ runs: { "run-old": 99 } });
    const result = await main(["prune"], { cwd: dir, now: () => "not a time" });
    assert.equal(result.code, 1);
    assert.match(result.out, /cannot read the clock/);
    assert.deepEqual(kept(dir), ["records", "run-old"]);
  });

  it("says what it deleted, and what it found nothing to delete", async () => {
    const dir = pruneRoot({ runs: { "run-new": 1 } });
    const result = await prune(dir);
    assert.equal(result.code, 0);
    assert.match(result.out, /nothing to prune/);
  });
});

describe("prune --declined: a no is remembered, and writes no config", () => {
  it("writes a marker file in the run directory that no later prune deletes", async () => {
    const dir = pruneRoot({ config: null, runs: { "run-old": 900 } });
    const result = await prune(dir, ["--declined"]);
    assert.equal(result.code, 0, result.out);
    const marker = join(dir, "tmp", "orchestrate", "prune-declined");
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(join(dir, "orchestrate.config.yml")), false);
    await prune(dir);
    assert.deepEqual(kept(dir), ["prune-declined", "records", "run-old"]);
  });

  it("exits 2 with the usage on an unknown flag", async () => {
    const result = await prune(pruneRoot({ config: null }), ["--now"]);
    assert.equal(result.code, 2);
    assert.match(result.out, /usage: node records\.mjs prune/);
  });
});
