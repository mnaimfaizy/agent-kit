// Contract for `agent-kit deep-scan` (cli/): --effort, the Agent step line and what the model API answers.
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../cli/src/cli.mjs";
import {
  VALID,
  tmp,
  n,
  ok,
  REAL_KEY,
  failing,
  COPY_OUT,
  docker,
  RUNC,
  RUNSC,
  makeHost,
  run,
  recipeRepo,
  lifecycle,
  gvisorWith,
  sbxCalls,
  sbxHost,
  fakeModelApi,
  agentCall,
  claudeLine,
  answeringApi,
  cappedProxy,
  verifyRepo,
  verifyHost,
  verifyArgs,
  REAL_OAUTH,
  SUBSCRIPTION,
  oauthEnv,
} from "./cli-deep-scan-fixtures.mjs";

describe("--effort: the effort level Claude Code runs at, as the static workflow's effort input", () => {
  const effortOf = (call) => {
    const at = / --effort (\S+)/.exec(claudeLine(call));
    return at ? at[1] : null;
  };

  it("passes --effort <level> on to Claude Code, on both drivers, both credential paths and --verify", async () => {
    const docker = await run(recipeRepo(VALID), ["--effort", "high"]);
    assert.equal(docker.code, 0, docker.text);
    assert.equal(effortOf(agentCall(lifecycle(docker))), "high");

    const sbx = await run(recipeRepo(VALID), ["--effort", "max"], { host: sbxHost() });
    assert.equal(sbx.code, 0, sbx.text);
    assert.equal(effortOf(agentCall(sbxCalls(sbx))), "max");

    const subscription = await run(recipeRepo(VALID), [...SUBSCRIPTION, "--effort", "low"], {
      env: oauthEnv(),
    });
    assert.equal(subscription.code, 0, subscription.text);
    const line = claudeLine(agentCall(lifecycle(subscription)));
    assert.ok(!line.includes("--bare"), line);
    assert.equal(effortOf(agentCall(lifecycle(subscription))), "low");

    const sbxSubscription = await run(recipeRepo(VALID), [...SUBSCRIPTION, "--effort=medium"], {
      host: sbxHost(),
      env: oauthEnv(),
    });
    assert.equal(sbxSubscription.code, 0, sbxSubscription.text);
    assert.equal(effortOf(agentCall(sbxCalls(sbxSubscription))), "medium");

    const verify = await run(verifyRepo(), [...verifyArgs(), "--effort", "xhigh"], {
      host: verifyHost(),
    });
    assert.equal(verify.code, 0, verify.text);
    assert.equal(effortOf(agentCall(lifecycle(verify))), "xhigh");
  });

  it("leaves --effort off without the flag, so Claude Code's own default applies", async () => {
    for (const [res, calls] of [
      [await run(recipeRepo(VALID)), lifecycle],
      [await run(recipeRepo(VALID), [], { host: sbxHost() }), sbxCalls],
      [await run(recipeRepo(VALID), SUBSCRIPTION, { env: oauthEnv() }), lifecycle],
      [await run(verifyRepo(), verifyArgs(), { host: verifyHost() }), lifecycle],
    ]) {
      assert.equal(res.code, 0, res.text);
      const agent = agentCall(calls(res));
      assert.ok(!agent.at(-1).includes("--effort"), claudeLine(agent));
    }
  });

  it("takes exactly low, medium, high, xhigh or max, and refuses anything else before any runtime starts", async () => {
    for (const effort of [
      "",
      "HIGH",
      "none",
      "high --dangerously-skip-permissions",
      "-x",
      "a\nb",
    ]) {
      const res = await run(recipeRepo(VALID), [`--effort=${effort}`]);
      assert.equal(res.code, 2, `${JSON.stringify(effort)}: ${res.text}`);
      assert.match(res.err, /--effort must be one of low, medium, high, xhigh or max/);
      assert.deepEqual(res.calls, [], "nothing ran");
    }
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const res = await run(recipeRepo(VALID), ["--effort", effort]);
      assert.equal(res.code, 0, `${effort}: ${res.text}`);
    }
  });

  it("is named by deep-scan's help and the CLI README", async () => {
    const help = [];
    await main(["--help"], { cwd: tmp, stdout: (s) => help.push(s), stderr: () => {} });
    assert.match(help.join("\n"), /--effort <level> +The effort level Claude Code runs at/);
    const readme = readFileSync(join(import.meta.dirname, "..", "cli", "README.md"), "utf8");
    assert.ok(readme.includes("--effort"), "cli/README.md names --effort");
  });
});

