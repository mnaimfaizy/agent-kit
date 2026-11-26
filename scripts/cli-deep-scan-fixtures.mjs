// Shared fixtures for the `agent-kit deep-scan` contract suites
// (scripts/cli-deep-scan-*.test.mjs). The suites are split by theme so
// `node --test` runs them in parallel; this module holds what they share.
//
// Contract for `agent-kit deep-scan` (cli/): finding the Consumer's Scan
// recipe at the trusted ref (the default branch's tip, never the working
// tree), validating it, and refusing with a pointer to the docs when it is
// missing or invalid; then the pre-flight refusals (a GitHub token in the
// environment, a .env the copy-in would carry wholesale) and the choice of a
// sandbox runtime from the host, or its refusal; then the sandbox lifecycle
// on that runtime, from image to teardown. git runs for real against local
// fixture repositories (no network). The sandbox runtimes' CLIs (`sbx`,
// `docker`, `runsc`, `kata-runtime`, `firecracker`) are fake, behind the CLI's
// real process allowlist, each call recorded with its arguments and stdin,
// and answered in process (a real child per fake call made the suites slow on
// Windows, where a process start costs ~100 ms). The grounding
// fetch and the interrupt signals are injected too. No real runtime, and no
// network outside 127.0.0.1, is ever reached.

import assert from "node:assert/strict";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { PassThrough, Writable } from "node:stream";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect as connectNet } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before } from "node:test";
import { main } from "../cli/src/cli.mjs";
import { systemRunner } from "../cli/src/exec.mjs";
import { startModelProxy } from "../cli/src/deep-scan/model-proxy.mjs";
import { tarOf } from "../cli/src/deep-scan/tar.mjs";

export const GIT_ID = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@example.com",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
];

