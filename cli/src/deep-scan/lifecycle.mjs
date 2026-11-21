// The Deep scan sandbox lifecycle (#369), from image to teardown, on the
// runtime `selectRuntime` chose. In order: prepare the image (with a pinned
// Claude Code, its auto-updater off); start the sandbox with no mount; copy
// in an export of the trusted ref (never the working tree) and the grounding
// files, and nothing else; run the setup phase (`setup`, `start`, `ready`,
// `seed`) with no agent and no model credential, its egress limited to the
// recipe's `registries`; cut the network and check from the host that it is
// cut; open the model route (the key-injecting model proxy on the host, the
// scan's only way out) and check from the host that nothing else is open;
// hand the agent its brief and run the real Claude Code (#370); copy out the
// one report file; and destroy the sandbox on every exit path, an interrupt
// included. The real model credential reaches only the model proxy, in this
// process: the sandbox gets a placeholder.
//
// Every run is bounded from out here (#371): the setup wall clock runs from
// the image step until the agent step starts, the scan wall clock over the
// agent step, Claude Code runs with the launcher's `--max-turns`, and the
// model proxy refuses requests past the token cap. A limit that fires stops
// the running step through the same seam an interrupt does, then the report
// it left is copied out with the launcher's `Stopped:` line, and the sandbox
// is torn down as on every exit path.
//
// The runtime's own commands live in a driver: docker-driver.mjs (gVisor,
// Kata, Firecracker, Docker Desktop on macOS) and sbx-driver.mjs (Docker
// Sandboxes). This module owns the order, the output and every refusal.

import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstLine } from "../exec.mjs";
import { agentBrief, agentEnv, agentScript, BRIEF_PATH, TURNS_MARKER } from "./agent.mjs";
import { CLAUDE_CODE_VERSION, layerDockerfile } from "./claude-code.mjs";
import { dockerDriver, LABEL } from "./docker-driver.mjs";
import {
  LimitReached,
  STOPPED_EXIT,
  stoppedStatus,
  TOKENS,
  TURNS,
  WALL_CLOCK,
  withStopped,
} from "./limits.mjs";
import { startModelProxy } from "./model-proxy.mjs";
import { sbxDriver } from "./sbx-driver.mjs";
import { ENDS_HERE, indent, Interrupted, outputLines, StepFailed } from "./steps.mjs";
import { tarOf } from "./tar.mjs";
import { checkVerificationReport, FINDINGS_PATH, verificationBrief } from "./verify.mjs";

export { CLAUDE_CODE_VERSION, LABEL, layerDockerfile };

/** Where the sandbox holds the repository, the grounding and the report. */
export const WORKSPACE = "/workspace";
export const GROUNDING_DIR = "/agent-kit/grounding";
export const REPORT_PATH = "/agent-kit/out/report.md";

export const MAX_REPORT_BYTES = 10 * 1024 * 1024;
export const MAX_GROUNDING_BYTES = 10 * 1024 * 1024;
/**
 * The largest `git archive` export deep-scan holds to copy in (the tree, a
 * grounding path, a Dockerfile's build context): above the runner's default
 * output cap, which a repository with a few bundled assets would pass.
 */
export const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
const GROUNDING_TIMEOUT_MS = 60_000;

/** What the Agent step line says for a model or effort not asked for. */
const CLAUDE_DEFAULT = "Claude Code's default";

/** Why a line is withheld from a world-readable log. */
const PUBLIC_LOG = "the Public-log rule: this log is world-readable in GitHub Actions";

/**
 * The line a run prints when the model API answered every request with a
 * 401 or 403: the credential's kind and where it came from (a variable's
 * name, or 1Password), never its value.
 * @param {"api-key" | "subscription"} kind
 * @param {string} from
 */
