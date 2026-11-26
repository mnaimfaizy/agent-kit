// Contract for `agent-kit deep-scan` (cli/): the launcher's limits, the Stopped: line and the CI path.
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { agentScript, TURNS_MARKER } from "../cli/src/deep-scan/agent.mjs";
import { withStopped } from "../cli/src/deep-scan/limits.mjs";
import { tarOf } from "../cli/src/deep-scan/tar.mjs";
import {
  VALID,
  tmp,
  n,
  nextId,
  REAL_KEY,
  REPORT_TEXT,
  reportTar,
  COPY_OUT,
  run,
  fakeTimers,
  recipeRepo,
  recipe,
  lifecycle,
  verb,
  isAgentStep,
  removed,
  gvisorWith,
  sbxCalls,
  sbxHost,
  fakeModelApi,
  agentCall,
  claudeLine,
  modelProbes,
  MINUTE,
  HEADER_REPORT,
  reportOf,
  reportingHost,
  fireOn,
  answeringApi,
  cappedProxy,
  USAGE_ALL,
} from "./cli-deep-scan-fixtures.mjs";

describe("limits come from launcher flags, with defaults, and never from the recipe", () => {
  it("runs with the default limits: setup 20 min, scan 60 min, 200 turns, 5,000,000 tokens", async () => {
    const timers = fakeTimers();
    const res = await run(recipeRepo(VALID), [], { timers });
    assert.equal(res.code, 0, res.text);
    assert.match(claudeLine(agentCall(lifecycle(res))), / --max-turns 200 /);
    assert.deepEqual(
      timers.set.map((t) => t.ms),
      [20 * MINUTE, 60 * MINUTE],
    );
    assert.deepEqual(timers.pending(), [], "every clock is cleared when the run ends");
    assert.match(
      res.out,
      /Limits: setup 20 min, scan 60 min, 200 turns, 5000000 tokens \(raise them with --setup-minutes, --scan-minutes, --max-turns, --max-tokens\)\./,
    );
    assert.match(res.out, /Model proxy: .*; counted 0 of the 5000000-token cap/);
  });

  it("takes each limit from its flag", async () => {
    const timers = fakeTimers();
    const res = await run(
      recipeRepo(VALID),
      [
        "--setup-minutes",
        "30",
        "--scan-minutes",
        "90.5",
        "--max-turns",
        "400",
        "--max-tokens",
        "8000000",
      ],
      { timers },
    );
    assert.equal(res.code, 0, res.text);
    assert.match(claudeLine(agentCall(lifecycle(res))), / --max-turns 400 /);
    assert.deepEqual(
      timers.set.map((t) => t.ms),
      [30 * MINUTE, 90.5 * MINUTE],
    );
    assert.match(res.out, /Limits: setup 30 min, scan 90\.5 min, 400 turns, 8000000 tokens/);
  });

  for (const [flag, value] of [
    ["--setup-minutes", "0"],
    ["--scan-minutes", "-5"],
    ["--scan-minutes", "abc"],
    ["--setup-minutes", "1e3"],
    ["--max-turns", "1.5"],
    ["--max-turns", "0"],
    ["--max-tokens", "5M"],
    ["--max-tokens", ""],
    ["--max-tokens", "Infinity"],
    // Past what a timer can hold (2^31 - 1 ms), which would fire at once.
    ["--scan-minutes", "40000"],
  ]) {
    it(`refuses ${flag} ${JSON.stringify(value)} as a usage error, before anything runs`, async () => {
      // `=` so that a value starting with "-" is the flag's, not an option.
      const res = await run(recipeRepo(VALID), [`${flag}=${value}`]);
      assert.equal(res.code, 2, res.text);
      assert.match(res.err, new RegExp(`${flag} must be a positive`));
      assert.equal(res.calls.length, 0, "nothing ran");
    });
  }

  it("still refuses a limit field in the recipe, naming the flags' route", async () => {
    const res = await run(recipeRepo(recipe({ add: "max_turns: 900" })));
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /max_turns.*the recipe holds no limits/);
    assert.equal(lifecycle(res).length, 0);
  });

  it("names the limit flags in --help", async () => {
    const res = await run(recipeRepo(VALID), ["--help"]);
    for (const flag of ["--setup-minutes", "--scan-minutes", "--max-turns", "--max-tokens"]) {
      assert.ok(res.out.includes(flag), `--help names ${flag}`);
    }
  });
});

