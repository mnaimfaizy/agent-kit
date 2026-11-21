#!/usr/bin/env node
// TEST-ONLY. The fixture driver for Agent-kit's own Deep scan (#374): runs one
// fixture's crafted cases against the entry point the Scan recipe
// (.security/scan-recipe.yml) names, and prints a verdict per case.
//
//   node security/deep-scan/drive.mjs <fixture>
//
// Each case runs in a scratch folder (under $DEEP_SCAN_FIXTURE_DIR, else a new
// temporary folder, printed as Scratch:) that holds what the case built and
// what the shims recorded, so the scan can read it and craft its own cases.
// A line per case: `ok  `, `DIFF` (the entry point did not do what the case
// expects) or `skip` (this host cannot build the case). Exit 0 when no case
// is DIFF, 1 when one is, 2 for an unknown fixture.
//
// Nothing here makes a network call or reads a credential. Every child gets a
// clean environment: no inherited token or proxy variable, a scratch HOME,
// and no system or global git config. The delivery scripts run against the
// recording gh and mail shims (shims/); the CLI's tag fetch is pointed at a
// local sentinel that records the connection and closes it, since the fetch
// itself stays static-only. Node core only.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startMailShim } from "./shims/mail.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const repoPath = (path) => join(repo, ...path.split("/"));
const posixPath = (path) => path.split(sep).join("/");
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------- plumbing

/** A child's environment: only what a process needs to start, plus `extra`. */
function cleanEnv(ctx, extra = {}) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: ctx.home,
    USERPROFILE: ctx.home,
    XDG_CONFIG_HOME: join(ctx.home, ".config"),
    TMPDIR: ctx.tmp,
    TEMP: ctx.tmp,
    TMP: ctx.tmp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: ctx.emptyGitConfig,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    NO_PROXY: "*",
    no_proxy: "*",
    // Git for Windows' bash rewrites arguments that look like POSIX paths
    // (gh's /repos/... endpoint) for non-MSYS programs; keep them as written.
    ...(process.platform === "win32" ? { MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } : {}),
    ...extra,
  };
}

function run(cmd, args, { cwd, env, input = "", timeout = TIMEOUT_MS }) {
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: "utf8", timeout });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
}

/** As run, but leaves this process's event loop free for an in-process shim. */
function runAsync(cmd, args, { cwd, env, input = "" }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** The bash a delivery script runs under; on Windows, never System32's WSL one. */
function bash() {
  if (process.platform !== "win32") return "bash";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (/system32|windowsapps/i.test(dir)) continue;
    if (existsSync(join(dir, "bash.exe"))) return join(dir, "bash.exe");
  }
  return "bash";
}

