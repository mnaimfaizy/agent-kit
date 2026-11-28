// Contract for `agent-kit deep-scan` (cli/): review fixes that pin single behaviours.
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../cli/src/cli.mjs";
import { allowedCommands, runnerFor } from "../cli/src/exec.mjs";
import { EFFORTS } from "../cli/src/deep-scan.mjs";
import { AGENT_TOOLS, WEB_TOOLS } from "../cli/src/deep-scan/agent.mjs";
import { CREDENTIAL_VARS } from "../cli/src/deep-scan/credential.mjs";
import { startEgressProxy } from "../cli/src/deep-scan/egress.mjs";
import { DEFAULT_LIMITS, MAX_MINUTES, VERIFY_LIMITS } from "../cli/src/deep-scan/limits.mjs";
import { MAX_EXPORT_BYTES, MAX_GROUNDING_BYTES } from "../cli/src/deep-scan/lifecycle.mjs";
import { startModelProxy } from "../cli/src/deep-scan/model-proxy.mjs";
import { ENV_TEMPLATES } from "../cli/src/deep-scan/preflight.mjs";
import {
  git,
  VALID,
  tmp,
  n,
  REAL_KEY,
  spawnAsyncFor,
  spawnFor,
  gvisorHost,
  run,
  fakeTimers,
  groundingFetch,
  recipeRepo,
  recipe,
  lifecycle,
  isAgentStep,
  sbxCalls,
  sbxHost,
  fakeModelApi,
  rawRequest,
  MINUTE,
  verifyHost,
  verifyArgs,
  copiedIn,
  verifyRepoDeleting,
  streamingFetch,
} from "./cli-deep-scan-fixtures.mjs";

describe("review fixes: a Verification run's .env pre-flight covers what still comes from the default branch", () => {
  it("refuses an environment file on the default branch that a repository grounding path would carry in", async () => {
    const text = recipe({ drop: ["grounding"], add: "grounding:\n  - config" });
    const res = await run(verifyRepoDeleting("config/.env", text), verifyArgs(), {
      host: verifyHost(),
    });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /main \([0-9a-f]{12}\) has environment files/);
    assert.ok(res.err.includes("  - config/.env"), res.err);
    assert.match(res.err, /grounding/);
    assert.doesNotMatch(res.text, /SECRET=1/);
    assert.deepEqual(res.shims, []);
  });

  it("refuses an environment file on the default branch when the recipe builds a Dockerfile from it", async () => {
    const text = recipe({ drop: ["image"], add: "dockerfile: Dockerfile" });
    const res = await run(verifyRepoDeleting("config/.env", text), verifyArgs(), {
      host: verifyHost(),
    });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /main \([0-9a-f]{12}\) has environment files/);
    assert.ok(res.err.includes("  - config/.env"), res.err);
    assert.match(res.err, /build context/);
    assert.deepEqual(res.shims, []);
  });

  it("still verifies a fix that deletes a committed .env when nothing else is read from the default branch's tree", async () => {
    const res = await run(verifyRepoDeleting("config/.env", VALID), verifyArgs(), {
      host: verifyHost(),
    });
    assert.equal(res.code, 0, res.text);
    assert.ok(!copiedIn(res).some((e) => e.name.endsWith(".env")));
  });
});

describe("review fixes: the runner caps a child's error output as it caps standard output", () => {
  it("keeps the first line and the tail of an endless stderr, within a bound", async () => {
    const chunk = Buffer.alloc(1024 * 1024, "x\n");
    const runner = runnerFor("deep-scan", {
      spawnAsync: () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({ write: (_c, _e, cb) => cb() });
        setImmediate(() => {
          child.stderr.write("FIRST LINE\n");
          for (let i = 0; i < 48; i++) child.stderr.write(chunk);
          child.stderr.write("LAST LINE\n");
          child.stdout.end();
          child.stderr.end();
          setImmediate(() => child.emit("close", 1, null));
        });
        return child;
      },
    });
    const r = await runner.start("docker", ["exec", "x", "sh", "-c", "yes >&2"]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.length <= 2 * 1024 * 1024, `kept ${r.stderr.length} characters`);
    assert.ok(r.stderr.startsWith("FIRST LINE\n"), r.stderr.slice(0, 40));
    assert.ok(r.stderr.endsWith("LAST LINE\n"), r.stderr.slice(-40));
  });
});