function credentialRefusedLine(kind, from) {
  const what =
    kind === "subscription"
      ? `the Claude subscription token from ${from} was not accepted (its value is not shown). Make a fresh one with claude setup-token, then run deep-scan again.`
      : `the API key from ${from} was not accepted (its value is not shown). Check that the key is current and its Anthropic Console workspace is active, then run deep-scan again.`;
  return `The model API refused the credential: every answer was 401 or 403, so ${what}`;
}

/** How many lines of Claude Code's error output a failed agent step shows. */
const AGENT_ERROR_LINES = 20;

/** The setup phase's fields, in the order they run: services before seeding. */
const SETUP_ORDER = ["setup", "start", "ready", "seed"];

/**
 * What a runtime's driver does for each lifecycle step. Each step throws
 * StepFailed (the run ends before the agent step) or Interrupted.
 * @typedef {{
 *   container: string,
 *   prepare: (steps: object, ctx: { archive: Function, out: Function, branch: string, short: string }) => Promise<void>,
 *   start: (steps: object) => Promise<void>,
 *   copyIn: (tar: Buffer, what: string) => Promise<void>,
 *   installAgent: (out: Function) => Promise<void>,
 *   openSetupEgress: (registries: string[]) => Promise<{ env: string[], note: string }>,
 *   refused: () => string[],
 *   exec: (script: string, opts?: { env?: string[], workdir?: string | null }) => Promise<import("../exec.mjs").StartResult>,
 *   cutEgress: () => Promise<void>,
 *   egressLeft: () => Promise<string | null>,
 *   openModelRoute: (startProxy: (bind: string) => Promise<{ port: number, close: () => Promise<void> }>) => Promise<{ url: string, note: string, caveat?: string }>,
 *   copyOut: (path: string, opts: { maxBytes: number }) => Promise<{ name: string, data: Buffer } | { error: string } | { missing: import("../exec.mjs").StartResult }>,
 *   close: () => Promise<void>,
 *   teardown: () => Array<{ what: string, cmd: string, args: string[] }>,
 *   cleanup?: () => void,
 * }} Driver
 */

/**
 * Run the sandbox lifecycle. Returns the exit code: 0 the report came out,
 * 1 a step failed (or the agent step did, or teardown could not finish),
 * 3 a limit stopped the run, 130 or 143 interrupted by SIGINT or SIGTERM.
 *
 * @param {{
 *   runner: import("../exec.mjs").Runner,
 *   runtime: import("./runtime.mjs").Runtime,
 *   root: string,
 *   branch: string,
 *   commit: string,
 *   steps: ReturnType<typeof import("./recipe.mjs").recipeSteps>,
 *   handIn: import("./agent.mjs").HandIn,
 *   recipePath: string,
 *   recipeText: string,
 *   credential: string,
 *   credentialKind?: "api-key" | "subscription",
 *   credentialFrom?: string,
 *   limits: import("./limits.mjs").Limits,
 *   model?: string,
 *   effort?: string,
 *   timers: { setTimeout: Function, clearTimeout: Function },
 *   modelApi?: string,
 *   platform: string,
 *   fetch: typeof globalThis.fetch,
 *   signals: { on: Function, off: Function },
 *   reportDir?: string,
 *   reportFile?: string,
 *   publicLog?: boolean,
 *   target?: { name: string, commit: string },
 *   verification?: Verification,
 *   out: (s: string) => void,
 *   err: (s: string) => void,
 * }} opts  `target` is the ref copied in as the repository, when it is not
 *   the default branch's tip (`branch` and `commit`), which the grounding
 *   and a recipe's Dockerfile still come from. `verification` makes the run
 *   a Verification run (verify.mjs).
 * @returns {Promise<number>}
 *
 * @typedef {{
 *   findings: import("./verify.mjs").Finding[],
 *   data: Buffer,
 *   procedure: string,
 * }} Verification
 */
