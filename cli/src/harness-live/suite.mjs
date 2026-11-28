// The live suite (ADR 0031, Tier B): each scenario runs the pinned harness in
// its Harness image, in the real sandbox, behind the real model proxy, whose
// upstream is the stub model; the stub has the harness attempt a breach of
// each Guard; and the host judges what came of it (assess.mjs).
//
// The Deep scan enters through `agent-kit deep-scan` itself, with the model
// API pointed at the stub; the read-only Stage through stage.mjs.

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.mjs";
import { claudeCode, TOOLS } from "../harness/claude-code.mjs";
import { startStubModel } from "../model-proxy/stub.mjs";
import { assess, verdictOf } from "./assess.mjs";
import {
  FAKE_CREDENTIAL,
  hostReachesOutside,
  inspectSandbox,
  listen,
  markersIn,
  plant,
} from "./host.mjs";
import { MARKER_DIR, probeScripts } from "./probes.mjs";
import { runReadOnlyStage, STAGE_RESULT_PATH } from "./stage.mjs";

/** Every run the suite makes: each way Claude Code is launched, on each credential kind. */
export const SCENARIOS = Object.freeze(
  ["read-only-stage", "deep-scan"].flatMap((run) =>
    ["api-key", "subscription"].map((credentialKind) =>
      Object.freeze({ name: `claude-code ${run} (${credentialKind})`, run, credentialKind }),
    ),
  ),
);

/** The report's path in a Deep scan's sandbox, which its lifecycle names. */
const DEEP_SCAN_RESULT_PATH = "/agent-kit/out/report.md";

/** The targets of the network probe beside the host's own listener. */
const TARGETS = Object.freeze([
  "outside-host",
  "outside-address",
  "metadata",
  "docker-socket",
  "docker-socket-run",
]);

/** The markers the control run must leave, by the start of their names. */
const CONTROL_MARKERS = Object.freeze(["settings-", "local-", "mcp-server"]);

/** The sandbox's own container name, as the driver gives it. */
const SANDBOX = /^agent-kit-deep-[0-9a-f]{12}$/;

/**
 * A line that says one of the sandbox's isolation checks failed before the
 * agent step: each such failure of the Docker driver's, and of the network cut
 * and the model route.
 */
const NOT_ISOLATED =
  /^FAILED {2}(.* is not isolated|the sandbox is not on .* alone|the network is not cut|more than the model route is open)\b/m;

/**
 * The control for the checkout-config probe: the harness started again in the
 * same sandbox with the checkout's config loaded on purpose, so a run in which
 * none of it left a marker is known to have been able to.
 * @param {{ url: string }} launch
 */
function loadingConfig({ url }) {
  return [
    "claude",
    "--print",
    "--setting-sources",
    "user,project,local",
    "--settings",
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }),
    "--tools",
    TOOLS.join(","),
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--max-turns",
    "2",
  ];
}

/**
 * Run one scenario and judge it.
 * @param {typeof SCENARIOS[number]} scenario
 * @param {{
 *   runner: import("../exec.mjs").Runner,
 *   launcherCanary: string,
 *   runtime: import("../deep-scan/runtime.mjs").Runtime,
 *   expectedRuntime?: string,
 *   platform?: string,
 * }} opts  `runner` runs the launcher's commands. `launcherCanary` is a value
 *   on this process's own command line, which the sandbox must never see.
 *   `expectedRuntime` is the Docker runtime the sandbox must run under.
 * @returns {Promise<{
 *   name: string,
 *   verdict: "pass" | "guard-failed" | "error",
 *   findings: import("./assess.mjs").Finding[],
 *   exit: number,
 *   log: string,
 *   outputs: Record<string, string>,
 * }>}  `guard-failed`: a Guard was breached or not shown held; `error`: the
 *   run failed for another reason, such as before the harness started.
 */