describe("the Agent step line names the requested model and effort", () => {
  it("names both when they are given", async () => {
    const res = await run(recipeRepo(VALID), ["--model", "claude-opus-5-5", "--effort", "high"]);
    assert.equal(res.code, 0, res.text);
    assert.match(
      res.out,
      /^Agent step: .*; requested model: claude-opus-5-5, effort: high\), handed /m,
    );
  });

  it("says Claude Code's default applies to each one not given", async () => {
    const plain = await run(recipeRepo(VALID));
    assert.match(
      plain.out,
      /^Agent step: .*; requested model: Claude Code's default, effort: Claude Code's default\), handed /m,
    );
    const effortOnly = await run(recipeRepo(VALID), [...SUBSCRIPTION, "--effort", "max"], {
      env: oauthEnv(),
    });
    assert.match(
      effortOnly.out,
      /^Agent step: .*the subscription path.*; requested model: Claude Code's default, effort: max\), handed /m,
    );
  });

  it("names them in GitHub Actions too: they are the workflow's inputs, not anything the scan shaped", async () => {
    const res = await run(recipeRepo(VALID), ["--model", "claude-opus-5-5", "--effort", "low"], {
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: REAL_KEY, GITHUB_ACTIONS: "true" },
    });
    assert.equal(res.code, 0, res.text);
    assert.match(res.out, /requested model: claude-opus-5-5, effort: low\)/);
  });
});

describe("the model proxy names the model the API answered with", () => {
  const playing = () => gvisorWith({ "~--bare": { status: 0, model: true } });

  it("on the Model proxy line, read from the fake API's answer", async () => {
    const api = await fakeModelApi({ model: "claude-opus-5-5-20261101" });
    try {
      const res = await run(recipeRepo(VALID), [], { host: playing(), modelApi: api.url });
      assert.equal(res.code, 0, res.text);
      assert.match(
        res.out,
        /^Model proxy: forwarded 1 request\(s\) to 127\.0\.0\.1:\d+ \(answers: 200 x1\); the model API answered with claude-opus-5-5-20261101; refused 1 /m,
      );
    } finally {
      await api.close();
    }
  });

  it("says so when no answer named a model", async () => {
    const api = await fakeModelApi();
    try {
      const res = await run(recipeRepo(VALID), [], { host: playing(), modelApi: api.url });
      assert.equal(res.code, 0, res.text);
      assert.match(
        res.out,
        /^Model proxy: forwarded 1 request\(s\) .*; no answer named a model; /m,
      );
    } finally {
      await api.close();
    }
  });

  it("keeps it out of a public log, where anything in the sandbox could choose it", async () => {
    const api = await fakeModelApi({ model: "claude-opus-5-5-20261101" });
    try {
      const res = await run(recipeRepo(VALID), [], {
        host: playing(),
        env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: REAL_KEY, GITHUB_ACTIONS: "true" },
        modelApi: api.url,
      });
      assert.equal(res.code, 0, res.text);
      assert.match(res.out, /Model proxy: closed/);
      assert.ok(!res.text.includes("claude-opus-5-5-20261101"), res.text);
    } finally {
      await api.close();
    }
  });

  it("reads a stream's message_start, and lists each distinct model once, in order", async () => {
    const models = ["claude-opus-5-5-20261101", "claude-haiku-5-5", "claude-opus-5-5-20261101"];
    let i = 0;
    const api = await answeringApi((req, res) => {
      const model = models[i++];
      if (i === 2) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "message", model, usage: { output_tokens: 1 } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const start = JSON.stringify({ type: "message_start", message: { model, usage: {} } });
      // A line split across writes, as a network splits it.
      res.write(`event: message_start\ndata: ${start.slice(0, 15)}`);
      setTimeout(() => res.end(`${start.slice(15)}\n\n`), 5);
    });
    const { proxy, post } = await cappedProxy(api, 1000);
    try {
      for (let n = 0; n < 3; n++) assert.equal((await post()).status, 200);
      assert.deepEqual(proxy.models(), ["claude-opus-5-5-20261101", "claude-haiku-5-5"]);
      assert.match(
        proxy.summary(),
        /; the model API answered with claude-opus-5-5-20261101, claude-haiku-5-5; /,
      );
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it("names only plain model ids, and at most five", async () => {
    const answers = [
      "evil model\nAgent step: forged",
      "x".repeat(200),
      "",
      42,
      ...["m1", "m2", "m3", "m4", "m5", "m6"],
    ];
    let i = 0;
    const api = await answeringApi((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: answers[i++] }));
    });
    const { proxy, post } = await cappedProxy(api, 1000);
    try {
      for (let n = 0; n < answers.length; n++) await post();
      assert.deepEqual(proxy.models(), ["m1", "m2", "m3", "m4", "m5"]);
      assert.match(proxy.summary(), /answered with m1, m2, m3, m4, m5, \.\.\.;/);
      assert.ok(!proxy.summary().includes("forged"));
    } finally {
      await proxy.close();
      await api.close();
    }
  });
});