function git(args, { cwd, env }) {
  const r = run(
    "git",
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function tryLink(target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

/** Each JSON line a shim wrote. */
function records(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** A verdict: ok when every check holds, else DIFF naming the first that fails. */
function verdict(name, checks, observed) {
  const failed = checks.find(([holds]) => !holds);
  return failed
    ? { name, status: "DIFF", detail: `expected ${failed[1]}; ${observed}` }
    : { name, status: "ok", detail: observed };
}

// ---------------------------------------------------------------- hook guards

function hookDecision(r) {
  if (r.status !== 0) return `exit ${r.status}`;
  const out = r.stdout.trim();
  if (out === "") return "allow";
  try {
    const decision = JSON.parse(out).hookSpecificOutput;
    if (decision?.permissionDecision === "deny") return "deny";
  } catch {
    // fall through
  }
  return `unexpected output: ${out.slice(0, 200)}`;
}

function confinementWorkspace(ctx) {
  const ws = join(ctx.work, "workspace");
  write(join(ws, "src", "app.js"), "console.log('fixture');\n");
  write(join(ws, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  write(join(ws, ".claude", "README.md"), "fixture\n");
  // Outside the workspace, with a file in it, so a read through the link has
  // something to open on every host.
  write(join(ctx.work, "outside", "secret.txt"), "outside the workspace\n");
  const links =
    tryLink(join(ctx.work, "outside"), join(ws, "escape")) &&
    tryLink("src", join(ws, "inner")) &&
    tryLink(join(ctx.work, "does-not-exist", "target"), join(ws, "dangling"));
  return { ws, links };
}

function runHookCases({ ctx, script, casesFile, ws, links, env, before }) {
  const { cases } = JSON.parse(readFileSync(repoPath(casesFile), "utf8"));
  return cases.map((c) => {
    if (c.symlink && !links) {
      return { name: c.name, status: "skip", detail: "this host cannot make symbolic links" };
    }
    const undo = before?.(c) ?? (() => {});
    try {
      const event = JSON.parse(
        JSON.stringify({ hook_event_name: "PreToolUse", ...c.event }).replaceAll(
          "{workspace}",
          posixPath(ws),
        ),
      );
      const r = run(process.execPath, [repoPath(script)], {
        cwd: ws,
        env: cleanEnv(ctx, env),
        input: JSON.stringify(event),
      });
      const got = hookDecision(r);
      return verdict(c.name, [[got === c.expect, c.expect]], got);
    } finally {
      undo();
    }
  });
}

const READ_HOOK = ".github/agent-runtime/confine-reads-to-workspace.mjs";
const WRITE_HOOK = ".github/agent-runtime/confine-writes-to-worktree.mjs";
const PUSH_HOOK = ".github/agent-runtime/guard-implementer-push.mjs";
const GIT_CONFIG_CHECK = ".github/agent-runtime/check-git-config.mjs";

function readConfinement(ctx) {
  const { ws, links } = confinementWorkspace(ctx);
  return runHookCases({
    ctx,
    script: READ_HOOK,
    casesFile: "security/deep-scan/hook-events/read-confinement.json",
    ws,
    links,
    env: { GITHUB_WORKSPACE: ws },
  });
}

function writeConfinement(ctx) {
  const { ws, links } = confinementWorkspace(ctx);
  return runHookCases({
    ctx,
    script: WRITE_HOOK,
    casesFile: "security/deep-scan/hook-events/write-confinement.json",
    ws,
    links,
    env: { GITHUB_WORKSPACE: ws },
  });
}

function pushGuard(ctx) {
  const ws = join(ctx.work, "workspace");
  const runnerTemp = join(ctx.work, "runner-temp");
  const env = cleanEnv(ctx);
  mkdirSync(ws, { recursive: true });
  git(["init", "--quiet", "--initial-branch=main"], { cwd: ws, env });
  write(join(ws, "README.md"), "fixture\n");
  git(["add", "."], { cwd: ws, env });
  git(["commit", "--quiet", "-m", "base"], { cwd: ws, env });
  for (const [branch, file] of [
    ["docs-only", "docs/guide.md"],
    ["workflow-change", ".github/workflows/ci.yml"],
  ]) {
    git(["checkout", "--quiet", "-b", branch, "main"], { cwd: ws, env });
    write(join(ws, ...file.split("/")), "fixture\n");
    git(["add", "."], { cwd: ws, env });
    git(["commit", "--quiet", "-m", branch], { cwd: ws, env });
  }
  git(["checkout", "--quiet", "main"], { cwd: ws, env });
  write(join(runnerTemp, "read-confinement", "push-guard-base"), "main\n");

  const config = (args) =>
    git(["config", "--file", join(ws, ".git", "config"), ...args], { cwd: ws, env });
  return runHookCases({
    ctx,
    script: PUSH_HOOK,
    casesFile: "security/deep-scan/hook-events/push-guard.json",
    ws,
    links: true,
    env: { GITHUB_WORKSPACE: ws, RUNNER_TEMP: runnerTemp },
    before: (c) => {
      const keys = Object.entries(c.git_config ?? {});
      for (const [key, value] of keys) config([key, value]);
      return () => {
        for (const [key] of keys) config(["--unset", key]);
      };
    },
  });
}

function gitConfig(ctx) {
  const dir = "security/deep-scan/git-configs";
  const { cases } = JSON.parse(readFileSync(repoPath(`${dir}/cases.json`), "utf8"));
  return cases.map((c, i) => {
    const gitDir = join(ctx.work, `case-${i + 1}`, ".git");
    mkdirSync(join(gitDir, "hooks"), { recursive: true });
    copyFileSync(repoPath(`${dir}/${c.config}`), join(gitDir, "config"));
    for (const hook of c.hooks) write(join(gitDir, "hooks", hook), "#!/bin/sh\nexit 0\n");
    const r = run(process.execPath, [repoPath(GIT_CONFIG_CHECK), gitDir], {
      cwd: ctx.work,
      env: cleanEnv(ctx),
    });
    const out = r.stdout.trim();
    const got =
      r.status === 0 && out === "" ? "pass" : r.status === 1 ? "fail" : `exit ${r.status}`;
    const checks = [[got === c.expect, c.expect]];
    if (c.names) checks.push([out.includes(c.names), `the output to name ${c.names}`]);
    return verdict(c.name, checks, `${got}${out ? ` (${out.split("\n").join("; ")})` : ""}`);
  });
}

// ---------------------------------------------------------------- delivery scripts

const PUBLISH = ".github/security-audit/publish-draft-advisory.sh";
const COMMENT = ".github/security-audit/comment-pr-counts.sh";
const NOTIFY = ".github/security-audit/notify-email.sh";
const FAKE_REPOSITORY = "fixture-owner/fixture-repo";
// The finding text: it must reach the private draft and never the public log.
const MARKER = "FIXTURE-FINDING-BODY-never-in-the-public-log";
const FAKE_TOKEN = "fake-github-token-for-shims-only";

const REPORTS = {
  "two-findings": [
    "# Security audit report",
    "",
    "- **Mode:** full",
    "- **Date:** 2026-11-22",
    "- **Max severity:** high",
    "- **Finding count:** 2",
    "- **Scope:** the fixture",
    "",
    "### F1 — Fixture finding one",
    "",
    "- **Severity:** High",
    "",
    MARKER,
    "",
    "### F2 — Fixture finding two",
    "",
    "- **Severity:** Medium",
    "",
    MARKER,
    "",
  ].join("\n"),
  clean: "- **Mode:** full\n- **Finding count:** 0\n\nNo findings.\n",
  "header-count-without-headings": "- **Mode:** full\n- **Finding count:** 3\n\nNo headings.\n",
  "a header line shaped to be logged": `- **Mode:** full\n- **Max severity:** critical ${MARKER}\n- **Finding count:** 0\n`,
};

/**
 * A bin folder whose `gh` runs the gh shim with this node: executable
 * whatever the shim's mode on checkout, and with no shebang lookup.
 */
function shimBin(ctx) {
  const bin = join(ctx.work, "bin");
  const quote = (s) => `'${posixPath(s).replaceAll("'", "'\\''")}'`;
  write(
    join(bin, "gh"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(here, "shims", "gh"))} "$@"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

function deliveryCase(ctx, name) {
  const dir = join(ctx.work, name.replace(/[^A-Za-z0-9]+/g, "-"));
  mkdirSync(join(dir, "runner-temp"), { recursive: true });
  return {
    dir,
    log: join(dir, "shim-calls.jsonl"),
    env: (extra = {}) =>
      cleanEnv(ctx, {
        PATH: `${shimBin(ctx)}${delimiter}${process.env.PATH ?? ""}`,
        GITHUB_REPOSITORY: FAKE_REPOSITORY,
        RUNNER_TEMP: join(dir, "runner-temp"),
        GITHUB_OUTPUT: join(dir, "github-output"),
        DEEP_SCAN_SHIM_LOG: join(dir, "shim-calls.jsonl"),
        SECURITY_AUDIT_RUN_URL: `https://github.com/${FAKE_REPOSITORY}/actions/runs/1`,
        ...extra,
      }),
  };
}

function advisoryRequest(calls) {
  try {
    return JSON.parse(calls[0]?.stdin ?? "");
  } catch {
    return null;
  }
}

function publishAdvisory(ctx) {
  const results = [];
  const publish = (name, args, expectations, extraEnv) => {
    const c = deliveryCase(ctx, name);
    const r = run(bash(), [repoPath(PUBLISH), ...args(c.dir)], {
      cwd: c.dir,
      env: c.env(extraEnv),
    });
    const calls = records(c.log);
    const request = advisoryRequest(calls);
    const publicLog = r.stdout + r.stderr;
    const observed = `exit ${r.status}, ${calls.length} gh call(s)${request ? `, summary "${request.summary}"` : ""}`;
    results.push(verdict(name, expectations({ r, calls, request, publicLog }), observed));
  };
  const report = (dir, key) => {
    write(join(dir, "report.md"), REPORTS[key]);
    return join(dir, "report.md");
  };
  const notInLog = ({ publicLog }) => [!publicLog.includes(MARKER), "no finding text in the log"];

  for (const [key, summary] of [
    ["two-findings", "2 finding(s), max=high"],
    ["clean", "clean run"],
    ["header-count-without-headings", "FORMAT MISMATCH"],
  ]) {
    publish(
      `a ${key} report files one draft advisory`,
      (dir) => [report(dir, key)],
      (o) => [
        [o.r.status === 0, "exit 0"],
        [o.calls.length === 1, "one gh call"],
        [
          /\/security-advisories$/.test(
            o.calls[0]?.argv.find((a) => a.startsWith("/repos/")) ?? "",
          ),
          "a security-advisories request",
        ],
        [o.request?.summary?.includes(summary) ?? false, `a summary with "${summary}"`],
        notInLog(o),
      ],
    );
  }
  publish(
    "the finding text reaches the draft, not the log",
    (dir) => [report(dir, "two-findings")],
    (o) => [
      [o.request?.description?.includes(MARKER) ?? false, "the finding in the draft"],
      notInLog(o),
    ],
  );
  publish(
    "a header value outside its pattern is not logged",
    (dir) => [report(dir, "a header line shaped to be logged")],
    (o) => [
      [o.r.status === 0, "exit 0"],
      [/^Max severity: \(unrecognized\)$/m.test(o.r.stdout), "Max severity: (unrecognized)"],
      notInLog(o),
    ],
  );
  publish(
    "a missing report files nothing",
    (dir) => [join(dir, "no-such-report.md")],
    (o) => [
      [o.r.status !== 0, "a non-zero exit"],
      [o.calls.length === 0, "no gh call"],
    ],
  );
  publish(
    "an empty report files a failed-run draft with the transcript",
    (dir) => {
      write(join(dir, "session.md"), `transcript ${MARKER}\n`);
      return [join(dir, "no-report.md"), "", join(dir, "session.md"), "empty-report"];
    },
    (o) => [
      [o.r.status === 0, "exit 0"],
      [o.request?.summary?.includes("failed run") ?? false, 'a summary with "failed run"'],
      [o.request?.description?.includes(MARKER) ?? false, "the transcript in the draft"],
      notInLog(o),
    ],
  );
  return results;
}

function prComment(ctx) {
  const cases = [
    {
      name: "a count posts one counts-only comment",
      args: ["7", "2"],
      env: { GITHUB_TOKEN: FAKE_TOKEN },
      expect: ({ r, calls }) => [
        [r.status === 0, "exit 0"],
        [calls.length === 1, "one gh call"],
        [
          calls[0]?.argv.includes(`/repos/${FAKE_REPOSITORY}/issues/7/comments`),
          "the PR's comments",
        ],
        [
          calls[0]?.argv.some((a) =>
            /^body=Security audit completed with 2 Medium\+ finding\(s\)\./.test(a),
          ),
          "a counts-only body",
        ],
        [calls[0]?.tokenVariables.includes("GITHUB_TOKEN"), "a token set for gh"],
      ],
    },
    {
      name: "a count that is not a number posts nothing",
      args: ["7", "2; echo injected"],
      env: { GITHUB_TOKEN: FAKE_TOKEN },
      expect: ({ r, calls }) => [
        [r.status !== 0, "a non-zero exit"],
        [calls.length === 0, "no gh call"],
      ],
    },
    {
      name: "no token posts nothing",
      args: ["7", "2"],
      env: {},
      expect: ({ r, calls }) => [
        [r.status !== 0, "a non-zero exit"],
        [calls.length === 0, "no gh call"],
      ],
    },
    {
      name: "no arguments posts nothing",
      args: [],
      env: { GITHUB_TOKEN: FAKE_TOKEN },
      expect: ({ r, calls }) => [
        [r.status !== 0, "a non-zero exit"],
        [calls.length === 0, "no gh call"],
      ],
    },
  ];
  return cases.map((c) => {
    const d = deliveryCase(ctx, c.name);
    const r = run(bash(), [repoPath(COMMENT), ...c.args], { cwd: d.dir, env: d.env(c.env) });
    const calls = records(d.log);
    return verdict(c.name, c.expect({ r, calls }), `exit ${r.status}, ${calls.length} gh call(s)`);
  });
}

async function notifyEmail(ctx) {
  const results = [];
  const notify = async (name, { mode, configured, expect }) => {
    const d = deliveryCase(ctx, name);
    write(join(d.dir, "report.md"), REPORTS["two-findings"]);
    const shim = configured ? await startMailShim({ log: d.log }) : null;
    try {
      const env = configured
        ? {
            NOTIFY_EMAIL_TO: "maintainer@example.com",
            NOTIFY_EMAIL_FROM: "audit@example.com",
            NOTIFY_EMAIL_SMTP_HOST: "127.0.0.1",
            NOTIFY_EMAIL_SMTP_PORT: String(shim.port),
            NOTIFY_EMAIL_SMTP_USERNAME: "fixture-user",
            NOTIFY_EMAIL_SMTP_PASSWORD: "fixture-password-not-real",
          }
        : {};
      const r = await runAsync(
        bash(),
        [repoPath(NOTIFY), join(d.dir, "report.md"), ...(mode ? [mode] : [])],
        {
          cwd: d.dir,
          env: d.env(env),
        },
      );
      const commands = records(d.log).map((c) => c.command);
      results.push(
        verdict(
          name,
          expect({ r, commands }),
          `exit ${r.status}, SMTP commands: ${commands.join(" | ") || "none"}`,
        ),
      );
    } finally {
      await shim?.close();
    }
  };

  await notify("no mail settings skips the notice", {
    configured: false,
    expect: ({ r, commands }) => [
      [r.status === 0, "exit 0"],
      [/email notification skipped/.test(r.stdout), "a skipped line"],
      [commands.length === 0, "no SMTP connection"],
    ],
  });
  await notify("no mail settings on a failed publish says the report is lost", {
    mode: "publish-failed",
    configured: false,
    expect: ({ r }) => [
      [r.status !== 0, "a non-zero exit"],
      [/is lost/.test(r.stdout), "a line saying the report is lost"],
    ],
  });
  const python = run(
    bash(),
    ["-c", "command -v python3 >/dev/null && python3 -c 'import smtplib, ssl'"],
    // Short: Windows' app-store python3 stub can hang instead of failing.
    { cwd: ctx.work, env: cleanEnv(ctx), timeout: 5_000 },
  );
  if (python.status !== 0) {
    results.push({
      name: "a server without TLS never gets the password",
      status: "skip",
      detail: "no python3 with smtplib on this host",
    });
    return results;
  }
  await notify("a server without TLS never gets the password", {
    configured: true,
    expect: ({ r, commands }) => [
      [r.status !== 0, "a non-zero exit (TLS is required)"],
      // SMTP verbs are case-insensitive; smtplib sends them in lower case.
      [/^EHLO /i.test(commands[0] ?? ""), "EHLO first"],
      [commands.some((c) => /^STARTTLS$/i.test(c)), "a STARTTLS attempt"],
      [!commands.some((c) => /^(AUTH|MAIL|RCPT|DATA)\b/i.test(c)), "no AUTH, MAIL, RCPT or DATA"],
      [!(r.stdout + r.stderr).includes("fixture-password-not-real"), "no password in the output"],
    ],
  });
  return results;
}

// ---------------------------------------------------------------- the CLI

const CLI = "cli/bin/agent-kit.mjs";
const TAG = "v1.0.0-beta.10";

/** A crafted Consumer repository from consumer/, as a git repository. */
function consumer(ctx, name, { extraPins = [] } = {}) {
  const root = join(ctx.work, name.replace(/[^A-Za-z0-9]+/g, "-"));
  const copy = (from, to) => {
    for (const entry of readdirSync(from)) {
      const source = join(from, entry);
      const target = join(to, entry.startsWith("dot-") ? `.${entry.slice(4)}` : entry);
      if (statSync(source).isDirectory()) {
        mkdirSync(target, { recursive: true });
        copy(source, target);
      } else {
        copyFileSync(source, target);
      }
    }
  };
  mkdirSync(root, { recursive: true });
  copy(join(here, "consumer"), root);
  extraPins.forEach((tag, i) => {
    write(
      join(root, ".github", "workflows", `extra-${i + 1}.yml`),
      `name: extra\non: workflow_dispatch\njobs:\n  plan:\n    uses: mnaimfaizy/agent-kit/.github/workflows/agent-plan-reusable.yml@${tag}\n`,
    );
  });
  const env = cleanEnv(ctx);
  git(["init", "--quiet", "--initial-branch=main"], { cwd: root, env });
  git(["add", "."], { cwd: root, env });
  git(["commit", "--quiet", "-m", "fixture consumer"], { cwd: root, env });
  return root;
}

/** A local listener the tag fetch is pointed at: it records each connection and closes it. */
async function sentinel() {
  let reached = 0;
  const server = createServer((socket) => {
    reached++;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `https://127.0.0.1:${server.address().port}`,
    reached: () => reached,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function cliCases(ctx, cases) {
  const results = [];
  const bin = shimBin(ctx);
  for (const c of cases) {
    if (c.needsGhShim && process.platform === "win32") {
      // Without a shell, Windows finds a real gh.exe before the shim; never run it.
      results.push({
        name: c.name,
        status: "skip",
        detail: "the CLI would find a real gh.exe, not the shim",
      });
      continue;
    }
    const cwd = c.cwd === "plain" ? join(ctx.work, "not-a-repository") : consumer(ctx, c.name, c);
    mkdirSync(cwd, { recursive: true });
    const tagServer = await sentinel();
    const log = join(ctx.work, `${c.name.replace(/[^A-Za-z0-9]+/g, "-")}.gh-calls.jsonl`);
    try {
      const r = await runAsync(process.execPath, [repoPath(CLI), ...c.args], {
        cwd,
        env: cleanEnv(ctx, {
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          GITHUB_SERVER_URL: tagServer.url,
          DEEP_SCAN_SHIM_LOG: log,
        }),
      });
      const out = r.stdout + r.stderr;
      const fetched = tagServer.reached() > 0;
      const checks = [
        [r.status === c.exit, `exit ${c.exit}`],
        [fetched === c.fetch, c.fetch ? "the tag fetch reached" : "no tag fetch"],
        ...(c.says ?? []).map((pattern) => [pattern.test(out), `output matching ${pattern}`]),
        ...(c.ghCalls === undefined
          ? []
          : [[records(log).length >= c.ghCalls, `${c.ghCalls}+ gh call(s)`]]),
      ];
      const first = out.trim().split("\n").at(-1)?.slice(0, 160) ?? "";
      results.push(
        verdict(
          c.name,
          checks,
          `exit ${r.status}, ${fetched ? "tag fetch reached" : "no tag fetch"}: ${first}`,
        ),
      );
    } finally {
      await tagServer.close();
    }
  }
  return results;
}

const ANSWERS = ["--tag", TAG, "--flows", "audit", "--actors", "fixture-maintainer", "--yes"];
const withAnswer = (flag, value) => {
  const args = [...ANSWERS];
  args[args.indexOf(flag) + 1] = value;
  return args;
};

function cliInit(ctx) {
  return cliCases(ctx, [
    { name: "no answers and no terminal", args: ["init"], exit: 2, fetch: false, says: [/--yes/] },
    {
      name: "a tag that is not a Release-line tag",
      args: ["init", ...withAnswer("--tag", "main")],
      exit: 2,
      fetch: false,
    },
    {
      name: "an unknown flow",
      args: ["init", ...withAnswer("--flows", "everything")],
      exit: 2,
      fetch: false,
    },
    {
      name: "an Allowlist login with shell characters",
      args: ["init", ...withAnswer("--actors", "alice;id")],
      exit: 2,
      fetch: false,
    },
    {
      name: "an option init does not take",
      args: ["init", ...ANSWERS, "--ci"],
      exit: 2,
      fetch: false,
    },
    {
      name: "outside a git repository",
      cwd: "plain",
      args: ["init", ...ANSWERS],
      exit: 1,
      fetch: false,
      says: [/not a git repository/],
    },
    {
      name: "valid answers stop at the tag fetch",
      args: ["init", ...ANSWERS],
      exit: 1,
      fetch: true,
      says: [/could not fetch/],
    },
  ]);
}

function cliUpgrade(ctx) {
  return cliCases(ctx, [
    { name: "no tag and no terminal", args: ["upgrade"], exit: 2, fetch: false, says: [/--tag/] },
    {
      name: "a tag that is not a Release-line tag",
      args: ["upgrade", "--tag", "latest", "--yes"],
      exit: 2,
      fetch: false,
    },
    {
      name: "a --from that is not a Release-line tag",
      args: ["upgrade", "--tag", TAG, "--from", "v1", "--yes"],
      exit: 2,
      fetch: false,
    },
    {
      name: "outside a git repository",
      cwd: "plain",
      args: ["upgrade", "--tag", TAG, "--yes"],
      exit: 1,
      fetch: false,
      says: [/not a git repository/],
    },
    {
      name: "pins at two tags",
      extraPins: ["v1.0.0-beta.8"],
      args: ["upgrade", "--tag", TAG, "--yes"],
      exit: 1,
      fetch: false,
      says: [/same Release-line tag/],
    },
    {
      name: "a --from the pins do not name",
      args: ["upgrade", "--tag", TAG, "--from", "v1.0.0-beta.7", "--yes"],
      exit: 1,
      fetch: false,
      says: [/neither/],
    },
    {
      name: "a valid upgrade stops at the tag fetch",
      args: ["upgrade", "--tag", TAG, "--yes"],
      exit: 1,
      fetch: true,
      says: [/could not fetch/],
    },
  ]);
}

function cliDoctor(ctx) {
  return cliCases(ctx, [
    {
      name: "CI mode warns about the invalid Scan recipe and stops at the tag fetch",
      args: ["doctor", "--ci"],
      exit: 1,
      fetch: true,
      says: [/max_turns/],
    },
    {
      name: "with gh refusing, it falls back to CI mode",
      args: ["doctor"],
      exit: 1,
      fetch: true,
      says: [/gh could not read the repository/],
      ghCalls: 1,
      needsGhShim: true,
    },
    {
      name: "pins at two tags compare against no tag",
      extraPins: ["v1.0.0-beta.8"],
      args: ["doctor", "--ci"],
      exit: 1,
      fetch: false,
      says: [/No single pinned tag/],
    },
    {
      name: "a --repo that is not owner/name",
      args: ["doctor", "--repo", "not a repo"],
      exit: 2,
      fetch: false,
    },
    {
      name: "outside a git repository",
      cwd: "plain",
      args: ["doctor", "--ci"],
      exit: 1,
      fetch: false,
      says: [/not a git repository/],
    },
  ]);
}

// ---------------------------------------------------------------- main

const FIXTURES = {
  "read-confinement": { drives: READ_HOOK, run: readConfinement },
  "write-confinement": { drives: WRITE_HOOK, run: writeConfinement },
  "push-guard": { drives: PUSH_HOOK, run: pushGuard },
  "git-config": { drives: GIT_CONFIG_CHECK, run: gitConfig },
  "publish-advisory": { drives: PUBLISH, run: publishAdvisory },
  "pr-comment": { drives: COMMENT, run: prComment },
  "notify-email": { drives: NOTIFY, run: notifyEmail },
  "cli-init": { drives: `${CLI} init`, run: cliInit },
  "cli-upgrade": { drives: `${CLI} upgrade`, run: cliUpgrade },
  "cli-doctor": { drives: `${CLI} doctor`, run: cliDoctor },
};

const name = process.argv[2];
if (!Object.hasOwn(FIXTURES, name ?? "")) {
  console.error(`usage: drive.mjs <fixture>\nfixtures: ${Object.keys(FIXTURES).join(", ")}`);
  process.exit(2);
}
const base =
  process.env.DEEP_SCAN_FIXTURE_DIR || mkdtempSync(join(tmpdir(), "agent-kit-fixtures-"));
const work = mkdtempSync(join(base, `${name}-`));
const ctx = { work, home: join(work, "home"), tmp: join(work, "tmp") };
mkdirSync(ctx.home, { recursive: true });
mkdirSync(ctx.tmp, { recursive: true });
ctx.emptyGitConfig = join(ctx.home, "empty.gitconfig");
writeFileSync(ctx.emptyGitConfig, "");

console.log(`Fixture: ${name}`);
console.log(`Drives: ${FIXTURES[name].drives}`);
console.log(`Scratch: ${posixPath(work)}`);
const results = await FIXTURES[name].run(ctx);
for (const r of results) {
  const label = { ok: "ok  ", DIFF: "DIFF", skip: "skip" }[r.status];
  console.log(`${label} ${r.name}: ${r.detail}`);
}
const diffs = results.filter((r) => r.status === "DIFF").length;
const skips = results.filter((r) => r.status === "skip").length;
console.log(
  `${results.length} case(s): ${results.length - diffs - skips} ok, ${diffs} DIFF, ${skips} skipped.`,
);
process.exit(diffs ? 1 : 0);