export function git(cwd, ...args) {
  const r = systemRunner("git", ["-C", cwd, ...GIT_ID, ...args]);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export function writeTree(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

export const DOCS = /docs\/security-audit\.md#scan-recipe/;

/** A recipe every check accepts: a web app with services and a CLI entry point. */
export const VALID = `# Scan recipe
image: node:22-bookworm
setup:
  - npm ci
registries:
  - registry.npmjs.org
start:
  - npm run start &
ready:
  - curl --fail http://localhost:3000/health
seed:
  - npm run seed
entry_points:
  - url: http://localhost:3000/
    note: The web app, signed in or not.
  - port: 5432
    note: Postgres, reachable only from inside the sandbox.
  - command: node bin/cli.js
    note: The CLI, run with any arguments.
fixtures:
  - user: alice
    password: fake-password-1
    role: admin
grounding:
  - https://example.com/framework-security.md
notes:
  - The GitHub workflows stay static-only.
`;

export let tmp;
export let n = 0;
/** The next fixture number, for a folder name no other fixture takes. */
export const nextId = () => n++;

/**
 * What a Consumer that adopted the audit flow has committed: the
 * security-audit skill and the Threat pack at its default paths. Each file
 * holds a marker, so a test can see it handed to the agent.
 */
export const ADOPTED = {
  ".claude/skills/security-audit/SKILL.md": "# security-audit SKILL marker\n",
  ".claude/skills/security-audit/DEEP.md": "# Deep scan procedure marker\n",
  ".claude/skills/security-audit/report-format.md": "# report-format marker\n",
  ".security/threat-model.md": "# Threat model marker\n",
  ".security/findings-ledger.md": "# Findings ledger marker\n",
};

/**
 * A fixture repository on branch `main` with `committed` committed (over the
 * adopted audit flow's files, unless `adopted` is false), then `working`
 * written over it uncommitted.
 */
export function makeRepo({ committed = {}, working = {}, branch = "main", adopted = true } = {}) {
  const dir = join(tmp, `repo-${n++}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", branch);
  writeTree(dir, { "README.md": "app\n", ...(adopted ? ADOPTED : {}), ...committed });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  writeTree(dir, working);
  return dir;
}

// The fake runtime CLIs. Each host is a folder of `<cli>.json` files, one per
// installed CLI, giving that CLI's answers; a CLI with no file is not
// installed. Every call is recorded to calls.jsonl in the host folder, with
// a file holding its stdin when it had any.
//
// An answer maps the call's arguments, joined by spaces, to a reply: an exact
// match, else a "~substring" key, else the longest prefix key, else "*". A
// reply gives `status`, `stdout` (or `base64` for bytes) and `stderr`; `hang`
// makes the call print "started" and run until killed; `probe` makes it
// CONNECT to that host:port through the HTTPS_PROXY its arguments set, and
// record the proxy's answer to probes.jsonl.
//
// Both runners are injected spawns behind the real allowlist, answered in
// process: the blocking runner by `fakeSpawnSync` (the shape `spawnSync`
// returns), the non-blocking runner, which drives the sandbox lifecycle's
// many steps, by `fakeChild`.
export function replyFor(answer, joined) {
  const keys = Object.keys(answer);
  const sub = keys.find((k) => k.startsWith("~") && joined.includes(k.slice(1)));
  const prefix = keys
    .filter((k) => !k.startsWith("~") && k !== "*" && joined.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return answer[joined] ?? answer[sub] ?? answer[prefix] ?? answer["*"] ?? { status: 0 };
}

/** A blocking fake CLI call, as `spawnSync` with `encoding: "buffer"` returns it. */
export function fakeSpawnSync(host, cmd, args, opts) {
  appendFileSync(join(host.dir, "calls.jsonl"), `${JSON.stringify([cmd, ...args])}\n`);
  const answer = JSON.parse(readFileSync(join(host.dir, `${cmd}.json`), "utf8"));
  const reply = replyFor(answer, args.join(" "));
  const stdout = Buffer.from(reply.stdout ?? "");
  const stderr = Buffer.from(reply.stderr ?? "");
  if (opts.maxBuffer !== undefined && stdout.length > opts.maxBuffer) {
    const error = Object.assign(new Error(`spawnSync ${cmd} ENOBUFS`), { code: "ENOBUFS" });
    return { error, status: null, stdout, stderr };
  }
  return { status: reply.status ?? 0, stdout, stderr };
}

export let stdinFiles = 0;

/** An in-process child process for a fake CLI call, answering as `fakeSpawnSync` does. */
export function fakeChild(host, cmd, args, cwd) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const input = [];
  let timer = null;
  let closed = false;
  const close = (status, signal) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    let open = 2;
    const done = () => {
      if (--open === 0) child.emit("close", status, signal);
    };
    child.stdout.once("end", done);
    child.stderr.once("end", done);
    child.stdout.end();
    child.stderr.end();
  };
  child.kill = (signal = "SIGTERM") => {
    close(null, signal);
    return true;
  };
  const respond = async () => {
    const record = [cmd, ...args];
    if (input.length) {
      const file = `stdin-${stdinFiles++}.bin`;
      writeFileSync(join(host.dir, file), Buffer.concat(input));
      record.push({ stdin: file });
    }
    // `sbx cp <local> <sandbox>:<path>`: keep the bytes of the local file,
    // which is relative to the call's folder.
    const cp = args.indexOf("cp");
    if (cmd === "sbx" && cp >= 0 && cwd && existsSync(join(cwd, args[cp + 1]))) {
      const file = `copied-${stdinFiles++}.bin`;
      writeFileSync(join(host.dir, file), readFileSync(join(cwd, args[cp + 1])));
      record.push({ stdin: file });
    }
    appendFileSync(join(host.dir, "calls.jsonl"), `${JSON.stringify(record)}\n`);
    const answer = JSON.parse(readFileSync(join(host.dir, `${cmd}.json`), "utf8"));
    const reply = replyFor(answer, args.join(" "));
    // `writes` puts entries in the call's folder: { name, text }, { name,
    // dir: true } or { name, link }, as `sbx cp <sandbox>:<path> .` would.
    for (const w of reply.writes ?? []) {
      const at = join(cwd, w.name);
      if (w.dir) mkdirSync(at);
      else if (w.link) symlinkSync(w.link, at);
      else writeFileSync(at, w.text);
    }
    if (reply.probe) {
      const env = args.find((a) => a.startsWith("HTTPS_PROXY="));
      const proxy = env ? new URL(env.slice("HTTPS_PROXY=".length)) : null;
      if (proxy) proxy.hostname = "127.0.0.1";
      const status = proxy
        ? await new Promise((resolve) => {
            const req = httpRequest({
              host: proxy.hostname,
              port: proxy.port,
              method: "CONNECT",
              path: reply.probe,
            });
            req.on("connect", (res, socket) => {
              socket.destroy();
              resolve(res.statusCode);
            });
            req.on("error", (e) => resolve(`error ${e.code}`));
            req.end();
          })
        : "no proxy";
      appendFileSync(join(host.dir, "probes.jsonl"), `${JSON.stringify([reply.probe, status])}\n`);
    }
    if (reply.selfIsTarget !== undefined) {
      // The probe was handed a target at its own address: report that as
      // its own, as a probe whose address Docker reused would.
      const targets = args.slice(args.indexOf("probe") + 1);
      reply.stdout = probeOut(reply.results, [targets[reply.selfIsTarget * 2]]);
    }
    if (reply.templates) reply.stdout = templateList(host);
    if (reply.model) await playAgent(host, args, reply.model);
    if (closed) return;
    if (reply.killedBy) {
      close(null, reply.killedBy);
      return;
    }
    if (reply.hang) {
      // The timer first: a listener may kill the child inside the write.
      timer = setInterval(() => {}, 1000);
      child.stdout.write("started\n");
      return;
    }
    child.stdout.write(reply.base64 ? Buffer.from(reply.base64, "base64") : (reply.stdout ?? ""));
    // A listener may kill the child inside that write, as a real one can be.
    if (closed) return;
    child.stderr.write(reply.stderr ?? "");
    close(reply.status ?? 0, null);
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      input.push(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      callback();
      setImmediate(() => respond().catch((e) => child.emit("error", e)));
    },
  });
  return child;
}

export const ok = (stdout = "") => ({ "*": { status: 0, stdout } });

/** The image id the fake sbx gives a loaded template. */
export const TEMPLATE_ID = `sha256:${"5a".repeat(32)}`;

/**
 * `sbx template ls --json` as sbx v0.54.0 prints it (run evidence
 * d375-sbx-diag.txt): the template the run's `docker build` tagged, the
 * assembled tag sbx gives it at create, under the same id, and an
 * unrelated template.
 */
export function templateList(host) {
  const build = readFileSync(join(host.dir, "calls.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((c) => c[0] === "docker" && c[1] === "build");
  const tag = build ? build[build.indexOf("--tag") + 1] : "none:none";
  const [repo, version] = tag.split(":");
  return JSON.stringify([
    { id: `sha256:${"e1".repeat(32)}`, repository: "docker.io/library/node", tag: "22-bookworm" },
    { id: TEMPLATE_ID, repository: `docker.io/library/${repo}`, tag: version },
    {
      id: TEMPLATE_ID,
      repository: "docker.io/library/sandbox-kit-assembled",
      tag: "178ae62b8934db4d",
    },
  ]);
}

/** The model credential a test's environment holds: fake, shaped like a real key. */
export const REAL_KEY = "sk-ant-api03-fake-real-key-for-tests-only-0123456789";
/** The non-secret key the sandboxed Claude Code gets instead. */
export const PLACEHOLDER = "agent-kit-deep-scan-placeholder";
export const failing = (stderr = "boom") => ({ "*": { status: 1, stderr } });

/** A report file as `docker cp <container>:<file> -` writes it: a tar of one file. */
export const REPORT_TEXT = "# Deep scan report\n\nFrom the sandbox.\n";
export const reportTar = (text = REPORT_TEXT) =>
  tarOf([{ path: "report.md", data: Buffer.from(text) }]).toString("base64");

/**
 * The fake's key for the copy-out: `docker exec` runs the in-sandbox check
 * and then `tar -c` of the report, whose stdout is the archive (#404: under
 * gVisor, `docker cp` cannot see what the sandbox wrote).
 */
export const COPY_OUT = "~tar -c -f - -C /agent-kit/out report.md";

/** `docker network inspect --format {{json .}}` for an isolated sandbox network. */
export const ISOLATED = {
  Name: "agent-kit-deep-net",
  Driver: "bridge",
  Internal: true,
  Options: {
    "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
    "com.docker.network.bridge.gateway_mode_ipv6": "isolated",
  },
  IPAM: { Driver: "default", Config: [{ Subnet: "172.30.0.0/16" }] },
};
/**
 * A probe's answer: its own addresses (an address no target has, unless a
 * test says otherwise) and one result per target, in their order.
 */
export const probeOut = (results, self = ["192.0.2.250"]) =>
  `${JSON.stringify({ self, results })}\n`;
/** The probe's answer, in its target order: the relay, the gateway on the proxy's port, on another. */
export const PROBE_PASS = ["connected", "unreachable", "unreachable"];
/** The cut probe's: the removed setup relay, the gateway on its port and on another, none reached. */
export const CUT_PASS = ["unreachable", "unreachable", "unreachable"];
/** The model probe's: the model relay reached; the removed setup relay and the gateway not. */
export const MODEL_PASS = ["connected", "unreachable", "unreachable", "unreachable"];
/**
 * The probes' answers when the recipe lists no registries: there is no
 * setup relay, so before the model relay only the gateway is tried.
 */
export const NO_REGISTRIES = {
  "~-probe-setup --label": { status: 0, stdout: probeOut(["unreachable"]) },
  "~-probe-cut --label": { status: 0, stdout: probeOut(["unreachable"]) },
  "~-probe-model --label": {
    status: 0,
    stdout: probeOut(["connected", "unreachable", "unreachable"]),
  },
};

/**
 * A Docker Engine on `os`: `docker info --format {{json .}}` as it answers
 * it, and the lifecycle's commands answered as a working engine would (the
 * host network's gateway, an isolated sandbox network, the relay's address,
 * a probe that reaches the relay alone, a sandbox with no network left, the
 * report). `extra` adds or overrides answers.
 */
export function docker({
  os = "Ubuntu 24.04 LTS",
  kernel = "6.8.0-45-generic",
  version = "28.5.1",
  runtimes = { runc: { path: "runc" } },
  extra = {},
} = {}) {
  const info = {
    OperatingSystem: os,
    KernelVersion: kernel,
    ServerVersion: version,
    Runtimes: runtimes,
  };
  return {
    "info --format {{json .}}": { status: 0, stdout: `${JSON.stringify(info)}\n` },
    // The host network's gateway, where the host-side proxies listen.
    "network inspect": { status: 0, stdout: "127.0.0.1\n" },
    "network inspect --format {{json .IPAM.Config}}": {
      status: 0,
      stdout: `${JSON.stringify([{ Subnet: "172.18.0.0/16", Gateway: "127.0.0.1" }])}\n`,
    },
    "network inspect --format {{json .}}": { status: 0, stdout: `${JSON.stringify(ISOLATED)}\n` },
    "run --rm": { status: 0, stdout: probeOut(PROBE_PASS) },
    "~-probe-setup --label": { status: 0, stdout: probeOut(PROBE_PASS) },
    "~-probe-cut --label": { status: 0, stdout: probeOut(CUT_PASS) },
    "~-probe-model --label": { status: 0, stdout: probeOut(MODEL_PASS) },
    "inspect --format {{json .NetworkSettings.Networks}}": { status: 0, stdout: "{}\n" },
    // The check before the target starts asks the same with `container inspect`.
    "container inspect --format {{json .NetworkSettings.Networks}}": {
      status: 0,
      stdout: "{}\n",
    },
    [COPY_OUT]: { status: 0, base64: reportTar() },
    ...extra,
  };
}
/**
 * `sbx policy ls --json` on a deny-all global policy, verbatim as sbx
 * v0.54.0 printed it on the maintainer's machine (the run's evidence).
 */
export const SBX_DENY_ALL = readFileSync(
  join(import.meta.dirname, "fixtures", "deep-scan", "sbx-policy-ls-deny-all.txt"),
  "utf8",
);

/**
 * Docker Sandboxes (`sbx` v0.54.0) as a working install answers: its
 * version, a deny-all global policy, the same for one sandbox, and the
 * report copied out into the call's folder. `extra` adds or overrides.
 */
export function sbxAnswers(extra = {}) {
  return {
    version: { status: 0, stdout: "sbx version v0.54.0 4bec4a5c\n" },
    "--no-input policy ls --json": { status: 0, stdout: SBX_DENY_ALL },
    "--no-input policy ls agent-kit-deep-": { status: 0, stdout: SBX_DENY_ALL },
    "--no-input template ls --json": { status: 0, templates: true },
    "--no-input cp agent-kit-deep-": {
      status: 0,
      writes: [{ name: "report.md", text: REPORT_TEXT }],
    },
    "*": { status: 0 },
    ...extra,
  };
}

export const RUNC = { "io.containerd.runc.v2": { path: "runc" }, runc: { path: "runc" } };
export const KATA = { kata: { path: "/opt/kata/bin/containerd-shim-kata-v2" } };
export const FC = { "kata-fc": { path: "/opt/kata/bin/kata-fc" } };
export const RUNSC = { runsc: { path: "/usr/local/bin/runsc" } };

/** A host: its platform and the fake CLIs installed on it. */
export function makeHost(platform, clis = {}) {
  const dir = join(tmp, `host-${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "calls.jsonl"), "");
  for (const [name, answer] of Object.entries(clis)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(answer));
  }
  return { platform, dir };
}

/** Every call a host's fake CLIs recorded, as [cli, ...args]. */
export function shimCalls(host) {
  return readFileSync(join(host.dir, "calls.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * What the sandboxed agent does on the model route, played by the fake
 * runtime CLI for the agent step: it reads the base URL from the launcher's
 * --settings and the key from its environment, as Claude Code would, and
 * calls the model API through the proxy; then it tries to use the proxy for
 * another host. Each answer is recorded to model.jsonl.
 */
export async function playAgent(host, args, turns) {
  const script = args.at(-1);
  const settings = JSON.parse(/--settings '([^']*)'/.exec(script)[1]);
  // The sandbox reaches the host as host.docker.internal; this test is on it.
  const baseUrl = new URL(settings.env.ANTHROPIC_BASE_URL);
  baseUrl.hostname = "127.0.0.1";
  const base = baseUrl.origin;
  const held = (name) => args.find((a) => a.startsWith(`${name}=`))?.split("=")[1];
  // On the subscription path Claude Code holds a token, and sends it as a
  // bearer value with its OAuth beta header; else it holds an API key.
  const token = held("CLAUDE_CODE_OAUTH_TOKEN");
  const key = held("ANTHROPIC_API_KEY");
  const auth =
    token !== undefined
      ? { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }
      : { "x-api-key": key };
  const record = (what, answer) =>
    appendFileSync(join(host.dir, "model.jsonl"), `${JSON.stringify([what, answer])}\n`);
  if (typeof turns === "number") {
    // That many model calls, one after another, as Claude Code's turns are.
    for (let i = 0; i < turns; i++) {
      try {
        const r = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: auth,
          body: '{"model":"m","messages":[]}',
        });
        await r.arrayBuffer();
        record("messages", r.status);
      } catch (e) {
        record("messages", `error ${e.cause?.code ?? e.message}`);
        return;
      }
    }
    return;
  }
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: token !== undefined ? auth : { ...auth, authorization: `Bearer ${key}` },
    body: '{"model":"m","messages":[]}',
  });
  record("messages", res.status);
  const url = new URL(base);
  const forward = await rawRequest(
    Number(url.port),
    "GET http://evil.example/ HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
  );
  record("evil.example", Number(forward.slice(9, 12)));
}

