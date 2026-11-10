/**
 * Contract suite for `manual-qa`'s half of the config and its host rule:
 * every `run:` shape outside ADAPTER.md is a named problem with its line, the
 * readiness check names exactly what a run still needs, a problem in one
 * skill's section never stops the other, and a `stack` run signs in only to
 * a local development host.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  hostVerdict,
  main,
  parseConfig,
  readQaConfig,
  runReadiness,
  validatePlan,
} from "./adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOOD_PLAN = readFileSync(join(HERE, "fixtures", "plans", "good.md"), "utf8");
const yaml = (...lines) => parseConfig("qa.config.yml", lines.join("\n"));
const reader = (files) => (path) => (Object.hasOwn(files, path) ? files[path] : null);

/** A complete `run:` section for a local QA Stack. */
const STACK_RUN = [
  "run:",
  "  target: stack",
  "  surface: web",
  "  stack:",
  '    up: "docker compose up -d"',
  '    migrate: "npm run migrate"',
  '    seed: "npm run seed:qa"',
  '    down: "docker compose down"',
  "  accounts:",
  '    print: "npm run seed:qa -- --print"',
  '    restore: "npm run seed:qa -- --restore --account {id}"',
  "    roles:",
  "      - id: admin",
  '        purpose: "manages members"',
  "      - id: member",
  '        purpose: "an ordinary member"',
  "  version_endpoint: /version",
  "  evidence: { upload: none }",
];

// ── `run:` shapes ───────────────────────────────────────────────────────────

test("a complete `run:` section reads with no problems in either skill", () => {
  const read = yaml(...STACK_RUN);
  assert.deepEqual(read.problems, []);
  assert.deepEqual(read.runProblems, []);
  assert.equal(read.config.run.accounts.roles[1].id, "member");
});

test("the spec's flow-style `run:` example reads with no problems", () => {
  const read = yaml(
    "run:",
    "  target: stack",
    "  surface: web",
    '  stack: { up: "...", migrate: "...", seed: "...", down: "..." }',
    "  accounts:",
    '    print: "..."',
    '    restore: "... --restore --account {id}"',
    '    roles: [{ id: admin, purpose: "..." }, { id: user, purpose: "..." }]',
    "  version_endpoint: /version",
    "  evidence: { upload: none }",
  );
  assert.deepEqual(read.runProblems, []);
});

test("each `run:` problem is named with its line", () => {
  const read = yaml(
    "run:",
    "  target: local",
    "  surface: tv",
    "  stack: { up: docker, start: now }",
    "  accounts:",
    '    print: ""',
    "    restore: reset-everything",
    "    roles:",
    '      - { id: "bad id", purpose: x }',
    "      - { id: admin }",
    "      - { id: admin, purpose: again }",
    "  version_endpoint: https://prod.example.com/version",
    "  evidence: { upload: s3 }",
    "  colour: blue",
  );
  assert.deepEqual(read.runProblems, [
    "line 14: `run.colour`: unknown key (ADAPTER.md documents: target, surface, stack, accounts, version_endpoint, evidence)",
    "line 2: `run.target`: expected one of: stack, url",
    "line 3: `run.surface`: expected one of: web, desktop, mobile, api",
    "line 4: `run.stack.start`: unknown key (ADAPTER.md documents: up, migrate, seed, down)",
    "line 6: `run.accounts.print`: expected a command",
    "line 7: `run.accounts.restore`: expected `{id}` where the role id goes",
    "line 9: `run.accounts.roles[0].id`: required: letters, digits, `_` and `-` only",
    "line 10: `run.accounts.roles[1].purpose`: required: expected a string",
    "line 11: `run.accounts.roles[2].id`: duplicate role `admin`",
    "line 12: `run.version_endpoint`: expected a path on the build's own host, such as `/version`",
    "line 13: `run.evidence.upload`: expected `none` or `gh-release:<tag>`",
  ]);
});

test("wrong shapes for `run:` and its mappings are problems", () => {
  assert.deepEqual(yaml("run: stack").runProblems, ["line 1: `run`: expected a mapping"]);
  assert.deepEqual(yaml("run:", "  stack: up", "  accounts: [a]", "  evidence: none").runProblems, [
    "line 2: `run.stack`: expected a mapping of `up`, `migrate`, `seed`, `down`",
    "line 3: `run.accounts`: expected a mapping of `print`, `restore`, `roles`",
    "line 4: `run.evidence`: expected a mapping, such as `{ upload: none }`",
  ]);
  assert.deepEqual(yaml("run:", "  accounts:", "    roles: admin").runProblems, [
    "line 3: `run.accounts.roles`: expected a list of `{ id: <role>, purpose: <what it is for> }`",
  ]);
});