export async function runLifecycle(opts) {
  const { runner, runtime, platform, out, err, signals } = opts;
  const controller = new AbortController();
  const { signal } = controller;
  const handlers = Object.fromEntries(
    ["SIGINT", "SIGTERM"].map((sig) => [
      sig,
      () => {
        if (signal.aborted) return;
        err(`Interrupted (${sig}): stopping the current step and destroying the sandbox.`);
        controller.abort(sig);
      },
    ]),
  );
  for (const [sig, handler] of Object.entries(handlers)) signals.on(sig, handler);

  const interrupted = () => new Interrupted(String(signal.reason ?? "SIGINT"));

  // The phase clocks. A limit aborts only the phase's own controller, so the
  // steps after it (the copy-out, the teardown) still run.
  const { timers, limits } = opts;
  /** @type {{ controller: AbortController, timer: unknown } | null} */
  let phase = null;
  /** @type {{ limit: string, detail: string } | null} */
  let stopped = null;
  const stop = (limit, detail) => {
    if (stopped || signal.aborted) return;
    stopped = { limit, detail };
    err(`${stoppedStatus(stopped)} Stopping the current step.`);
    phase?.controller.abort(stopped);
  };
  const clocks = {
    begin(name, minutes) {
      const controller = new AbortController();
      const timer = timers.setTimeout(
        () => stop(WALL_CLOCK, `the ${name} phase's ${minutes}-minute limit`),
        minutes * 60_000,
      );
      phase = { controller, timer };
      if (stopped) controller.abort(stopped);
    },
    end() {
      if (phase) timers.clearTimeout(phase.timer);
      phase = null;
    },
    stop,
    stopped: () => stopped,
    /** The signal a step stops on: an interrupt, or its phase's limit. */
    signal: () => (phase ? AbortSignal.any([signal, phase.controller.signal]) : signal),
    /** What a step stopped by `clocks.signal()` throws. */
    reason: () => (signal.aborted ? interrupted() : new LimitReached(stopped)),
  };

  /** @type {import("./docker-driver.mjs").Call} */
  const call = async (cmd, args, { stdin, cwd } = {}) => {
    const stepSignal = clocks.signal();
    if (stepSignal.aborted) throw clocks.reason();
    const r = await runner.start(cmd, args, { stdin, cwd, signal: stepSignal });
    if (r.aborted || stepSignal.aborted) throw clocks.reason();
    // Ctrl+C in a terminal reaches the runtime's child too, and can end it
    // before the handler above runs: that is an interrupt, not a failure.
    if (r.signal === "SIGINT" || r.signal === "SIGTERM") throw new Interrupted(r.signal);
    return r;
  };
  const id = randomBytes(6).toString("hex");
  const driver =
    runtime.id === "sbx" ? sbxDriver({ id, call }) : dockerDriver({ runtime, platform, id, call });

  let code;
  let thrown = null;
  try {
    code = await lifecycle({ ...opts, driver, clocks });
  } catch (e) {
    if (e instanceof LimitReached) {
      // A limit before the agent step: there is no report to deliver.
      out(`${stoppedStatus(e.stop)} No report came out: nothing was written, filed or posted.`);
      code = STOPPED_EXIT;
    } else if (e instanceof Interrupted) {
      code = e.signal === "SIGTERM" ? 143 : 130;
    } else if (e instanceof StepFailed) {
      err(e.lines.join("\n"));
      code = 1;
    } else {
      thrown = e;
    }
  }
  clocks.end();
  await driver.close();
  const tornDown = teardown(runner, driver.teardown(), out, err);
  driver.cleanup?.();
  for (const [sig, handler] of Object.entries(handlers)) signals.off(sig, handler);
  if (thrown) throw thrown;
  return (code === 0 || code === STOPPED_EXIT) && !tornDown ? 1 : code;
}