/** The non-blocking spawn for a host, as `spawnFor`; `onSpawn` sees each child. */
export function spawnAsyncFor(host, spawned, onSpawn = () => {}, envs = []) {
  return (cmd, args, opts) => {
    spawned.push([cmd, ...args]);
    envs.push(opts.env ?? {});
    let child;
    if (cmd === "git") child = spawnChild(cmd, args, opts);
    else if (!existsSync(join(host.dir, `${cmd}.json`))) {
      throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
    } else {
      child = fakeChild(host, cmd, args, opts.cwd);
    }
    onSpawn(cmd, args, child);
    return child;
  };
}

/** The spawn for a host: git for real, a fake CLI answered in process, else not found. */
export function spawnFor(host, spawned, envs = []) {
  return (cmd, args, opts) => {
    spawned.push([cmd, ...args]);
    envs.push(opts.env ?? {});
    if (cmd === "git") return spawnSync(cmd, args, opts);
    if (!existsSync(join(host.dir, `${cmd}.json`))) {
      return { error: Object.assign(new Error(`spawnSync ${cmd} ENOENT`), { code: "ENOENT" }) };
    }
    return fakeSpawnSync(host, cmd, args, opts);
  };
}

/** A Linux host where gVisor is the only accepted runtime. */
export const gvisorHost = () =>
  makeHost("linux", {
    docker: docker({ runtimes: { ...RUNC, ...RUNSC } }),
    runsc: ok("runsc version release-20251110.0\n"),
  });