test("`gh-release:<tag>` is a valid upload target", () => {
  assert.deepEqual(yaml("run:", "  evidence: { upload: gh-release:qa-evidence }").runProblems, []);
});

test("JSON `run:` problems carry their key path", () => {
  const read = parseConfig("qa.config.json", JSON.stringify({ run: { target: "prod" } }));
  assert.deepEqual(read.runProblems, ["`run.target`: expected one of: stack, url"]);
});

test("a problem in one skill's section never stops the other", () => {
  const badRun = yaml("plan:", "  base_ref: origin/main", "run:", "  target: prod");
  assert.deepEqual(badRun.problems, []);
  assert.equal(badRun.runProblems.length, 1);
  const badPlan = yaml("plan:", "  tracker: jira", "run:", "  target: stack");
  assert.equal(badPlan.problems.length, 1);
  assert.deepEqual(badPlan.runProblems, []);
});

test("a problem both skills read stops both: syntax, unknown top-level keys, working_dir", () => {
  for (const lines of [["\tworking_dir: x"], ["nope: 1"], ["working_dir: /etc"]]) {
    const read = yaml(...lines);
    assert.equal(read.problems.length, 1, lines[0]);
    assert.deepEqual(read.runProblems, read.problems, lines[0]);
  }
});

// ── Readiness ───────────────────────────────────────────────────────────────

test("readiness with no config names target, surface, roles", () => {
  const readiness = runReadiness(readQaConfig(reader({})));
  assert.equal(readiness.ready, false);
  assert.deepEqual(
    readiness.needs.map((n) => n.split(":")[0]),
    ["run.target", "run.surface", "run.accounts.roles"],
  );
});

test("a `stack` target also needs the four stack commands and `accounts.print`", () => {
  const readiness = runReadiness(
    readQaConfig(reader({ "qa.config.yml": "run:\n  target: stack\n  stack: { up: go }\n" })),
  );
  assert.deepEqual(
    readiness.needs.map((n) => n.split(":")[0]),
    [
      "run.surface",
      "run.accounts.roles",
      "run.stack.migrate",
      "run.stack.seed",
      "run.stack.down",
      "run.accounts.print",
    ],
  );
});

test("a complete stack config is ready, and says nothing is missing", () => {
  const readiness = runReadiness(readQaConfig(reader({ "qa.config.yml": STACK_RUN.join("\n") })));
  assert.deepEqual(readiness, {
    ready: true,
    needs: [],
    notes: [],
    run: { target: "stack", surface: "web", roles: ["admin", "member"] },
  });
});

test("without `restore` or `version_endpoint`, the run goes on with a note", () => {
  const text = STACK_RUN.filter((l) => !/restore:|version_endpoint:/.test(l)).join("\n");
  const readiness = runReadiness(readQaConfig(reader({ "qa.config.yml": text })));
  assert.equal(readiness.ready, true);
  assert.equal(readiness.notes.length, 2);
});

test("the plan's Run brief fills target and surface; its roles must be declared", () => {
  const { plan } = validatePlan(GOOD_PLAN);
  const onlyAdmin = [
    "run:",
    "  stack: { up: a, migrate: b, seed: c, down: d }",
    "  accounts:",
    "    print: p",
    "    roles: [{ id: admin, purpose: x }]",
  ].join("\n");
  const readiness = runReadiness(readQaConfig(reader({ "qa.config.yml": onlyAdmin })), plan);
  assert.deepEqual(readiness.run, { target: "stack", surface: "web", roles: ["admin"] });
  assert.deepEqual(readiness.needs, [
    "run.accounts.roles: the plan signs in as `member`, which the config does not declare",
  ]);
});

test("a config that disagrees with the plan's Run brief is asked about", () => {
  const { plan } = validatePlan(GOOD_PLAN);
  const text = STACK_RUN.join("\n").replace("surface: web", "surface: api");
  const readiness = runReadiness(readQaConfig(reader({ "qa.config.yml": text })), plan);
  assert.equal(readiness.ready, false);
  assert.match(
    readiness.needs[0],
    /^run\.surface: the config says `api` but the plan's Run brief says `web`/,
  );
});

