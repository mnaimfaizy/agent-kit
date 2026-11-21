// Contract for Agent-kit's own Scan recipe (#374): the dogfood Deep scan.
// The recipe must pass deep-scan's own validator, and the test-only shims and
// offline fixtures it names (security/deep-scan/) must work here, outside the
// sandbox, exactly as the recipe tells the agent to run them. Nothing here
// makes a real network call or reads a real credential: the shims record and
// never send, and the CLI's tag fetch only ever reaches a local sentinel.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkScanRecipe } from "../cli/src/checks/scan-recipe.mjs";
import { validateRecipe } from "../cli/src/deep-scan/recipe.mjs";
import { parseYamlSubset } from "../cli/src/yaml-subset.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECIPE = ".security/scan-recipe.yml";
const recipeText = () => readFileSync(join(root, RECIPE), "utf8");
const recipe = () => parseYamlSubset(recipeText());
const DEEP = "security/deep-scan";

const scratch = mkdtempSync(join(tmpdir(), "deep-scan-dogfood-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const freshDir = () => mkdtempSync(join(scratch, `${++n}-`));

/** Each JSON line of a shim's log. */
const records = (log) =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

describe("Agent-kit's own Scan recipe", () => {
  it("passes deep-scan's own validator", () => {
    assert.deepEqual(validateRecipe(recipeText()), []);
  });

  it("passes doctor's Scan recipe check at the default path", () => {
    assert.equal(checkScanRecipe({ root }).status, "pass");
  });

  it("names only fixture files that exist", () => {
    for (const fixture of recipe().fixtures) {
      for (const key of ["drives", "cases", "shim", "consumer"]) {
        if (!(key in fixture)) continue;
        const path = fixture[key].split(" ")[0];
        assert.ok(existsSync(join(root, path)), `${fixture.fixture}: ${key} ${path} is missing`);
      }
    }
  });

  it("names a stock image pinned by digest, and no Dockerfile", () => {
    const r = recipe();
    assert.match(r.image, /^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
    assert.equal("dockerfile" in r, false);
  });

  it("reaches only the npm registry in setup, and starts no service", () => {
    const r = recipe();
    assert.deepEqual(r.registries, ["registry.npmjs.org"]);
    assert.equal("start" in r, false);
    assert.equal("ready" in r, false);
    for (const step of r.setup) assert.doesNotMatch(step, /\b(sudo|apt-get|apt|su)\b/);
  });

  it("grounds the scan in the Actions hardening guide and the Claude Code hooks reference", () => {
    const sources = recipe().grounding.join("\n");
    // GitHub renamed "Security hardening for GitHub Actions" to "Secure use
    // reference"; the old URL redirects there.
    assert.match(sources, /docs\.github\.com\/.*\/actions\/reference\/security\/secure-use$/m);
    assert.match(sources, /code\.claude\.com\/docs\/en\/hooks\.md$/m);
  });

  it("says what stays static-only", () => {
    const notes = recipe().notes.join("\n").toLowerCase();
    for (const subject of [
      "reusable workflows",
      "skills",
      "prompts",
      "prompt injection",
      "tag fetch",
    ]) {
      assert.ok(notes.includes(subject), `notes do not mention ${subject}`);
    }
  });
});

describe("the recording gh shim", () => {
  const gh = (args, { stdin = "", env = {} } = {}) => {
    const log = join(freshDir(), "shim.jsonl");
    const r = spawnSync(process.execPath, [join(root, DEEP, "shims/gh"), ...args], {
      input: stdin,
      encoding: "utf8",
      env: { PATH: process.env.PATH, DEEP_SCAN_SHIM_LOG: log, ...env },
    });
    return { ...r, calls: records(log) };
  };

  it("records the arguments and stdin of an advisory request, and answers with a fake id", () => {
    const payload = '{"summary":"fake"}';
    const r = gh(
      ["api", "--method", "POST", "/repos/owner/repo/security-advisories", "--input", "-"],
      { stdin: payload },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).ghsa_id, "GHSA-fake-fake-fake");
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].shim, "gh");
    assert.deepEqual(r.calls[0].argv.slice(-3), [
      "/repos/owner/repo/security-advisories",
      "--input",
      "-",
    ]);
    assert.equal(r.calls[0].stdin, payload);
  });

  it("records which token variables are set, never their values", () => {
    const r = gh(["api", "--method", "POST", "/repos/owner/repo/issues/7/comments"], {
      env: { GITHUB_TOKEN: "fake-token-value-123" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls[0].tokenVariables, ["GITHUB_TOKEN"]);
    assert.doesNotMatch(JSON.stringify(r.calls), /fake-token-value-123/);
  });

  it("refuses, and still records, a call it has no canned answer for", () => {
    const r = gh(["repo", "view", "--json", "name"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /recording gh shim/);
    assert.deepEqual(r.calls[0].argv, ["repo", "view", "--json", "name"]);
  });
});

describe("the recording mail shim", () => {
  /** Send `lines` to the shim one at a time, each after the last reply. */
  async function converse(lines) {
    const log = join(freshDir(), "shim.jsonl");
    const { startMailShim } = await import(`../${DEEP}/shims/mail.mjs`);
    const shim = await startMailShim({ log });
    const replies = [];
    try {
      const socket = createConnection({ host: "127.0.0.1", port: shim.port });
      socket.setEncoding("utf8");
      const next = () => new Promise((resolve) => socket.once("data", resolve));
      replies.push(await next());
      for (const line of lines) {
        socket.write(`${line}\r\n`);
        replies.push(await next());
      }
      socket.end();
    } finally {
      await shim.close();
    }
    return { replies, calls: records(log) };
  }

  it("records each SMTP command, refuses TLS, and never takes a message", async () => {
    const { replies, calls } = await converse([
      "EHLO fixture",
      "STARTTLS",
      "MAIL FROM:<audit@example.com>",
      "DATA",
      "QUIT",
    ]);
    assert.match(replies[0], /^220 /);
    assert.match(replies[1], /STARTTLS/);
    assert.match(replies[2], /^454 /);
    assert.match(replies[4], /^5\d\d /);
    assert.deepEqual(
      calls.map((c) => c.command),
      ["EHLO fixture", "STARTTLS", "MAIL FROM:<audit@example.com>", "DATA", "QUIT"],
    );
    assert.ok(calls.every((c) => c.shim === "mail"));
  });

  it("records that AUTH was attempted, never what it carried", async () => {
    const { calls } = await converse(["EHLO fixture", "AUTH PLAIN AGZha2UAZmFrZS1wYXNz"]);
    assert.equal(calls[1].command, "AUTH PLAIN [redacted]");
    assert.doesNotMatch(JSON.stringify(calls), /AGZha2UAZmFrZS1wYXNz/);
  });
});

describe("each fixture drives its entry point as the recipe says", () => {
  const drive = (fixture) => {
    const dir = freshDir();
    const r = spawnSync(process.execPath, [join(root, DEEP, "drive.mjs"), fixture], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, DEEP_SCAN_FIXTURE_DIR: dir },
      timeout: 60_000,
    });
    return { ...r, dir };
  };

  for (const { fixture, drives } of recipe().fixtures.filter((f) => f.fixture)) {
    it(fixture, () => {
      const r = drive(fixture);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(r.stdout.split(/\r?\n/).includes(`Drives: ${drives}`), r.stdout);
      assert.doesNotMatch(r.stdout, /^DIFF/m);
      assert.match(r.stdout, /^ok {2}/m);
    });
  }

  it("refuses a fixture the recipe does not name", () => {
    const r = drive("no-such-fixture");
    assert.equal(r.status, 2);
  });
});