/**
 * Run the CLI on a host (default: Linux with gVisor) with an environment
 * (default: none of the GitHub tokens), and record every command it runs.
 */
export async function run(
  dir,
  args = [],
  {
    host = gvisorHost(),
    env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: REAL_KEY },
    fetch = groundingFetch,
    signals = new EventEmitter(),
    onSpawn,
    modelApi = "http://127.0.0.1:9",
    timers = fakeTimers(),
    reportDir = mkdtempSync(join(tmp, "report-")),
  } = {},
) {
  const out = [];
  const err = [];
  const calls = [];
  const envs = [];
  const code = await main(["deep-scan", ...args], {
    cwd: dir,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    // Both process boundaries are fakes: no test ever reaches a real runtime.
    spawn: spawnFor(host, calls, envs),
    spawnAsync: spawnAsyncFor(host, calls, onSpawn, envs),
    platform: host.platform,
    env,
    fetch,
    signals,
    reportDir,
    // Never the real model API: a closed port unless a test gives a fake.
    modelApi,
    // Never the real clock: a limit fires only when a test fires it.
    timers,
  });
  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    text: [...out, ...err].join("\n"),
    calls,
    envs,
    gitCalls: calls.filter((c) => c[0] === "git"),
    shims: shimCalls(host),
    host,
    reportDir,
    timers,
  };
}

