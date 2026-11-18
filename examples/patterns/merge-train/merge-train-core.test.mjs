// Pattern guide skeleton: docs/patterns/merge-train.md in Agent-kit.
//
// The contract suite for merge-train-core.mjs. A few cases to start from:
// keep one test per rule in docs/patterns/merge-train.md, and add one every
// time the train does something you did not expect. The loop is driven over a
// fake shell, so nothing here touches the forge.
//
// Run with: node --test <path>/merge-train-core.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BASE,
  decideAutoMerge,
  decideNext,
  parseMode,
  requiredChecksFromRules,
  runAutoPass,
  runTrain,
} from "./merge-train-core.mjs";

const REQUIRED = ["build", "test"];
const green = [
  { name: "build", bucket: "pass" },
  { name: "test", bucket: "pass" },
];
const pr = (overrides = {}) => ({
  number: 1,
  state: "OPEN",
  isDraft: false,
  baseRefName: BASE,
  headRefOid: "a".repeat(40),
  mergeStateStatus: "CLEAN",
  reviewDecision: "",
  checks: green,
  ...overrides,
});

// A fake shell: each pull request answers from a list of reads, last one repeating.
function fakeIo(reads, { required = REQUIRED, facts = () => ({}) } = {}) {
  const calls = [];
  const seen = new Map();
  return {
    calls,
    requiredChecks: () => required,
    read: (n) => {
      const list = reads[n];
      const index = seen.get(n) ?? 0;
      seen.set(n, index + 1);
      return list[Math.min(index, list.length - 1)];
    },
    update: (n, head) => (calls.push(["update", n, head]), true),
    merge: (n, head) => (calls.push(["merge", n, head]), true),
    comment: (n, body) => (calls.push(["comment", n, body]), true),
    facts,
    sleep: async () => {},
    now: () => 0,
    log: () => {},
  };
}
const args = { pullRequests: [1, 2, 3], pollSeconds: 0, timeoutMinutes: 45 };

test("required checks come from the ruleset, not from a list", () => {
  const rules = [
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "test" }, { context: "build" }] },
    },
    { type: "pull_request", parameters: {} },
  ];
  assert.deepEqual(requiredChecksFromRules(rules), ["build", "test"]);
});

test("a behind branch is updated before its checks are read", () => {
  assert.equal(decideNext(pr({ mergeStateStatus: "BEHIND", checks: [] }), REQUIRED).kind, "update");
});

test("a required check with no run on this head is waiting, never green", () => {
  const step = decideNext(pr({ checks: [{ name: "build", bucket: "pass" }] }), REQUIRED);
  assert.deepEqual(step, { kind: "wait", reason: "waiting on test" });
});

test("a red required check stops, even while another still runs", () => {
  const checks = [
    { name: "build", bucket: "fail" },
    { name: "test", bucket: "pending" },
  ];
  assert.equal(decideNext(pr({ checks }), REQUIRED).kind, "stop");
});

test("a draft, a conflict and a blocking review each stop", () => {
  assert.equal(decideNext(pr({ isDraft: true }), REQUIRED).kind, "stop");
  assert.equal(decideNext(pr({ mergeStateStatus: "DIRTY" }), REQUIRED).kind, "stop");
  assert.equal(decideNext(pr({ reviewDecision: "CHANGES_REQUESTED" }), REQUIRED).kind, "stop");
});

test("the merge names the exact head whose checks were read", () => {
  assert.deepEqual(decideNext(pr(), REQUIRED), { kind: "merge", head: "a".repeat(40) });
});

test("the train stops at the first red and names what it never reached", async () => {
  const io = fakeIo({
    1: [pr()],
    2: [pr({ number: 2, checks: [{ name: "build", bucket: "fail" }] })],
    3: [pr({ number: 3 })],
  });
  const result = await runTrain(args, io);
  assert.deepEqual(result.merged, [1]);
  assert.equal(result.stoppedAt.pr, 2);
  assert.deepEqual(result.notReached, [3]);
});

test("the train merges nothing when it cannot read the required checks", async () => {
  const io = fakeIo({ 1: [pr()] }, { required: [] });
  const result = await runTrain(args, io);
  assert.deepEqual(result.merged, []);
  assert.equal(io.calls.length, 0);
});

test("an unreadable mode setting is off", () => {
  assert.equal(parseMode(null), "off");
  assert.equal(parseMode('{"mode":"yes"}'), "off");
  assert.equal(parseMode('{"mode":"shadow"}'), "shadow");
});

const allClear = (head) => ({
  head,
  requiredChecks: { status: "green" },
  baseCi: { status: "green" },
  review: { status: "approve", head },
  pathGuard: { status: "clear" },
  reversible: { status: "unread" },
});

test("a judgment can hold a merge back but never allow one", () => {
  const head = "b".repeat(40);
  assert.equal(decideAutoMerge(allClear(head), "on").action, "merge");
  assert.equal(
    decideAutoMerge({ ...allClear(head), reversible: { status: "no" } }, "on").held,
    true,
  );
  // Every other fact fails: a judgment saying "safe" changes nothing.
  const facts = { head, reversible: { status: "yes" } };
  assert.equal(decideAutoMerge(facts, "on").held, true);
});

test("a missing fact holds, and a review of another head is stale", () => {
  const head = "b".repeat(40);
  assert.equal(
    decideAutoMerge({ ...allClear(head), baseCi: { status: "missing", reason: "gh failed" } }, "on")
      .held,
    true,
  );
  assert.equal(
    decideAutoMerge(
      { ...allClear(head), review: { status: "approve", head: "c".repeat(40) } },
      "on",
    ).held,
    true,
  );
});

test("shadow comments and merges nothing", async () => {
  const io = fakeIo({ 1: [pr()] }, { facts: (_n, snapshot) => allClear(snapshot.headRefOid) });
  const result = await runAutoPass({ ...args, pullRequests: [1], mode: "shadow" }, io);
  assert.deepEqual(result.wouldMerge, [1]);
  assert.deepEqual(
    io.calls.map(([kind]) => kind),
    ["comment"],
  );
});

test("under on, a held candidate is skipped and the pass moves on", async () => {
  const io = fakeIo(
    { 1: [pr()], 2: [pr({ number: 2 })] },
    {
      facts: (n, snapshot) =>
        n === 1
          ? { ...allClear(snapshot.headRefOid), reversible: { status: "no" } }
          : allClear(snapshot.headRefOid),
    },
  );
  const result = await runAutoPass({ ...args, pullRequests: [1, 2], mode: "on" }, io);
  assert.deepEqual(result.merged, [2]);
  assert.equal(result.held[0].pr, 1);
});