async function lifecycle({
  runner,
  runtime,
  root,
  branch,
  commit,
  steps,
  handIn,
  recipePath,
  recipeText,
  credential,
  credentialKind = "api-key",
  credentialFrom = "its source",
  limits,
  model,
  effort,
  modelApi,
  fetch,
  reportDir,
  reportFile,
  publicLog = false,
  target = { name: branch, commit },
  verification,
  out,
  err,
  driver,
  clocks,
}) {
  const short = commit.slice(0, 12);
  // The setup wall clock: from the image step until the agent step starts.
  clocks.begin("setup", limits.setupMinutes);
  // The committed bytes: no line-end conversion from the host's git config.
  const archive = ({ prefix, paths, ref = commit } = {}, what) => {
    const r = runner(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-C",
        root,
        "archive",
        "--format=tar",
        ...(prefix ? [`--prefix=${prefix}`] : []),
        ref,
        ...(paths ? ["--", ...paths] : []),
      ],
      { encoding: "buffer", maxBuffer: MAX_EXPORT_BYTES },
    );
    if (r.code === "ENOBUFS") {
      throw new StepFailed([
        `FAILED  ${what}: the export is larger than ${MAX_EXPORT_BYTES / 1024 / 1024} MiB, the most deep-scan holds in memory to copy in; keep large files out of what it exports.`,
        ENDS_HERE,
      ]);
    }
    if (r.status !== 0) {
      throw new StepFailed([
        `FAILED  ${what}: ${firstLine(r.stderr) || `git archive exit ${r.status}`}`,
        ENDS_HERE,
      ]);
    }
    return r.stdout;
  };

  // 1. Image, and its pinned Claude Code (or the runtime's refusal).
  await driver.prepare(steps, { archive, out, branch, short });

  // 2. The sandbox: no mount, no host environment, no Docker socket.
  out(`Sandbox: starting ${driver.container} on ${runtime.name}.`);
  await driver.start(steps);

  // 3. Copy in: the trusted ref's tree (a Verification run's: the ref the
  // maintainer named), then the grounding, and nothing else.
  const targetShort = target.commit.slice(0, 12);
  await driver.copyIn(
    archive({ prefix: "workspace/", ref: target.commit }, `export ${target.name} (${targetShort})`),
    "copying the repository in",
  );
  out(
    `Copied in: ${target.name} at ${targetShort} (a git archive, not your working tree) to ${WORKSPACE}.`,
  );
  const fetched = [];
  /** Each grounding source, and where the agent finds it. */
  const grounding = [];
  for (const [i, source] of steps.grounding.entries()) {
    const where = `grounding[${i}]`;
    if (/^https?:\/\//i.test(source)) {
      const path = `agent-kit/grounding/urls/${i}-${basename(source)}`;
      fetched.push({
        path,
        data: await fetchGrounding(fetch, source, where, clocks),
      });
      grounding.push({ source, at: `/${path}` });
    } else {
      grounding.push({ source, at: `${GROUNDING_DIR}/${source}` });
      const files = archive(
        { prefix: "agent-kit/grounding/", paths: [source] },
        `${where}: ${source} is not on ${branch}`,
      );
      await driver.copyIn(files, `copying ${where} in`);
    }
  }
  if (fetched.length) {
    const tar = tarOf([
      { path: "agent-kit", dir: true },
      { path: "agent-kit/grounding", dir: true },
      { path: "agent-kit/grounding/urls", dir: true },
      ...fetched,
    ]);
    await driver.copyIn(tar, "copying the fetched grounding in");
  }
  if (steps.grounding.length) {
    out(`Copied in: ${steps.grounding.length} grounding source(s) to ${GROUNDING_DIR}.`);
  }

  // 4. The setup phase: no agent, no model credential, egress only to the
  // registries, and only for these steps.
  await driver.installAgent(out);
  const egress = await driver.openSetupEgress(steps.registries);
  out(`Setup: ${egress.note}.`);
  for (const field of SETUP_ORDER) {
    for (const [i, command] of steps[field].entries()) {
      const what = `${field}[${i}]`;
      // A service started in the background keeps its output in a log, so
      // the step returns; the log is shown if start or ready fails.
      const script =
        field === "start"
          ? `mkdir -p /agent-kit/logs\nexec >>/agent-kit/logs/start-${i}.log 2>&1\n${command}`
          : command;
      const r = await driver.exec(script, { env: egress.env });
      if (r.status === 0) {
        out(`Setup: ${what} ok.`);
        continue;
      }
      const lines = [
        `FAILED  ${what} exited ${r.status ?? "abnormally"}: the run ends here, before the agent step.`,
        `Command: ${command}`,
        ...outputLines(r),
      ];
      if (field === "start" || field === "ready") {
        const logs = await driver.exec("cat /agent-kit/logs/start-*.log 2>/dev/null || true", {
          workdir: null,
        });
        const text = logs.stdout.toString("utf8").trimEnd();
        if (text) lines.push("Output of start:", ...indent(text));
      }
      const refused = driver.refused();
      if (refused.length) {
        lines.push(
          `The setup proxy refused: ${[...new Set(refused)].join(", ")} (not in registries).`,
        );
      }
      throw new StepFailed(lines);
    }
  }

  // 5. Cut the network, and check from the host that it is cut.
  await driver.cutEgress();
  const left = await driver.egressLeft();
  if (left !== null) {
    throw new StepFailed([`FAILED  the network is not cut: ${left}.`, ENDS_HERE]);
  }
  out("Network: cut (checked from the host); the agent step has no network.");

  // 6. The model route: the key-injecting model proxy on this machine, the
  // scan's only way out, and the check from the host that nothing else is.
  let proxy = null;
  const route = await driver.openModelRoute(async (bind) => {
    proxy = await startModelProxy({
      credential,
      kind: credentialKind,
      bind,
      maxTokens: limits.tokens,
      onCap: () => clocks.stop(TOKENS, `the run's ${limits.tokens}-token cap`),
      ...(modelApi !== undefined ? { upstream: modelApi } : {}),
    });
    return proxy;
  });
  const extra = await driver.egressLeft();
  if (extra !== null) {
    throw new StepFailed([`FAILED  more than the model route is open: ${extra}.`, ENDS_HERE]);
  }
  out(
    `Model route: only the model proxy on your machine (${route.note}), which forwards to the model API alone, with your ${credentialKind === "subscription" ? "token as its bearer value" : "key"}; checked from the host.`,
  );
  if (route.caveat) out(`Note: ${route.caveat}`);

  // 7. The agent step: Claude Code with a placeholder key, handed its brief.
  // A Verification run's finding file goes in with it, after the setup phase
  // and the cut, so no setup step, which has registry egress, can read it.
  const paths = { workspace: WORKSPACE, grounding: GROUNDING_DIR, report: REPORT_PATH };
  // The subscription path runs Claude Code without --bare (#375).
  const subscription = credentialKind === "subscription";
  const brief = verification
    ? verificationBrief({
        ref: target.name,
        short: targetShort,
        findings: verification.findings,
        procedure: verification.procedure,
        recipePath,
        recipeText,
        handIn,
        grounding,
        paths,
        discovers: subscription,
      })
    : agentBrief({
        branch,
        short,
        recipePath,
        recipeText,
        handIn,
        grounding,
        paths,
        discovers: subscription,
      });
  await driver.copyIn(
    tarOf([
      { path: "agent-kit", dir: true },
      { path: "agent-kit/in", dir: true },
      { path: BRIEF_PATH.slice(1), data: Buffer.from(brief, "utf8") },
      ...(verification ? [{ path: FINDINGS_PATH.slice(1), data: verification.data }] : []),
    ]),
    verification
      ? "copying the launcher's brief and the finding file in"
      : "copying the launcher's brief in",
  );
  out(
    `Agent step: Claude Code ${CLAUDE_CODE_VERSION} (${subscription ? "no --bare: the subscription path, with a placeholder token; project settings and MCP servers not loaded" : "--bare, a placeholder key"}, web tools off, at most ${limits.turns} turns; requested model: ${model ?? CLAUDE_DEFAULT}, effort: ${effort ?? CLAUDE_DEFAULT}), handed ${verification ? "the Verification-run procedure, the finding file" : "the deep procedure"}, the Threat pack and the Scan recipe.`,
  );
  clocks.end();
  // The scan wall clock: the agent step alone.
  clocks.begin("scan", limits.scanMinutes);
  /** @type {import("../exec.mjs").StartResult | null} null when a limit stopped it */
  let agent = null;
  try {
    agent = await driver.exec(
      agentScript({
        baseUrl: route.url,
        report: REPORT_PATH,
        workspace: WORKSPACE,
        maxTurns: limits.turns,
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        kind: credentialKind,
      }),
      { env: agentEnv(credentialKind) },
    );
  } catch (e) {
    if (!(e instanceof LimitReached)) throw e;
  }
  clocks.end();
  // Claude Code's own turn limit ended it: the script's fixed marker says so.
  if (agent && agent.stdout.toString("utf8").split(/\r?\n/).includes(TURNS_MARKER)) {
    clocks.stop(TURNS, `Claude Code's ${limits.turns}-turn limit`);
  }
  // The scan is over: no route out is left open while the report comes out.
  await driver.close();
  // The proxy's summary names what the agent sent: refused hosts and paths,
  // and the model API's answers. A public log gets none of it.
  out(
    publicLog
      ? `Model proxy: ${proxy ? "closed" : "not started"} (${PUBLIC_LOG}).`
      : `Model proxy: ${proxy?.summary() ?? "not started"}.`,
  );
  // Every answer a 401 or 403: say plainly that the credential was refused,
  // its kind and where it came from, never its value. Locally only: a public
  // log gets none of the model API's answers.
  if (!publicLog && proxy?.credentialRefused())
    err(credentialRefusedLine(credentialKind, credentialFrom));
  const stopped = clocks.stopped();
  if (stopped) {
    out(`${stoppedStatus(stopped)} Copying out what report the agent left.`);
  } else if (agent && agent.status !== 0 && publicLog) {
    err(
      `The agent step exited ${agent.status ?? "abnormally"}; copying out what report it left. Claude Code's error output stays in the sandbox (${PUBLIC_LOG}); run deep-scan locally to see it.`,
    );
  } else if (agent && agent.status !== 0) {
    const lines = agent.stderr
      .trimEnd()
      .split(/\r\n|\r|\n/)
      .filter(Boolean);
    err(
      [
        `The agent step exited ${agent.status ?? "abnormally"}; copying out what report it left.`,
        ...(lines.length
          ? [
              `Claude Code's error output (its last ${AGENT_ERROR_LINES} lines at most; the rest of its output stays in the sandbox):`,
              ...indent(lines.slice(-AGENT_ERROR_LINES).join("\n")),
            ]
          : []),
      ].join("\n"),
    );
  }

  // 8. Copy out the one report file, and nothing else.
  const file = await driver.copyOut(REPORT_PATH, { maxBytes: MAX_REPORT_BYTES });
  if ("missing" in file && stopped) {
    // A stop with no report: only a status naming the limit, and no file.
    out(`${stoppedStatus(stopped)} No report came out: nothing was written, filed or posted.`);
    return STOPPED_EXIT;
  }
  if ("missing" in file) {
    const r = file.missing;
    throw new StepFailed([
      `FAILED  no report at ${REPORT_PATH}: ${firstLine(r.stderr) || `exit ${r.status}`}`,
    ]);
  }
  if ("error" in file) {
    throw new StepFailed([
      publicLog
        ? `FAILED  the report was not copied out (why stays out of the log: ${PUBLIC_LOG}).`
        : `FAILED  the report was not copied out: ${file.error}.`,
      ...(stopped ? [stoppedStatus(stopped)] : []),
    ]);
  }
  const path =
    reportFile ??
    join(reportDir ?? mkdtempSync(join(tmpdir(), "agent-kit-deep-scan-")), "report.md");
  // The launcher's Stopped: line, when a limit ended the run; never the agent's.
  const report = withStopped(file.data, stopped?.limit ?? null);
  writeFileSync(path, report, { mode: 0o600, flag: "wx" });
  out(
    `Report: ${path} (the only file copied out of the sandbox${stopped ? `, partial: marked Stopped: ${stopped.limit}` : ""}).`,
  );
  if (verification) {
    // Locally only: --verify is refused in CI, so no public log sees this.
    const { answers, problems } = checkVerificationReport(
      report.toString("utf8"),
      verification.findings,
    );
    if (answers.length) {
      out(
        [
          "Verification:",
          ...answers.map(
            (a) =>
              `  - ${a.conceptId}: Reproduced: ${a.reproduced} (${a.reproduced === "yes" ? "the fix does not hold" : "the fix holds"})`,
          ),
        ].join("\n"),
      );
    }
    if (problems.length && !stopped) {
      err(
        [
          "The report does not answer every given finding in the Verification-run variant:",
          ...problems.map((p) => `  - ${p}`),
        ].join("\n"),
      );
    }
    out(
      "Nothing was filed or posted. A Verification run's report stays on your machine: file no advisory, comment or ledger note from it.",
    );
    if (stopped) return STOPPED_EXIT;
    return agent?.status === 0 && !problems.length ? 0 : 1;
  }
  out(
    publicLog
      ? "Nothing was filed or posted by deep-scan: in CI, the workflow's delivery steps file the report privately."
      : "Nothing was filed or posted. To file a draft advisory, follow the security-audit skill's by-hand rule.",
  );
  if (stopped) return STOPPED_EXIT;
  return agent?.status === 0 ? 0 : 1;
}