/**
 * A clock that never fires by itself: each timer the launcher sets is
 * recorded with its delay, and a test fires the one with a given delay.
 */
export function fakeTimers() {
  const set = [];
  return {
    set,
    setTimeout(fn, ms) {
      const t = { fn, ms, cleared: false };
      set.push(t);
      return t;
    },
    clearTimeout(t) {
      if (t) t.cleared = true;
    },
    /** The delays of the timers still pending. */
    pending: () => set.filter((t) => !t.cleared).map((t) => t.ms),
    fire(ms) {
      const t = set.find((x) => x.ms === ms && !x.cleared);
      assert.ok(t, `a pending timer of ${ms} ms (pending: ${set.map((x) => x.ms).join(", ")})`);
      t.cleared = true;
      t.fn();
    },
  };
}

/** The grounding fetch when a test gives none: each URL answers with a line naming it. */
export const groundingFetch = async (url) => new Response(`grounding from ${url}\n`);

export const recipeRepo = (text, path = ".security/scan-recipe.yml") =>
  makeRepo({ committed: { [path]: text } });

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-kit-deep-scan-test-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

// A recipe built from VALID's blocks: `drop` names top-level keys to leave
// out, `add` is YAML appended at the end.
export const BLOCKS = VALID.split(/\n(?=[a-z_]+:)/)
  .slice(1)
  .map((b) => [b.slice(0, b.indexOf(":")), b.trimEnd()]);
export function recipe({ drop = [], add = "" } = {}) {
  const kept = BLOCKS.filter(([k]) => !drop.includes(k)).map(([, b]) => b);
  return `${[...kept, add].filter(Boolean).join("\n")}\n`;
}
export const CLI_ONLY = `entry_points:
  - command: node bin/cli.js
    note: The CLI.
  - command: node bin/other.js
    note: A second command.`;

// --- Sandbox runtime selection (#368) -----------------------------------

export const ACCEPTED_LIST =
  /Accepted runtimes: Docker Sandboxes \(sbx\); Kata Containers or Firecracker on Linux; gVisor \(runsc\) on Linux; the last two on Docker Engine 28\.0 or later\./;
export const CI_PATH = /CI path: the deep-scan reusable workflow/;
export const NO_OVERRIDE = /There is no override/;
export const RUNTIME_DOCS = /docs\/security-audit\.md#sandbox-runtimes/;
export const START_VERBS = new Set([
  "run",
  "create",
  "start",
  "exec",
  "rm",
  "kill",
  "pull",
  "build",
]);

/** The fake CLIs ran only host-side probes: nothing was started. */
export function assertNothingStarted(res) {
  for (const [cli, ...args] of res.shims) {
    assert.ok(!args.some((a) => START_VERBS.has(a)), `${cli} ${args.join(" ")} starts something`);
  }
}

export const ALL_RUNTIMES = {
  sbx: sbxAnswers(),
  docker: docker({ runtimes: { ...RUNC, ...KATA, ...FC, ...RUNSC } }),
  "kata-runtime": ok("kata-runtime  : 3.10.1\n"),
  firecracker: ok("Firecracker v1.10.1\n"),
  runsc: ok("runsc version release-20251110.0\n"),
};
export const without = (...names) =>
  Object.fromEntries(Object.entries(ALL_RUNTIMES).filter(([k]) => !names.includes(k)));

// --- Pre-flight refusals (#368) --------------------------------------------

// --- The process allowlist (ADR 0019) --------------------------------------

// --- The sandbox lifecycle (#369) -------------------------------------------

/** The docker commands a run sent after choosing the runtime, as arg lists. */
export function lifecycle(res) {
  return res.shims
    .filter(([cli, ...args]) => cli === "docker" && args.join(" ") !== "info --format {{json .}}")
    .map(([, ...args]) => args.filter((a) => typeof a === "string"));
}

/** The bytes the first matching docker call got on stdin, or null. */
export function stdinOf(res, predicate) {
  const call = res.shims.find(
    (c) => c[0] === "docker" && predicate(c.slice(1).filter((a) => typeof a === "string")),
  );
  const tag = call?.find((a) => a && typeof a === "object" && a.stdin);
  return tag ? readFileSync(join(res.host.dir, tag.stdin)) : null;
}

/**
 * The entries of a tar archive, as { name, type, data }, read by hand (an
 * independent reading, not the CLI's): ustar names with their prefix, PAX
 * headers skipped.
 */
export function tarEntries(buf) {
  const entries = [];
  const str = (b, s, l) =>
    b
      .subarray(s, s + l)
      .toString("utf8")
      .replace(/\0.*$/s, "");
  for (let o = 0; o + 512 <= buf.length;) {
    const h = buf.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(str(h, 124, 12).trim() || "0", 8);
    const type = str(h, 156, 1) || "0";
    const prefix = str(h, 345, 155);
    const name = prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100);
    o += 512;
    if (type !== "x" && type !== "g") {
      entries.push({ name, type, data: buf.subarray(o, o + size) });
    }
    o += Math.ceil(size / 512) * 512;
  }
  return entries;
}

export const verb = (args) =>
  args.slice(0, args[0] === "network" || args[0] === "container" ? 2 : 1).join(" ");