describe("review fixes: a grounding URL's body is read inside the fetch's own error handling", () => {
  it("exits 130 on an interrupt while the body downloads", async () => {
    const signals = new EventEmitter();
    const res = await run(recipeRepo(VALID), [], {
      signals,
      fetch: streamingFetch({
        then: (controller, init) => {
          signals.emit("SIGINT");
          controller.error(init.signal.reason ?? new DOMException("aborted", "AbortError"));
        },
      }),
    });
    assert.equal(res.code, 130, res.text);
    assert.ok(!lifecycle(res).some(isAgentStep));
    assert.ok(
      lifecycle(res).some((a) => a[0] === "rm"),
      "torn down",
    );
  });

  it("exits 3 with the setup wall clock's Stopped: line when it fires while the body downloads", async () => {
    const timers = fakeTimers();
    const res = await run(recipeRepo(VALID), ["--setup-minutes", "5"], {
      timers,
      fetch: streamingFetch({
        then: (controller, init) => {
          timers.fire(5 * MINUTE);
          controller.error(init.signal.reason ?? new DOMException("aborted", "AbortError"));
        },
      }),
    });
    assert.equal(res.code, 3, res.text);
    assert.match(res.out, /Stopped: wall clock \(the setup phase's 5-minute limit\)/);
    assert.doesNotMatch(res.text, /FAILED/);
  });

  it("names a body that times out as a failed grounding fetch", async () => {
    const res = await run(recipeRepo(VALID), [], {
      fetch: streamingFetch({
        then: (controller) =>
          controller.error(new DOMException("The operation timed out.", "TimeoutError")),
      }),
    });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /FAILED {2}grounding\[0\]: could not fetch https:\/\/example\.com\/framework-security\.md: The operation timed out\./,
    );
  });

  it("stops reading a body with no content-length once it passes the size cap", async () => {
    const pulls = { n: 0 };
    const res = await run(recipeRepo(VALID), [], { fetch: streamingFetch({ chunks: 40, pulls }) });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /FAILED {2}grounding\[0\]: .*larger than 10 MiB/);
    assert.ok(pulls.n <= 12, `read ${pulls.n} chunks of 1 MiB`);
  });
});

describe("review fixes: the repository export has its own size limit, named when it is passed", () => {
  /** Run deep-scan on a gVisor host with `spawn` wrapping the host's blocking spawn. */
  async function runWrapped(wrap) {
    const host = gvisorHost();
    const calls = [];
    const err = [];
    const code = await main(["deep-scan", "--proving-run"], {
      cwd: recipeRepo(VALID),
      stdout: () => {},
      stderr: (s) => err.push(s),
      spawn: wrap(spawnFor(host, calls)),
      spawnAsync: spawnAsyncFor(host, calls),
      platform: host.platform,
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: REAL_KEY },
      fetch: groundingFetch,
      signals: new EventEmitter(),
      reportDir: mkdtempSync(join(tmp, "report-")),
      modelApi: "http://127.0.0.1:9",
      timers: fakeTimers(),
    });
    return { code, err: err.join("\n") };
  }
  const isArchive = (cmd, args) => cmd === "git" && args.includes("archive");

  it("gives git archive a buffer larger than the runner's default 64 MiB", async () => {
    const seen = [];
    const res = await runWrapped((inner) => (cmd, args, opts) => {
      if (isArchive(cmd, args)) seen.push(opts.maxBuffer);
      return inner(cmd, args, opts);
    });
    assert.equal(res.code, 0, res.err);
    assert.ok(seen.length > 0, "git archive ran");
    for (const size of seen) assert.ok(size > 64 * 1024 * 1024, `maxBuffer ${size}`);
  });

  it("names the limit when an export passes it", async () => {
    const res = await runWrapped(
      (inner) => (cmd, args, opts) =>
        isArchive(cmd, args)
          ? { error: Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS" }) }
          : inner(cmd, args, opts),
    );
    assert.equal(res.code, 1, res.err);
    assert.match(
      res.err,
      /FAILED {2}export main \([0-9a-f]{12}\): the export is larger than \d+ MiB/,
    );
    assert.doesNotMatch(res.err, /ENOBUFS/);
  });
});