test("readiness is never ready over `run:` problems", () => {
  const readiness = runReadiness(
    readQaConfig(reader({ "qa.config.yml": "run:\n  target: prod\n" })),
  );
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.needs, ["a config with no problems in `run:`: fix each one listed"]);
});

// ── check --for run ─────────────────────────────────────────────────────────

test("check --for run prints problems and exits 1", () => {
  const result = main(["check", "--for", "run"], { read: reader({ "qa.config.yml": "run: x\n" }) });
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.out).problems, ["line 1: `run`: expected a mapping"]);
});

test("check --for run --plan reads the plan's Run brief into readiness", () => {
  const io = {
    read: reader({ "qa.config.yml": STACK_RUN.join("\n") }),
    readFile: (p) => (p === "plan.md" ? GOOD_PLAN : null),
  };
  const result = main(["check", "--for", "run", "--plan", "plan.md"], io);
  assert.equal(result.code, 0);
  const out = JSON.parse(result.out);
  assert.deepEqual(out.planProblems, []);
  assert.equal(out.readiness.ready, true);
  assert.equal(out.effective.working_dir, "tmp/qa");
  assert.equal(out.effective.run.target, "stack");
});

test("check --for run --plan exits 1 on a plan with problems", () => {
  const io = { read: reader({}), readFile: () => "not a plan" };
  const result = main(["check", "--for", "run", "--plan", "plan.md"], io);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.out).planProblems.length, 1);
});

test("check --for run is not stopped by a problem in `plan:`", () => {
  const io = {
    read: reader({ "qa.config.yml": `plan:\n  tracker: jira\n${STACK_RUN.join("\n")}` }),
  };
  assert.equal(main(["check", "--for", "run"], io).code, 0);
  assert.equal(main(["check", "--for", "plan"], io).code, 1);
});

// ── render with `run:` answers ──────────────────────────────────────────────

test("render writes `run:` answers that read back with no problems", () => {
  const answers = {
    run: {
      target: "stack",
      surface: "web",
      stack: { up: "make up", migrate: "make migrate", seed: "make seed", down: "make down" },
      accounts: {
        print: "make seed -- --print",
        restore: "make seed -- --restore --account {id}",
        roles: [{ id: "admin", purpose: "manages members" }],
      },
    },
  };
  const result = main(["render"], { read: reader({}), stdin: () => JSON.stringify(answers) });
  assert.equal(result.code, 0);
  const back = parseConfig("qa.config.yml", result.out);
  assert.deepEqual(back.runProblems, []);
  assert.deepEqual(back.config.run, answers.run);
});

test("render refuses `run:` answers with problems", () => {
  const result = main(["render"], {
    read: reader({}),
    stdin: () => JSON.stringify({ run: { target: "prod" } }),
  });
  assert.equal(result.code, 1);
  assert.match(result.out, /`run\.target`: expected one of: stack, url/);
});

// ── Host rule ───────────────────────────────────────────────────────────────

test("local development hosts pass", () => {
  for (const address of [
    "http://localhost:3000/login",
    "localhost:8080",
    "http://127.0.0.1:5173",
    "http://[::1]:4000/",
    "https://app.localhost",
    "http://shop.test/sign-in",
    "HTTP://LOCALHOST",
  ])
    assert.equal(hostVerdict(address).verdict, "local", address);
});

test("anything else stops: hosted, production-looking, a bare TLD, lookalikes", () => {
  for (const address of [
    "https://app.example.com",
    "https://staging.example.com",
    "https://example.dev",
    "http://localhost.example.com",
    "http://127.0.0.2",
    "http://0.0.0.0:3000",
    "http://test",
    "http://example.test.evil.com",
    "file:///etc/passwd",
    "not a url at all",
    "",
  ])
    assert.equal(hostVerdict(address).verdict, "stop", address);
});

test("an address carrying sign-in values stops, even on localhost", () => {
  assert.deepEqual(hostVerdict("http://admin:pw@localhost:3000"), {
    verdict: "stop",
    host: "localhost",
    why: "the address carries sign-in values; they never go in an address",
  });
});

test("`host` exits 0 for a local host and 1 for a stop", () => {
  const io = { read: reader({}) };
  assert.equal(main(["host", "http://localhost:3000"], io).code, 0);
  assert.equal(main(["host", "https://app.example.com"], io).code, 1);
  assert.equal(main(["host"], io).code, 2);
});