export const isAgentStep = (a) => a[0] === "exec" && Boolean(a.at(-1)?.startsWith("set -eu"));
export const isSetupStep = (a) =>
  a[0] === "exec" &&
  !isAgentStep(a) &&
  !a.includes("--user") &&
  a.includes("-c") &&
  !a.at(-1).startsWith("cat ");
/** A copy-in: a tar on stdin, unpacked at the sandbox's root by `docker exec` (#404). */
export const isCopyIn = (a) => a[0] === "exec" && a.includes("-i") && a.includes("-x");
/** The copy-out: `docker exec` checks the report in the sandbox, then tars it (#404). */
export const isCopyOut = (a) => a[0] === "exec" && Boolean(a.at(-1)?.includes("tar -c -f -"));
export const removed = (calls) =>
  calls.filter(
    (a) =>
      (a[0] === "rm" && a.includes("--volumes")) ||
      (a[0] === "network" && a[1] === "rm") ||
      a[0] === "image",
  );
export const containerOf = (calls) => {
  const r = calls.find((a) => a[0] === "run" && a.includes("--init"));
  return r ? r[r.indexOf("--name") + 1] : undefined;
};

/** A gVisor host whose docker answers `extra` over the working engine's answers. */
export const gvisorWith = (extra) =>
  makeHost("linux", {
    docker: docker({ runtimes: { ...RUNC, ...RUNSC }, extra }),
    runsc: ok("runsc version release-20251110.0\n"),
  });

// --- The Docker Sandboxes driver (#369, the human's option 1) ---------------

/** The sbx commands a run sent, `--no-input` dropped, as arg lists. */
export function sbxCalls(res) {
  return res.shims
    .filter(([cli]) => cli === "sbx")
    .map(([, ...args]) => args.filter((a) => typeof a === "string" && a !== "--no-input"));
}

/**
 * A Windows host with Docker Sandboxes and the Docker CLI that builds its
 * template; `extra` overrides sbx's answers, `dockerExtra` docker's.
 */
export const sbxHost = (extra, dockerExtra = {}) =>
  makeHost("win32", { sbx: sbxAnswers(extra), docker: { "*": { status: 0 }, ...dockerExtra } });

/** The docker commands a run sent, as arg lists. */
export const dockerCalls = (res) =>
  res.shims.filter(([cli]) => cli === "docker").map(([, ...args]) => args);

/**
 * `calls` without its last call, which must remove the sandbox's template
 * (the layered image loaded into sbx), after the sandbox itself.
 */
export function untemplated(calls) {
  const last = calls.at(-1);
  assert.deepEqual(last, ["template", "rm", "--force", TEMPLATE_ID.slice(7)], last.join(" "));
  return calls.slice(0, -1);
}

export const sbxVerb = (a) =>
  a[0] === "policy" ? a.slice(0, a[1] === "ls" ? 2 : 3).join(" ") : a[0];

/** The deny-all policy with one more active network rule. */
export const withRule = (rule) => {
  const policy = JSON.parse(SBX_DENY_ALL);
  policy.rules.push({
    id: "extra-rule",
    scope: "global",
    applies_to: "all",
    resource_type: "network",
    status: "active",
    resources: ["**"],
    ...rule,
  });
  return JSON.stringify(policy);
};

export const sandboxName = (calls) => {
  const create = calls.find((a) => a[0] === "create");
  return create[create.indexOf("--name") + 1];
};

// --- The key-injecting model proxy (#370) -----------------------------------

/**
 * A fake model API on 127.0.0.1: it records each request's method, path,
 * headers and body, and answers like the Messages API (`stream` makes it
 * send two chunks). With `model`, its JSON answers name that model.
 */