export async function runScenario(
  scenario,
  { runner, launcherCanary, runtime, expectedRuntime = "runsc", platform = process.platform },
) {
  /** What to undo, newest first, however the run ends. */
  const undo = [];
  try {
    return await run();
  } finally {
    for (const step of undo.reverse()) await step();
  }

  async function run() {
    const planted = plant({ runner, launcherCanary });
    undo.push(() => planted.remove());
    const listener = await listen();
    undo.push(() => listener.close());
    const hostControls = { listener: await listener.check(), outside: await hostReachesOutside() };
    const stageRun = scenario.run === "read-only-stage";
    const resultPath = stageRun ? STAGE_RESULT_PATH : DEEP_SCAN_RESULT_PATH;
    const scripts = probeScripts({
      hostFiles: planted.hostFiles,
      hostTargets: listener.targets,
      resultPath,
    });
    const stub = await startStubModel({ commands: scripts.map((s) => s.script) });
    undo.push(() => stub.close());
    const outDir = mkdtempSync(join(tmpdir(), "agent-kit-live-out-"));
    undo.push(() => rmSync(outDir, { recursive: true, force: true }));
    const credential = FAKE_CREDENTIAL[scenario.credentialKind]();
    const { env: variable } = claudeCode().credentials.accepted[scenario.credentialKind];
    const savedCredential = process.env[variable];
    process.env[variable] = credential;
    undo.push(() => {
      if (savedCredential === undefined) delete process.env[variable];
      else process.env[variable] = savedCredential;
    });
    let log = "";
    const say = (line) => {
      log += `${line}\n`;
    };

    /** What the host read of the sandbox, and the probes' output at that moment. */
    let seen = { sandbox: null, markers: null, transcript: null };
    let outputs = null;
    let controlMarkers = null;
    const readSandbox = (container) => {
      seen = inspectSandbox(runner, container);
      outputs = Object.fromEntries(stub.results().map((r) => [scripts[r.index].guard, r.text]));
    };

    let exit;
    if (stageRun) {
      exit = await runReadOnlyStage({
        runner,
        runtime,
        root: planted.root,
        commit: planted.commit,
        credential,
        credentialKind: scenario.credentialKind,
        modelApi: stub.url,
        outDir,
        out: say,
        err: say,
        async beforeTeardown(container, launch) {
          readSandbox(container);
          stub.script([]);
          runner("docker", ["exec", container, "rm", "-rf", MARKER_DIR]);
          const control = loadingConfig(launch);
          await runner.start(
            "docker",
            [
              "exec",
              "-i",
              ...launch.env.flatMap((v) => ["--env", v]),
              "--workdir",
              "/workspace",
              container,
              ...control,
            ],
            { stdin: "Say that you are done.", signal: AbortSignal.timeout(120_000) },
          );
          controlMarkers = markersIn(runner, container);
        },
      });
    } else {
      // The sandbox is read as the Deep scan removes it: its last moment.
      const watching = (cmd, args, opts) => {
        if (cmd === "docker" && args[0] === "rm" && SANDBOX.test(args.at(-1))) {
          readSandbox(args.at(-1));
        }
        return runner(cmd, args, opts);
      };
      watching.start = runner.start;
      exit = await main(
        [
          "deep-scan",
          "--default-branch",
          "main",
          "--credential",
          scenario.credentialKind,
          "--max-turns",
          "40",
          "--scan-minutes",
          "10",
          "--report",
          join(outDir, "report.md"),
        ],
        {
          cwd: planted.root,
          stdout: say,
          stderr: say,
          runner: watching,
          platform,
          // The launcher's environment: the model credential, and the
          // runner's OIDC variables. It refuses to run beside a GitHub token,
          // which the processes it starts inherit all the same.
          env: {
            [variable]: credential,
            ACTIONS_ID_TOKEN_REQUEST_URL: planted.variables.ACTIONS_ID_TOKEN_REQUEST_URL,
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: planted.variables.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
          },
          signals: new EventEmitter(),
          modelApi: stub.url,
        },
      );
    }

    const unchanged = planted.unchanged();
    const resultName = resultPath.slice(resultPath.lastIndexOf("/") + 1);
    const resultFile = join(outDir, resultName);
    const evidence = {
      outputs: outputs ?? {},
      requests: stub.requests,
      launcherOutput: log,
      result: existsSync(resultFile) ? readFileSync(resultFile, "utf8") : null,
      ...seen,
      controlMarkers,
      outputFiles: readdirSync(outDir),
      hostRepoUnchanged: unchanged.repo,
      hostFilesUnchanged: unchanged.files,
      listenerHits: listener.hits(),
      hostControls,
    };
    const { accepted } = claudeCode().credentials;
    const findings = assess(evidence, {
      canaries: { ...planted.canaries, key: [credential] },
      control: planted.control,
      placeholderEnv: `${variable}=${accepted[scenario.credentialKind].placeholder}`,
      upstreamAuth:
        scenario.credentialKind === "api-key"
          ? ["x-api-key", credential]
          : ["authorization", `Bearer ${credential}`],
      runtime: expectedRuntime,
      resultName,
      sweepControl: planted.sweepControl,
      configControl: stageRun ? [...CONTROL_MARKERS] : [],
      hostFiles: planted.hostFiles,
      targets: [...TARGETS, ...listener.targets.map((_, i) => `host-${i}`)],
    });
    return {
      name: scenario.name,
      verdict: scenarioVerdict({ findings, started: stub.requests.length > 0, exit, log }),
      findings,
      exit,
      log,
      outputs: evidence.outputs,
    };
  }
}

/**
 * A scenario's verdict from its findings. A breach counts however the run went.
 * A Guard not shown counts once the harness started, or when the sandbox failed
 * its own isolation check; otherwise the run failed for another reason.
 * @param {{
 *   findings: import("./assess.mjs").Finding[],
 *   started: boolean,
 *   exit: number,
 *   log: string,
 * }} run
 * @returns {"pass" | "guard-failed" | "error"}
 */
export function scenarioVerdict({ findings, started, exit, log }) {
  if (findings.some((f) => f.status === "breached")) return "guard-failed";
  if (!started) return NOT_ISOLATED.test(log) ? "guard-failed" : "error";
  if (verdictOf(findings) !== "pass") return "guard-failed";
  return exit === 0 ? "pass" : "error";
}