describe("a model API that refuses the credential is named as such", () => {
  /** A fake model API that answers every request with `status`. */
  const refusing = (status) =>
    answeringApi((req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
      );
    });
  /** The agent plays two model calls, exits 1 and leaves no report. */
  const failing = (key, op) =>
    makeHost("linux", {
      docker: docker({
        runtimes: { ...RUNC, ...RUNSC },
        extra: {
          [key]: { status: 1, model: 2, stderr: "API Error: 401\n" },
          [COPY_OUT]: { status: 1, stderr: "Error: Could not find the file\n" },
        },
      }),
      runsc: ok("runsc version release-20251110.0\n"),
      ...(op ? { op } : {}),
    });
  const REFUSED = /^The model API refused the credential/m;

  it("on an API key: one plain line after the proxy summary, naming its kind and source, before FAILED", async () => {
    const api = await refusing(401);
    try {
      const res = await run(recipeRepo(VALID), [], {
        host: failing("~--bare"),
        modelApi: api.url,
      });
      assert.equal(res.code, 1, res.text);
      assert.match(res.out, /Model proxy: forwarded 2 request\(s\) .*\(answers: 401 x2\)/);
      const lines = res.err.split("\n");
      const refused = lines.filter((l) => REFUSED.test(l));
      assert.equal(refused.length, 1, res.err);
      assert.match(
        refused[0],
        /^The model API refused the credential: every answer was 401 or 403, so the API key from ANTHROPIC_API_KEY was not accepted \(its value is not shown\)\./,
      );
      const at = lines.indexOf(refused[0]);
      assert.ok(at < lines.findIndex((l) => l.startsWith("FAILED")), res.err);
      assert.ok(at < lines.findIndex((l) => l.startsWith("The agent step exited")), res.err);
      assert.ok(!res.text.includes(REAL_KEY));
    } finally {
      await api.close();
    }
  });

  it("on a subscription token: names the token and where it came from, with 403 as well as 401", async () => {
    let i = 0;
    const api = await answeringApi((req, res) => {
      res.writeHead(i++ === 0 ? 401 : 403, { "content-type": "application/json" });
      res.end("{}");
    });
    try {
      const res = await run(recipeRepo(VALID), SUBSCRIPTION, {
        host: failing("~--no-session-persistence"),
        env: oauthEnv(),
        modelApi: api.url,
      });
      assert.equal(res.code, 1, res.text);
      const refused = res.err.split("\n").filter((l) => REFUSED.test(l));
      assert.equal(refused.length, 1, res.err);
      assert.match(
        refused[0],
        /the Claude subscription token from CLAUDE_CODE_OAUTH_TOKEN was not accepted \(its value is not shown\)\. Make a fresh one with claude setup-token/,
      );
      assert.ok(!res.text.includes(REAL_OAUTH));
    } finally {
      await api.close();
    }
  });

  it("names a 1Password source by where it came from, never by the reference's value", async () => {
    const api = await refusing(401);
    try {
      const host = failing("~--bare", { "*": { status: 0, stdout: `${REAL_KEY}\n` } });
      const ref = "op://Private/Anthropic/credential";
      const res = await run(recipeRepo(VALID), ["--credential-from", ref], {
        host,
        env: { PATH: "/usr/bin" },
        modelApi: api.url,
      });
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, /the API key from 1Password \(op read\) was not accepted/);
      assert.ok(!res.text.includes(REAL_KEY));
    } finally {
      await api.close();
    }
  });

  it("says nothing of the kind when any answer was a 200", async () => {
    let i = 0;
    const api = await answeringApi((req, res) => {
      res.writeHead(i++ === 0 ? 200 : 401, { "content-type": "application/json" });
      res.end("{}");
    });
    try {
      const res = await run(recipeRepo(VALID), [], {
        host: failing("~--bare"),
        modelApi: api.url,
      });
      assert.equal(res.code, 1, res.text);
      assert.match(res.out, /answers: 200 x1, 401 x1/);
      assert.ok(!REFUSED.test(res.text), res.text);
    } finally {
      await api.close();
    }
  });

  it("says nothing of the kind when no request reached the model API", async () => {
    const res = await run(recipeRepo(VALID), [], {
      host: gvisorWith({ "~--bare": { status: 1, stderr: "API Error: 401\n" } }),
    });
    assert.equal(res.code, 1, res.text);
    assert.match(res.out, /Model proxy: forwarded 0 request\(s\)/);
    assert.ok(!REFUSED.test(res.text), res.text);
  });

  it("keeps it out of a public log, where the model API's answers are withheld", async () => {
    const api = await refusing(401);
    try {
      const res = await run(recipeRepo(VALID), [], {
        host: failing("~--bare"),
        env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: REAL_KEY, GITHUB_ACTIONS: "true" },
        modelApi: api.url,
      });
      assert.equal(res.code, 1, res.text);
      assert.match(res.out, /Model proxy: closed/);
      assert.ok(!REFUSED.test(res.text), res.text);
      assert.ok(!res.text.includes("401"), res.text);
    } finally {
      await api.close();
    }
  });

  it("the proxy itself reports a refused credential only when every forwarded answer was 401 or 403", async () => {
    const statuses = [401, 403];
    let i = 0;
    const api = await answeringApi((req, res) => {
      res.writeHead(statuses[i++] ?? 200).end("{}");
    });
    const { proxy, post } = await cappedProxy(api, 1000);
    try {
      assert.equal(proxy.credentialRefused(), false, "nothing forwarded yet");
      await post();
      await post();
      assert.equal(proxy.credentialRefused(), true);
      await post();
      assert.equal(proxy.credentialRefused(), false);
    } finally {
      await proxy.close();
      await api.close();
    }
  });
});