export async function fakeModelApi({ model } = {}) {
  const seen = [];
  const server = createHttpServer((req, res) => {
    const body = [];
    req.on("data", (b) => body.push(b));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(body).toString("utf8"),
      });
      if (req.url.includes("stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: one\n\n");
        setTimeout(() => res.end("event: two\n\n"), 10);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          ...(model !== undefined ? { model } : {}),
          usage: { input_tokens: 3, output_tokens: 5 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** One raw HTTP/1.1 exchange with the proxy, so any request form can be sent. */
export function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = connectNet(port, "127.0.0.1", () => socket.end(text));
    const chunks = [];
    socket.on("data", (b) => chunks.push(b));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

// --- The model credential (#370) --------------------------------------------

/** A gVisor host that also has the 1Password CLI, answering `op` with `answer`. */
export const gvisorWithOp = (answer) =>
  makeHost("linux", {
    docker: docker({ runtimes: { ...RUNC, ...RUNSC } }),
    runsc: ok("runsc version release-20251110.0\n"),
    op: answer,
  });

export const startedAnything = (res) => lifecycle(res).length > 0;

// --- What the agent is handed (#370) ----------------------------------------

// --- The real agent step, behind the model proxy (#370) ---------------------

/** The agent step's call: the exec whose script starts Claude Code. */
export const agentCall = (calls) => calls.find(isAgentStep);

/** The launcher's --settings in an agent step's script, parsed. */
export const settingsOf = (call) => JSON.parse(/--settings '([^']*)'/.exec(call.at(-1))[1]);

/** The claude command line in an agent step's script. */
export const claudeLine = (call) =>
  call
    .at(-1)
    .split("\n")
    .find((l) => /^(\{ )?claude /.test(l));

/** Every file a run's fake CLIs got on stdin or copied in, as bytes. */
export function stdinFilesOf(res) {
  return res.shims
    .flatMap((c) => c.filter((a) => a && typeof a === "object" && a.stdin))
    .map((t) => readFileSync(join(res.host.dir, t.stdin)));
}

/** The launcher's brief, from the tar that copied it in. */
export function briefOf(res) {
  for (const data of stdinFilesOf(res)) {
    const entry = tarEntries(data).find((e) => e.name === "agent-kit/in/brief.md");
    if (entry) return entry.data.toString("utf8");
  }
  return null;
}

/** Model answers the fake agent recorded, as [what, status]. */
export const modelProbes = (host) =>
  existsSync(join(host.dir, "model.jsonl"))
    ? readFileSync(join(host.dir, "model.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

// --- Limits and the Stopped line (#371) --------------------------------------

export const MINUTE = 60_000;

/** A deep report's header, as report-format.md lays it out, and one finding. */
export const HEADER_REPORT = [
  "## Security audit report",
  "",
  "- **Mode:** deep",
  "- **Scope:** the whole repository",
  "- **Date:** 2026-11-20",
  "- **Max severity:** high",
  "- **Finding count:** 1",
  "",
  "### F1 — a finding found before the stop",
  "",
  "- **Severity:** High",
  "",
].join("\n");

/** The report the run wrote, as text. */
export const reportOf = (res) => readFileSync(join(res.reportDir, "report.md"), "utf8");

/** A gVisor host whose report is HEADER_REPORT, with `extra` answers. */
export const reportingHost = (extra = {}) =>
  gvisorWith({ [COPY_OUT]: { status: 0, base64: reportTar(HEADER_REPORT) }, ...extra });

/** Fire the timer of `ms` as soon as the agent step (or a setup command) is running. */
export const fireOn = (timers, ms, matches) => (cmd, args, child) => {
  if (matches(cmd, args)) child.stdout.once("data", () => timers.fire(ms));
};

/**
 * A fake model API whose every answer is `answer(req, res)`, recording what
 * it was sent. Only on 127.0.0.1.
 */
export async function answeringApi(answer) {
  const seen = [];
  const server = createHttpServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    req.resume();
    req.on("end", () => answer(req, res));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** A proxy in front of `api`, with a cap; `capped` counts its onCap calls. */
export async function cappedProxy(api, maxTokens) {
  const capped = { n: 0 };
  const proxy = await startModelProxy({
    credential: REAL_KEY,
    bind: "127.0.0.1",
    upstream: api.url,
    maxTokens,
    onCap: () => {
      capped.n += 1;
    },
  });
  const post = async (path = "/v1/messages") => {
    const r = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
      method: "POST",
      headers: { "x-api-key": PLACEHOLDER, "accept-encoding": "gzip, br" },
      body: "{}",
    });
    return { status: r.status, text: await r.text() };
  };
  return { proxy, capped, post };
}

export const USAGE_ALL = {
  input_tokens: 10,
  cache_creation_input_tokens: 20,
  cache_read_input_tokens: 30,
  output_tokens: 40,
};

// --- The Verification run (#372) ------------------------------------------

export const SKILL_SOURCE = join(import.meta.dirname, "..", ".claude", "skills", "security-audit");

/** The audit flow as adopted, with the real skill files a Verification run hands in. */
export const VERIFY_ADOPTED = {
  ".claude/skills/security-audit/DEEP.md": readFileSync(join(SKILL_SOURCE, "DEEP.md"), "utf8"),
  ".claude/skills/security-audit/report-format.md": readFileSync(
    join(SKILL_SOURCE, "report-format.md"),
    "utf8",
  ),
};

/** A finding file in a deep report's shape: two reproduced findings. */
export const FINDINGS = [
  "## Security audit report",
  "",
  "- **Mode:** deep",
  "",
  "### F1 — path traversal in the upload handler",
  "",
  "- **Severity:** High",
  "- **Location:** `src/upload.js:42`",
  "- **Concept id:** `upload-path-traversal`",
  "- **Reproduced:** yes",
  "- **Observation:** an anonymous user's upload name with parent-folder steps wrote outside the upload folder.",
  "",
  "### F2 — admin route without a role check",
  "",
  "- **Severity:** Medium",
  "- **Location:** `src/admin.js:7`",
  "- **Concept id:** `admin-missing-role-check`",
  "- **Reproduced:** yes",
  "- **Observation:** a signed-in non-admin fixture user reached the admin listing.",
  "",
  "### Open questions",
  "",
  "None.",
  "",
].join("\n");

/** A Verification-run report as report-format.md lays it out, for the given findings. */
export const VERIFY_REPORT = [
  "## Security audit report",
  "",
  "- **Mode:** deep (Verification run)",
  "- **Scope:** fix/upload",
  "- **Date:** 2026-11-20",
  "- **Max severity:** medium",
  "- **Finding count:** 1",
  "",
  "### upload-path-traversal",
  "",
  "- **Location:** `src/upload.js:42` (as given)",
  "- **Reproduced:** no",
  "- **Reason:** the handler now rejects every name with a folder step.",
  "",
  "### admin-missing-role-check",
  "",
  "- **Location:** `src/admin.js:7` (as given)",
  "- **Reproduced:** yes",
  "- **Reason:** a signed-in non-admin fixture user still reached the admin listing.",
  "",
].join("\n");

/** A finding file outside the repository, as a maintainer keeps one. */
export function findingFile(text = FINDINGS) {
  const dir = mkdtempSync(join(tmp, "findings-"));
  const file = join(dir, "findings.md");
  writeFileSync(file, text);
  return file;
}

/**
 * A repository with the recipe and the real skill on main, and a fix branch
 * `fix/upload` that changes src/upload.js; main stays checked out, with an
 * uncommitted edit.
 */
export function verifyRepo({ fix = {}, committed = {} } = {}) {
  const dir = makeRepo({
    committed: {
      ".security/scan-recipe.yml": VALID,
      "src/upload.js": "unfixed\n",
      ...VERIFY_ADOPTED,
      ...committed,
    },
  });
  git(dir, "switch", "-qc", "fix/upload");
  writeTree(dir, { "src/upload.js": "fixed\n", ...fix });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "fix");
  git(dir, "switch", "-q", "main");
  writeTree(dir, { "src/upload.js": "uncommitted edit\n" });
  return dir;
}

/** A gVisor host whose agent leaves `report` (default VERIFY_REPORT). */
export const verifyHost = (report = VERIFY_REPORT, extra = {}) =>
  gvisorWith({ [COPY_OUT]: { status: 0, base64: reportTar(report) }, ...extra });

export const verifyArgs = (file = findingFile(), ref = "fix/upload") => [
  "--verify",
  file,
  "--ref",
  ref,
];

/** Every file copied into the sandbox, from every tar a run sent. */
export function copiedIn(res) {
  return stdinFilesOf(res).flatMap((data) => tarEntries(data).filter((e) => e.type === "0"));
}

/** The index, among the docker lifecycle calls, of the first copy-in holding `name`. */
export function copyInIndexOf(res, name) {
  return lifecycle(res).findIndex((a, i) => {
    if (!isCopyIn(a)) return false;
    const calls = res.shims.filter(
      ([cli, ...args]) => cli === "docker" && args.join(" ") !== "info --format {{json .}}",
    );
    const tag = calls[i].find((x) => x && typeof x === "object" && x.stdin);
    return Boolean(
      tag && tarEntries(readFileSync(join(res.host.dir, tag.stdin))).some((e) => e.name === name),
    );
  });
}

// --- The subscription path (#375) -------------------------------------------

/** A Claude subscription token a test's environment holds: fake, shaped like a real one. */
export const REAL_OAUTH = "sk-ant-oat01-fake-real-subscription-token-for-tests-0123456789";
/** The non-secret token the sandboxed Claude Code gets instead, on this path. */
export const OAUTH_PLACEHOLDER = "sk-ant-oat01-agent-kit-deep-scan-placeholder";
export const SUBSCRIPTION = ["--credential", "subscription"];
export const oauthEnv = (extra = {}) => ({
  PATH: "/usr/bin",
  CLAUDE_CODE_OAUTH_TOKEN: REAL_OAUTH,
  ...extra,
});
/** The fake agent's answer, matched with or without --bare. */
export const AGENT_PLAYS = { "~--no-session-persistence": { status: 0, model: true } };

/** Assert that no recorded call, environment or copied file holds `secret`. */
export function assertNeverHanded(res, secret) {
  assert.ok(res.calls.length > 10);
  for (const call of res.calls) {
    assert.ok(!JSON.stringify(call).includes(secret), JSON.stringify(call));
  }
  for (const env of res.envs) {
    assert.ok(!JSON.stringify(env).includes(secret), "an environment holds the token");
  }
  for (const data of stdinFilesOf(res)) assert.ok(!data.includes(secret));
}

// --- The model and effort the agent runs on, and the model that answered ---

// --- Review fixes from pull request #390 -------------------------------------

/**
 * A Verification-run repository whose default branch commits `path` (an
 * environment file) under `recipeText`, and whose fix branch deletes it, as
 * the fix for a committed-secret finding would.
 */
export function verifyRepoDeleting(path, recipeText) {
  const dir = makeRepo({
    committed: {
      ".security/scan-recipe.yml": recipeText,
      "src/upload.js": "unfixed\n",
      Dockerfile: "FROM node:22-bookworm\nCOPY . /app\n",
      ...VERIFY_ADOPTED,
      [path]: "SECRET=1\n",
    },
  });
  git(dir, "switch", "-qc", "fix/upload");
  git(dir, "rm", "-q", path);
  git(dir, "commit", "-qm", "fix");
  git(dir, "switch", "-q", "main");
  return dir;
}

/** A grounding fetch whose body sends `chunks` 1 MiB chunks, then runs `then` on the next read. */
export function streamingFetch({ chunks = 1, then, pulls = { n: 0 } } = {}) {
  return async (_url, init) =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulls.n += 1;
          if (pulls.n <= chunks) controller.enqueue(new Uint8Array(1024 * 1024));
          else if (then) then(controller, init);
          else controller.close();
        },
      }),
    );
}