/**
 * Run each teardown command, whatever happened before. Synchronous, so it
 * finishes even while an interrupt is pending.
 * @returns {boolean} whether nothing was left behind
 */
function teardown(runner, commands, out, err) {
  if (!commands.length) return true;
  const left = [];
  for (const { what, cmd, args } of commands) {
    const r = runner(cmd, args);
    if (r.status !== 0 && !/no such|not found/i.test(r.stderr)) {
      left.push(`${what}: ${firstLine(r.stderr) || `exit ${r.status}`}`);
    }
  }
  if (left.length) {
    err(
      [
        "TEARDOWN  could not remove:",
        ...left.map((l) => `  - ${l}`),
        `Remove them by hand; every Docker resource carries the label ${LABEL}, and every sandbox's name starts with agent-kit-deep-.`,
      ].join("\n"),
    );
    return false;
  }
  out(`Teardown: removed ${commands.map((c) => c.what).join(", ")}.`);
  return true;
}

async function fetchGrounding(fetch, url, where, clocks) {
  const fail = (why) =>
    new StepFailed([`FAILED  ${where}: could not fetch ${url}: ${why}`, ENDS_HERE]);
  const tooLarge = `larger than ${MAX_GROUNDING_BYTES / 1024 / 1024} MiB`;
  // The request and the body read share one error path: an interrupt or a
  // limit that fires mid-download stops the run as it would anywhere else.
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.any([clocks.signal(), AbortSignal.timeout(GROUNDING_TIMEOUT_MS)]),
    });
    if (!res.ok) throw fail(`HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? "0") > MAX_GROUNDING_BYTES) {
      throw fail(tooLarge);
    }
    // Counted as it streams, so a body with no content-length is never held
    // whole past the cap.
    const chunks = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_GROUNDING_BYTES) {
          reader.cancel().catch(() => {});
          throw fail(tooLarge);
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks);
  } catch (e) {
    if (clocks.signal().aborted) throw clocks.reason();
    if (e instanceof StepFailed) throw e;
    throw fail(e?.message ?? String(e));
  }
}

/** A file name for a fetched URL: its last path segment, made safe. */
function basename(url) {
  let segment = "";
  try {
    segment = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  } catch {
    segment = "";
  }
  const safe = segment
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 60);
  return safe || "index";
}