describe("review fixes: the setup proxy sends its own Host and none of the client's proxy headers", () => {
  it("sets Host from the allowed URL and drops proxy and hop-by-hop headers", async () => {
    const seen = [];
    const upstream = createHttpServer((req, res) => {
      seen.push(req.headers);
      res.end("ok");
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = upstream.address().port;
    const proxy = await startEgressProxy({ registries: [`127.0.0.1:${port}`], bind: "127.0.0.1" });
    try {
      const status = await new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: proxy.port,
            path: `http://127.0.0.1:${port}/x`,
            headers: {
              host: "attacker.example",
              "proxy-authorization": "Basic c2VjcmV0",
              "proxy-connection": "keep-alive",
              "x-hop": "1",
              connection: "close, X-Hop",
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].host, `127.0.0.1:${port}`);
      assert.equal(seen[0]["proxy-authorization"], undefined);
      assert.equal(seen[0]["proxy-connection"], undefined);
      assert.equal(seen[0]["x-hop"], undefined);
    } finally {
      await proxy.close();
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
});

describe("review fixes: the model proxy checks the decoded path", () => {
  it("refuses a percent-encoded path to an uncounted endpoint, and a path that does not decode", async () => {
    const api = await fakeModelApi();
    const proxy = await startModelProxy({
      credential: REAL_KEY,
      bind: "127.0.0.1",
      upstream: api.url,
    });
    try {
      for (const path of [
        "/v1/%6dessages/batches",
        "/v1/messages/%62atches",
        "/v1/%63omplete",
        "/v1/%256dessages/batches",
        "/v1/messages%E0%A4%A",
        "/%761/messages",
        "/v1//messages/batches",
        "/v1/messages//batches",
        "/v1//complete",
        "/v1/messages/",
      ]) {
        const answer = await rawRequest(
          proxy.port,
          `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
        );
        assert.match(answer, /^HTTP\/1\.1 403/, path);
      }
      assert.equal(api.seen.length, 0);
    } finally {
      await proxy.close();
      await api.close();
    }
  });
});

describe("review fixes: Docker Sandboxes checks the report inside the sandbox before copying it out", () => {
  for (const [status, why] of [
    [4, /not a regular file/],
    [5, /larger than/],
  ]) {
    it(`does not copy out a report the in-sandbox check refuses (exit ${status})`, async () => {
      const host = sbxHost({ "~wc -c": { status } });
      const res = await run(recipeRepo(VALID), [], { host });
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, why);
      assert.ok(
        !sbxCalls(res).some(
          (a) => a.includes("cp") && a.some((x) => /:\/agent-kit\/out\//.test(x)),
        ),
        "no sbx cp of the report",
      );
    });
  }
});

describe("review fixes: an inherited property name is not a command", () => {
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    it(`agent-kit ${name} is an unknown command, exit 2`, async () => {
      const err = [];
      const code = await main([name], {
        cwd: tmp,
        stdout: () => {},
        stderr: (s) => err.push(s),
      });
      assert.equal(code, 2);
      assert.match(err.join("\n"), new RegExp(`Unknown command: ${name}`));
    });
  }
});

describe("review fixes: the docs' hand-typed lists match the code they copy", () => {
  const page = (path) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
  const audit = page("docs/security-audit.md");
  const cliReadme = page("cli/README.md");
  /** `a`, `b` or `c`, as the docs write a list of code words. */
  const codeList = (items, conjunction) =>
    `${items
      .slice(0, -1)
      .map((i) => `\`${i}\``)
      .join(", ")} ${conjunction} \`${items.at(-1)}\``;

  it("the Limits table and the Scan recipe field table are Generated blocks", () => {
    for (const fact of ["deep-scan-limits", "deep-scan-recipe-fields"]) {
      assert.ok(audit.includes(`<!-- generated:${fact} -->`), fact);
      assert.ok(audit.includes(`<!-- /generated:${fact} -->`), fact);
    }
  });

  it("the credential variables the launcher strips", () => {
    const listed = `(${CREDENTIAL_VARS.map((v) => `\`${v}\``).join(", ")} and the one you name)`;
    assert.ok(audit.includes(listed), `docs/security-audit.md lists ${listed}`);
  });

  it("the agent's tools, and the web tools it does not have", () => {
    assert.ok(
      audit.includes(
        `Its tools are ${AGENT_TOOLS.slice(0, -1).join(", ")} and ${AGENT_TOOLS.at(-1)}, pre-approved`,
      ),
      `docs/security-audit.md names the tools ${AGENT_TOOLS.join(", ")}`,
    );
    assert.ok(audit.includes(`${WEB_TOOLS.join(" and ")} are not in its tool set`));
  });

  it("the .env templates the pre-flight lets through", () => {
    const listed = `Templates (${ENV_TEMPLATES.map((t) => `\`.env.${t}\``).join(", ")})`;
    assert.ok(audit.includes(listed), `docs/security-audit.md lists ${listed}`);
  });

  it("deep-scan's process allowlist, and the other commands'", () => {
    const sentence =
      /Its process allowlist is (.*?); `init`, `upgrade` and `doctor` still run only `git` and `gh`\./.exec(
        cliReadme,
      );
    assert.ok(sentence, "cli/README.md states the allowlist");
    const named = [...sentence[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.deepEqual(named.toSorted(), [...allowedCommands("deep-scan")].toSorted());
    for (const command of ["init", "upgrade", "doctor"]) {
      assert.deepEqual([...allowedCommands(command)].toSorted(), ["gh", "git"]);
    }
  });

  it("the deep-scan Caller's secrets, in getting-started.md's secrets table", () => {
    const caller = page("examples/deep-scan-caller.yml");
    const secrets = [...caller.matchAll(/secrets\.(AGENT_KIT_DEEP_SCAN_[A-Z0-9_]+)/g)].map(
      (m) => m[1],
    );
    assert.ok(secrets.length >= 2, "the Caller names its secrets");
    const started = page("docs/getting-started.md");
    for (const name of secrets) {
      assert.match(started, new RegExp(`^\\| \`${name}\` +\\| deep scan`, "m"), name);
    }
  });

  it("the effort levels, wherever they are listed", () => {
    const levels = codeList(EFFORTS, "or");
    for (const [path, text] of [
      ["docs/security-audit.md", audit],
      ["cli/README.md", cliReadme],
      ["docs/getting-started.md", page("docs/getting-started.md")],
    ]) {
      assert.ok(text.includes(levels), `${path} lists the effort levels as ${levels}`);
    }
  });

  it("the default limits cli/README.md restates, and the longest minutes value", () => {
    for (const [flag, value] of [
      ["--setup-minutes <n>", DEFAULT_LIMITS.setupMinutes],
      ["--scan-minutes <n>", DEFAULT_LIMITS.scanMinutes],
      ["--max-turns <n>", DEFAULT_LIMITS.turns],
      ["--max-tokens <n>", DEFAULT_LIMITS.tokens],
    ]) {
      assert.ok(cliReadme.includes(`(\`${flag}\`, default ${value}`), `cli/README.md: ${flag}`);
    }
    assert.ok(
      cliReadme.includes(
        `Its defaults are scan ${VERIFY_LIMITS.scanMinutes} min, ${VERIFY_LIMITS.turns} turns`,
      ),
      "cli/README.md: the Verification run's defaults",
    );
    assert.ok(audit.includes(`of at most ${MAX_MINUTES} (about 24 days`));
    assert.ok(
      audit.includes(
        `scan wall clock ${VERIFY_LIMITS.scanMinutes} min and ${VERIFY_LIMITS.turns} turns, with the same setup wall clock and token cap`,
      ),
      "docs/security-audit.md: the Verification run's limits",
    );
    assert.equal(MAX_EXPORT_BYTES, 1024 ** 3, "docs/security-audit.md says 1 GiB");
    assert.ok(audit.includes("so one larger than 1 GiB ends the run"));
    assert.ok(
      audit.includes(`(each URL at most ${MAX_GROUNDING_BYTES / 1024 / 1024} MiB)`),
      "docs/security-audit.md: the grounding URL cap",
    );
    assert.equal(VERIFY_LIMITS.setupMinutes, DEFAULT_LIMITS.setupMinutes);
    assert.equal(VERIFY_LIMITS.tokens, DEFAULT_LIMITS.tokens);
  });
});