// --- Docker Engine: an isolated network and a relay (#404) -----------------

export const isSandboxRun = (a) => a[0] === "run" && a.includes("--init");
export const relayRuns = (calls) =>
  calls.filter((a) => a[0] === "run" && a[1] === "--detach" && !a.includes("--init"));
export const probeRuns = (calls) => calls.filter((a) => a[0] === "run" && a[1] === "--rm");
/** Every value `flag` takes in `args`, in order. */
export const flagValues = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
export const ISOLATED_OPTS = [
  "com.docker.network.bridge.gateway_mode_ipv4=isolated",
  "com.docker.network.bridge.gateway_mode_ipv6=isolated",
];
/** What a probe or relay runs: the relay script in the image, and its arguments. */
export const scriptArgs = (a) => a.slice(a.indexOf("/agent-kit/relay.mjs"));
/** A relay's fixed address on the sandbox's network, from its `--network name=…,ip=…`. */
export const relayAddr = (a) => {
  const net = flagValues(a, "--network").find(
    (v) => /^name=[^,]+,ip=/.test(v) && !v.includes("gw-priority"),
  );
  return net?.slice(net.indexOf(",ip=") + 4);
};
/** The host-side proxy port a relay forwards to. */
export const relayPort = (a) => scriptArgs(a).at(-1);