describe("a limit that fires stops the run, marks the report Stopped:, and still tears down", () => {
  it("the scan wall clock: stops the agent step, copies out its report with Stopped: wall clock, exits 3", async () => {
    const timers = fakeTimers();
    const res = await run(recipeRepo(VALID), [], {
      host: reportingHost({ "~set -eu": { hang: true } }),
      timers,
      onSpawn: fireOn(timers, 60 * MINUTE, (cmd, args) => cmd === "docker" && isAgentStep(args)),
    });
    assert.equal(res.code, 3, res.text);
    assert.match(res.err, /Stopped: wall clock \(the scan phase's 60-minute limit\)\. Stopping/);
    assert.ok(
      reportOf(res).includes("- **Finding count:** 1\n- **Stopped:** wall clock\n\n### F1"),
      reportOf(res),
    );
    assert.match(res.out, /Report: .*report\.md \(.*partial: marked Stopped: wall clock\)/);
    assert.doesNotMatch(res.text, /FAILED|The agent step exited/);
    assert.deepEqual(removed(lifecycle(res)).map(verb), [
      "rm",
      "rm",
      "rm",
      "rm",
      "rm",
      "rm",
      "image",
      "network rm",
      "network rm",
      "image",
    ]);
    assert.deepEqual(timers.pending(), []);
  });

  it("the setup wall clock: stops the setup step, runs no agent, writes no report, names the limit, exits 3", async () => {
    const timers = fakeTimers();
    const res = await run(recipeRepo(VALID), ["--setup-minutes", "5"], {
      host: gvisorWith({ "~npm ci": { hang: true } }),
      timers,
      onSpawn: fireOn(timers, 5 * MINUTE, (cmd, args) => args.at(-1) === "npm ci"),
    });
    assert.equal(res.code, 3, res.text);
    assert.match(
      res.out,
      /Stopped: wall clock \(the setup phase's 5-minute limit\)\. No report came out: nothing was written, filed or posted\./,
    );
    assert.ok(!lifecycle(res).some(isAgentStep), "no agent step");
    assert.deepEqual(readdirSync(res.reportDir), [], "no report file");
    assert.doesNotMatch(res.text, /FAILED/);
    assert.deepEqual(removed(lifecycle(res)).map(verb), [
      "rm",
      "rm",
      "rm",
      "image",
      "network rm",
      "network rm",
      "image",
    ]);
    assert.deepEqual(timers.pending(), []);
  });

  it("the turn limit: Claude Code's turn signal marks the report Stopped: turns, exits 3", async () => {
    const res = await run(recipeRepo(VALID), ["--max-turns", "7"], {
      host: reportingHost({
        "~set -eu": {
          status: 1,
          stdout: "agent-kit-deep-scan: Claude Code reached its turn limit\n",
          stderr: "Error: Reached max turns (7)\n",
        },
      }),
    });
    assert.equal(res.code, 3, res.text);
    assert.match(res.out, /Stopped: turns \(Claude Code's 7-turn limit\)\. Copying out/);
    assert.ok(reportOf(res).includes("- **Finding count:** 1\n- **Stopped:** turns\n"));
    assert.doesNotMatch(res.text, /The agent step exited/);
    assert.equal(removed(lifecycle(res)).length, 10);
  });

  it("the agent script prints the turn signal only from Claude Code's error output", async () => {
    const res = await run(recipeRepo(VALID), ["--max-turns", "7"]);
    assert.match(claudeLine(agentCall(lifecycle(res))), / --max-turns 7 /);
  });

  // The script itself, run by a real sh with a fake claude on PATH and the
  // sandbox's paths moved into a temporary folder.
  const sh = spawnSync("sh", ["-c", "exit 0"]).status === 0;
  const runScript = (claude) => {
    const dir = mkdtempSync(join(tmp, "script-")).replace(/\\/g, "/");
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "workspace"));
    mkdirSync(join(dir, "agent-kit", "in"), { recursive: true });
    writeFileSync(join(dir, "agent-kit", "in", "brief.md"), "the brief\n");
    writeFileSync(join(dir, "bin", "claude"), `#!/bin/sh\n${claude}\n`, { mode: 0o755 });
    const script = agentScript({
      baseUrl: "http://127.0.0.1:1",
      report: "/agent-kit/out/report.md",
      workspace: "/workspace",
      maxTurns: 7,
    })
      .replaceAll("/agent-kit/", `${dir}/agent-kit/`)
      .replaceAll("/workspace", `${dir}/workspace`);
    const r = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}/bin${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
        LOGS: `${dir}/agent-kit/logs`,
      },
    });
    return { ...r, dir };
  };

  it(
    "passes Claude Code's own error output on, keeps its exit, and prints the turn signal from it",
    { skip: !sh && "no sh" },
    () => {
      const r = runScript(
        'cat > /dev/null; echo "the final answer"; echo "Error: Reached max turns (7)" >&2; exit 1',
      );
      assert.equal(r.status, 1, r.stderr);
      assert.equal(r.stdout, `${TURNS_MARKER}\n`);
      assert.equal(r.stderr, "Error: Reached max turns (7)\n");
      assert.equal(
        readFileSync(join(r.dir, "agent-kit", "logs", "agent.log"), "utf8"),
        "the final answer\n",
      );
    },
  );

  it(
    "prints no turn signal from the agent's answer, and nothing the agent writes to the log files",
    { skip: !sh && "no sh" },
    () => {
      // The agent can write the log files from Bash, and its answer is its own.
      const r = runScript(
        'cat > /dev/null; echo "Error: Reached max turns (7)"; echo "planted by the agent, longer than what Claude Code says" >> "$LOGS/agent.err"; echo "Claude Code says" >&2; exit 0',
      );
      assert.equal(r.stdout.includes(TURNS_MARKER), false, r.stdout);
      assert.doesNotMatch(r.stderr, /planted/);
      assert.equal(r.stderr, "Claude Code says\n");
      assert.equal(r.status, 0);
    },
  );

  it("the token cap: the proxy refuses past it, the agent step stops, the report is marked Stopped: tokens", async () => {
    const api = await fakeModelApi();
    try {
      // Each answer reports 3 + 5 tokens: the second crosses a cap of 10.
      const res = await run(recipeRepo(VALID), ["--max-tokens", "10"], {
        host: reportingHost({ "~--bare": { status: 0, model: 3 } }),
        modelApi: api.url,
      });
      assert.equal(res.code, 3, res.text);
      assert.equal(api.seen.length, 2, "the request past the cap never reached the model API");
      assert.deepEqual(modelProbes(res.host).slice(0, 2), [
        ["messages", 200],
        ["messages", 200],
      ]);
      assert.match(res.err, /Stopped: tokens \(the run's 10-token cap\)/);
      assert.match(res.out, /counted 16 of the 10-token cap, and refused 1 request\(s\) past it/);
      assert.ok(reportOf(res).includes("- **Finding count:** 1\n- **Stopped:** tokens\n"));
      assert.equal(removed(lifecycle(res)).length, 10);
    } finally {
      await api.close();
    }
  });

  it("a stop with no report: only a status naming the limit, no report file, exit 3", async () => {
    const timers = fakeTimers();
    const res = await run(recipeRepo(VALID), [], {
      host: gvisorWith({
        "~set -eu": { hang: true },
        [COPY_OUT]: {
          status: 1,
          stderr: "Error response from daemon: Could not find the file /agent-kit/out/report.md\n",
        },
      }),
      timers,
      onSpawn: fireOn(timers, 60 * MINUTE, (cmd, args) => cmd === "docker" && isAgentStep(args)),
    });
    assert.equal(res.code, 3, res.text);
    assert.match(
      res.out,
      /Stopped: wall clock \(the scan phase's 60-minute limit\)\. No report came out: nothing was written, filed or posted\./,
    );
    assert.deepEqual(readdirSync(res.reportDir), []);
    assert.doesNotMatch(res.text, /FAILED|Report: /);
    assert.equal(removed(lifecycle(res)).length, 10);
  });

  it("removes a Stopped: line the agent wrote itself, when no limit fired", async () => {
    const forged = HEADER_REPORT.replace(
      "- **Finding count:** 1\n",
      "- **Finding count:** 1\n- **Stopped:** tokens\n",
    );
    const res = await run(recipeRepo(VALID), [], {
      host: gvisorWith({ [COPY_OUT]: { status: 0, base64: reportTar(forged) } }),
    });
    assert.equal(res.code, 0, res.text);
    assert.equal(reportOf(res), HEADER_REPORT);
  });

  it("on Docker Sandboxes too: the scan wall clock stops the agent step, and the sandbox is removed", async () => {
    const timers = fakeTimers();
    const res = await run(recipeRepo(VALID), [], {
      host: sbxHost({ "~--bare": { hang: true } }),
      timers,
      onSpawn: fireOn(
        timers,
        60 * MINUTE,
        (cmd, args) =>
          cmd === "sbx" && args.some((a) => typeof a === "string" && a.includes("--bare")),
      ),
    });
    assert.equal(res.code, 3, res.text);
    assert.ok(reportOf(res).includes("- **Stopped:** wall clock"), reportOf(res));
    assert.ok(
      sbxCalls(res).some((a) => a[0] === "rm"),
      "the sandbox is removed",
    );
  });
});

describe("the Stopped: line goes where report-format.md puts it", () => {
  const at = (text, limit) => withStopped(Buffer.from(text, "latin1"), limit).toString("latin1");

  it("keeps CRLF line ends", () => {
    const crlf = HEADER_REPORT.replace(/\n/g, "\r\n");
    assert.ok(at(crlf, "turns").includes("- **Finding count:** 1\r\n- **Stopped:** turns\r\n"));
  });

  it("goes after the heading when the agent wrote no Finding count yet, and first when it wrote no heading", () => {
    assert.equal(
      at("## Security audit report\n\n- **Mode:** deep\n", "tokens"),
      "## Security audit report\n\n- **Stopped:** tokens\n\n- **Mode:** deep\n",
    );
    assert.equal(at("notes so far\n", "wall clock"), "- **Stopped:** wall clock\n\nnotes so far\n");
  });

  it("leaves every other byte alone, even bytes that are not UTF-8", () => {
    const bytes = Buffer.concat([Buffer.from(HEADER_REPORT), Buffer.from([0xff, 0xfe, 0x0a])]);
    const out = withStopped(bytes, "turns");
    assert.equal(out.length, bytes.length + "- **Stopped:** turns\n".length);
    assert.deepEqual(out.subarray(-3), Buffer.from([0xff, 0xfe, 0x0a]));
    assert.equal(withStopped(bytes, null), bytes, "no limit and no forged line: the same bytes");
  });
});

describe("the model proxy holds the token cap, counting the model API's returned usage", () => {
  it("counts input, output, cache-creation and cache-read tokens from a JSON answer", async () => {
    const api = await answeringApi((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", usage: USAGE_ALL }));
    });
    const { proxy, post } = await cappedProxy(api, 1000);
    try {
      assert.equal((await post()).status, 200);
      assert.equal((await post()).status, 200);
      assert.equal(proxy.tokens(), 200);
      // The proxy asks for a plain body, whatever the sandbox asked for.
      assert.equal(api.seen[0].headers["accept-encoding"], "identity");
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it("counts a stream's usage once: message_start's, then message_delta's cumulative output", async () => {
    const api = await answeringApi((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const start = JSON.stringify({
        type: "message_start",
        message: {
          usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 },
        },
      });
      // Lines split across writes, as a network splits them.
      res.write(`event: message_start\ndata: ${start.slice(0, 20)}`);
      setTimeout(() => {
        res.write(
          `${start.slice(20)}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":12}}\n\n`,
        );
        res.end(
          `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n`,
        );
      }, 5);
    });
    const { proxy, post } = await cappedProxy(api, 1000);
    try {
      assert.equal((await post()).status, 200);
      assert.equal(proxy.tokens(), 10 + 5 + 30);
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it("counts a compressed answer too, though it asked for none", async () => {
    const api = await answeringApi((req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(JSON.stringify({ usage: USAGE_ALL })));
    });
    const { proxy, post } = await cappedProxy(api, 1000);
    try {
      await post();
      assert.equal(proxy.tokens(), 100);
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it("delivers the answer that crosses the cap, then refuses every request, telling the launcher once", async () => {
    const api = await answeringApi((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: USAGE_ALL }));
    });
    const { proxy, capped, post } = await cappedProxy(api, 150);
    try {
      assert.equal((await post()).status, 200); // 100 counted
      assert.equal((await post()).status, 200); // 200: past the cap, delivered
      assert.equal(capped.n, 0);
      const refused = await post();
      assert.equal(refused.status, 403);
      assert.deepEqual(JSON.parse(refused.text).error.type, "permission_error");
      assert.match(JSON.parse(refused.text).error.message, /token cap \(150\) is reached/);
      assert.equal((await post()).status, 403);
      assert.equal(capped.n, 1);
      assert.equal(api.seen.length, 2, "nothing past the cap reaches the model API");
      assert.match(
        proxy.summary(),
        /counted 200 of the 150-token cap, and refused 2 request\(s\) past it$/,
      );
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it("refuses the batch and legacy completion paths, whose spend no answer's usage shows", async () => {
    const api = await answeringApi((req, res) => res.writeHead(200).end("{}"));
    const { proxy, post } = await cappedProxy(api, 1000);
    try {
      for (const path of [
        "/v1/messages/batches",
        "/v1/messages/batches/x/results",
        "/v1/complete",
      ]) {
        assert.equal((await post(path)).status, 403, path);
      }
      assert.equal((await post("/v1/messages/count_tokens")).status, 200);
      assert.equal(api.seen.length, 1);
    } finally {
      await proxy.close();
      await api.close();
    }
  });
});

describe("the limits docs", () => {
  const section = (page, heading) => {
    const at = page.indexOf(`\n## ${heading}\n`);
    assert.ok(at >= 0, `the page has ## ${heading}`);
    const next = page.indexOf("\n## ", at + 1);
    return page.slice(at, next < 0 ? undefined : next);
  };

  it("give each limit, its default, its option, what enforces it, and the backstops", () => {
    const page = readFileSync(join(import.meta.dirname, "..", "docs", "security-audit.md"), "utf8");
    const text = section(page, "Limits");
    for (const fact of [
      "--setup-minutes <n>",
      "--scan-minutes <n>",
      "--max-turns <n>",
      "--max-tokens <n>",
      "20 min",
      "60 min",
      "200",
      "5,000,000",
      "never sets a limit",
      "cache-read input",
      "- **Stopped:** wall clock | turns | tokens",
      "exits 3",
      "No report came out: nothing was written, filed or posted.",
      "spend limit",
      "the proxy's token cap is the only spend lever",
      "timeout-minutes",
    ]) {
      assert.ok(text.includes(fact), `Limits says ${fact}`);
    }
  });

  it("are named by the CLI README, with every limit option", () => {
    const readme = readFileSync(join(import.meta.dirname, "..", "cli", "README.md"), "utf8");
    assert.ok(readme.includes("../docs/security-audit.md#limits"));
    for (const flag of ["--setup-minutes", "--scan-minutes", "--max-turns", "--max-tokens"]) {
      assert.ok(readme.includes(flag), `cli/README.md names ${flag}`);
    }
  });
});

describe("the CI path: the model, a known report path, and a public log", () => {
  it("passes --model on to Claude Code, and runs with Claude Code's own default without it", async () => {
    const res = await run(recipeRepo(VALID), ["--model", "claude-opus-5-5"]);
    assert.equal(res.code, 0, res.text);
    assert.match(agentCall(lifecycle(res)).at(-1), / --model claude-opus-5-5 /);
    const plain = await run(recipeRepo(VALID));
    assert.equal(plain.code, 0, plain.text);
    assert.doesNotMatch(agentCall(lifecycle(plain)).at(-1), / --model /);
  });

  it("refuses a --model that is not a plain model id, running nothing", async () => {
    for (const model of [
      "claude-opus-5-5 --dangerously-skip-permissions",
      "",
      "-x",
      "a\nb",
      "a'b",
    ]) {
      const res = await run(recipeRepo(VALID), [`--model=${model}`]);
      assert.equal(res.code, 2, `${JSON.stringify(model)}: ${res.text}`);
      assert.match(res.err, /--model must be a plain model id/);
      assert.deepEqual(res.calls, []);
    }
  });

  it("writes the report to --report's new file, and nowhere else", async () => {
    const dir = mkdtempSync(join(tmp, "ci-out-"));
    const target = join(dir, "deep-report.md");
    const res = await run(recipeRepo(VALID), ["--report", target]);
    assert.equal(res.code, 0, res.text);
    assert.equal(readFileSync(target, "utf8"), REPORT_TEXT);
    assert.deepEqual(readdirSync(res.reportDir), []);
    assert.ok(res.out.includes(`Report: ${target} (`), res.out);
  });

  it("takes a --report in a folder reached through a link, as /tmp is on macOS", async () => {
    const real = mkdtempSync(join(tmp, "ci-real-"));
    const link = join(tmp, `ci-link-${nextId()}`);
    symlinkSync(real, link, "junction");
    const res = await run(recipeRepo(VALID), ["--report", join(link, "report.md")]);
    assert.equal(res.code, 0, res.text);
    assert.equal(readFileSync(join(real, "report.md"), "utf8"), REPORT_TEXT);
  });

  it("refuses a --report that already exists or whose folder does not, before anything runs", async () => {
    const dir = mkdtempSync(join(tmp, "ci-out-"));
    const taken = join(dir, "taken.md");
    writeFileSync(taken, "earlier report\n");
    for (const [target, why] of [
      [taken, /--report .* already exists/],
      [join(dir, "missing", "report.md"), /--report .* folder .* does not exist/],
    ]) {
      const res = await run(recipeRepo(VALID), ["--report", target]);
      assert.equal(res.code, 2, res.text);
      assert.match(res.err, why);
      assert.deepEqual(res.calls, []);
    }
    assert.equal(readFileSync(taken, "utf8"), "earlier report\n");
  });

  const IN_ACTIONS = { PATH: "/usr/bin", ANTHROPIC_API_KEY: REAL_KEY, GITHUB_ACTIONS: "true" };

  it("in GitHub Actions, prints nothing the scan shaped: no agent error output, no refused host, no answer", async () => {
    const api = await fakeModelApi();
    try {
      const host = gvisorWith({
        "~--bare": {
          status: 1,
          model: true,
          stderr: "Error: secret-finding-detail at src/app.js\n",
        },
      });
      // A report folder whose random name holds `x1`, as mkdtemp can give.
      const reportDir = mkdtempSync(join(tmp, "report-x1-"));
      const res = await run(recipeRepo(VALID), [], {
        host,
        env: IN_ACTIONS,
        modelApi: api.url,
        reportDir,
      });
      assert.equal(res.code, 1, res.text);
      assert.deepEqual(modelProbes(host), [
        ["messages", 200],
        ["evil.example", 403],
      ]);
      for (const shaped of [
        "secret-finding-detail",
        "src/app.js",
        "evil.example",
        "answers:",
        "x1",
      ]) {
        // The report's path is the launcher's own line, under a random
        // folder name: only the rest of the log is checked.
        const log = res.text.replaceAll(reportDir, "<report folder>");
        assert.ok(!log.includes(shaped), `the log holds ${shaped}:\n${log}`);
      }
      assert.ok(res.out.includes(join(reportDir, "report.md")), "the report's path is printed");
      // What the launcher itself says still prints: the exit, the report, the teardown.
      assert.match(res.err, /The agent step exited 1/);
      assert.match(res.err, /Public-log rule/);
      assert.match(res.out, /Model proxy: closed/);
      assert.match(res.out, /Report: .*report\.md/);
      assert.match(res.out, /Teardown: removed/);
    } finally {
      await api.close();
    }
  });

  it("in GitHub Actions, gives no detail when the report cannot be copied out", async () => {
    const link = tarOf([{ path: "report.md", data: Buffer.from("") }]);
    link[156] = "2".charCodeAt(0);
    const host = gvisorWith({
      [COPY_OUT]: { status: 0, base64: link.toString("base64") },
    });
    const res = await run(recipeRepo(VALID), [], { host, env: IN_ACTIONS });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /FAILED {2}the report was not copied out/);
    assert.doesNotMatch(res.text, /tar type|regular file/);
  });

  it("in GitHub Actions, still prints a failed setup step's own output, from before any probing", async () => {
    const host = gvisorWith({ "~npm ci": { status: 1, stderr: "npm ERR! missing script\n" } });
    const res = await run(recipeRepo(VALID), [], { host, env: IN_ACTIONS });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /npm ERR! missing script/);
  });

  it("in GitHub Actions, says the workflow delivers the report, not the by-hand rule", async () => {
    const res = await run(recipeRepo(VALID), [], { env: IN_ACTIONS });
    assert.equal(res.code, 0, res.text);
    assert.match(res.out, /Nothing was filed or posted by deep-scan/);
    assert.doesNotMatch(res.out, /by-hand rule/);
  });
});
