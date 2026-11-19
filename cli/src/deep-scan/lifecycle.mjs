// The Deep scan sandbox lifecycle (#369), from image to teardown, on the
// runtime `selectRuntime` chose. In order: pull or build the recipe's image
// and layer a pinned Claude Code with its auto-updater off; start the sandbox
// with no mount; copy in an export of the trusted ref (never the working tree)
// and the grounding files, and nothing else; run the setup phase (`setup`,
// `start`, `ready`, `seed`) with no agent and no model credential, its egress
// limited to the recipe's `registries`; cut the network and check from the
// host that it is cut; run the agent step (a stand-in until the real scan
// lands); copy out the one report file; and destroy the sandbox on every exit
// path, an interrupt included. The runtime's own commands live in a driver
// (docker-driver.mjs); this module owns the order and every refusal.

import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstLine } from "../exec.mjs";
import { dockerDriver, LABEL } from "./docker-driver.mjs";
import { startEgressProxy } from "./egress.mjs";
import { singleFileOf, tarOf } from "./tar.mjs";

export { LABEL };

/** The Claude Code version every sandbox image layers, pinned. */
export const CLAUDE_CODE_VERSION = "2.1.328";

/** Where the sandbox holds the repository, the grounding and the report. */
export const WORKSPACE = "/workspace";
export const GROUNDING_DIR = "/agent-kit/grounding";
export const REPORT_PATH = "/agent-kit/out/report.md";

export const MAX_REPORT_BYTES = 10 * 1024 * 1024;
export const MAX_GROUNDING_BYTES = 10 * 1024 * 1024;
const GROUNDING_TIMEOUT_MS = 60_000;

/**
 * The agent step until the real scan lands: it writes a placeholder report
 * where the real agent will, and runs no model.
 */
export const STAND_IN_AGENT = [
  "set -eu",
  "mkdir -p /agent-kit/out",
  `cat > ${REPORT_PATH} <<'AGENT_KIT_REPORT'`,
  "# Deep scan report (stand-in agent)",
  "",
  "agent-kit deep-scan ran its sandbox lifecycle with a stand-in agent step: no model ran, and nothing was scanned.",
  "AGENT_KIT_REPORT",
].join("\n");

/**
 * The Dockerfile that layers the pinned Claude Code on `base`, with the
 * auto-updater off both by environment and by managed settings, which the
 * repository's own project settings cannot override. It needs npm in `base`.
 */
export function layerDockerfile(base) {
  const managed = JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } });
  return [
    `FROM ${base}`,
    "ENV DISABLE_AUTOUPDATER=1",
    `RUN npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \\`,
    "  && mkdir -p /etc/claude-code \\",
    `  && printf '%s\\n' '${managed}' > /etc/claude-code/managed-settings.json`,
    "",
  ].join("\n");
}

/** The setup phase's fields, in the order they run: services before seeding. */
const SETUP_ORDER = ["setup", "start", "ready", "seed"];

class StepFailed extends Error {
  /** @param {string[]} lines */
  constructor(lines) {
    super(lines[0]);
    this.lines = lines;
  }
}

class Interrupted extends Error {
  /** @param {string} signal */
  constructor(signal) {
    super(`interrupted by ${signal}`);
    this.signal = signal;
  }
}

/**
 * Run the sandbox lifecycle. Returns the exit code: 0 the report came out,
 * 1 a step failed (or the agent step did, or teardown could not finish),
 * 130 or 143 interrupted by SIGINT or SIGTERM.
 *
 * @param {{
 *   runner: import("../exec.mjs").Runner,
 *   runtime: import("./runtime.mjs").Runtime,
 *   root: string,
 *   branch: string,
 *   commit: string,
 *   steps: ReturnType<typeof import("./recipe.mjs").recipeSteps>,
 *   platform: string,
 *   fetch: typeof globalThis.fetch,
 *   signals: { on: Function, off: Function },
 *   reportDir?: string,
 *   out: (s: string) => void,
 *   err: (s: string) => void,
 * }} opts
 * @returns {Promise<number>}
 */
export async function runLifecycle(opts) {
  const { runner, runtime, platform, out, err, signals } = opts;
  if (runtime.id === "sbx") {
    err(
      [
        "STOPPED  The Docker Sandboxes (sbx) sandbox lifecycle is not built yet, so nothing was started.",
        "The lifecycle runs today on gVisor, Kata Containers or Firecracker registered as a Docker runtime on Linux, and on Docker Desktop on macOS.",
      ].join("\n"),
    );
    return 1;
  }

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
  const driver = dockerDriver({
    runtime,
    platform,
    id: randomBytes(6).toString("hex"),
    call: async (args, { stdin } = {}) => {
      if (signal.aborted) throw interrupted();
      const r = await runner.start("docker", args, { stdin, signal });
      if (r.aborted || signal.aborted) throw interrupted();
      // Ctrl+C in a terminal reaches the docker child too, and can end it
      // before the handler above runs: that is an interrupt, not a failure.
      if (r.signal === "SIGINT" || r.signal === "SIGTERM") throw new Interrupted(r.signal);
      return r;
    },
  });
  const state = { proxy: null };
  let code;
  let thrown = null;
  try {
    code = await lifecycle({ ...opts, driver, signal, interrupted, state });
  } catch (e) {
    if (e instanceof Interrupted) {
      code = e.signal === "SIGTERM" ? 143 : 130;
    } else if (e instanceof StepFailed) {
      err(e.lines.join("\n"));
      code = 1;
    } else {
      thrown = e;
    }
  }
  if (state.proxy) await state.proxy.close();
  const tornDown = teardown(runner, driver.teardown(), out, err);
  for (const [sig, handler] of Object.entries(handlers)) signals.off(sig, handler);
  if (thrown) throw thrown;
  return code === 0 && !tornDown ? 1 : code;
}

async function lifecycle({
  runner,
  runtime,
  root,
  branch,
  commit,
  steps,
  fetch,
  reportDir,
  out,
  err,
  driver,
  signal,
  interrupted,
  state,
}) {
  const short = commit.slice(0, 12);
  const container = driver.container;
  /** A result that must succeed, or the run ends before the agent step. */
  const must = (r, what, { showOutput = false } = {}) => {
    if (r.status === 0) return r;
    throw new StepFailed([
      `FAILED  ${what}: ${firstLine(r.stderr) || `exit ${r.status}`}`,
      ...(showOutput ? outputLines(r) : []),
      "The run ends here, before the agent step.",
    ]);
  };
  // The committed bytes: no line-end conversion from the host's git config.
  const archive = (args, what) => {
    const r = runner(
      "git",
      ["-c", "core.autocrlf=false", "-C", root, "archive", "--format=tar", ...args],
      { encoding: "buffer" },
    );
    if (r.status !== 0) {
      throw new StepFailed([
        `FAILED  ${what}: ${firstLine(r.stderr) || `git archive exit ${r.status}`}`,
      ]);
    }
    return r.stdout;
  };

  // 1. Image: the recipe's base, then the pinned Claude Code layer.
  let base;
  if (steps.dockerfile !== undefined) {
    out(`Image: building ${steps.dockerfile} from ${branch} (${short}).`);
    const context = archive([commit], `export ${branch} as the build context`);
    const built = await driver.build(steps.dockerfile, context);
    must(built, `building ${steps.dockerfile}`, { showOutput: true });
    base = built.tag;
  } else {
    base = steps.image;
    out(`Image: pulling ${base}.`);
    must(await driver.pull(base), `pulling ${base}`, { showOutput: true });
  }
  out(`Image: layering Claude Code ${CLAUDE_CODE_VERSION}, auto-updater off.`);
  must(
    await driver.layer(layerDockerfile(base)),
    `layering Claude Code ${CLAUDE_CODE_VERSION} on ${base}`,
    { showOutput: true },
  );

  // 2. The setup network, with no route out: its only way to the registries
  // is the proxy below, on the host. No registries, no network at all.
  let proxyEnv = [];
  if (steps.registries.length) {
    const net = await driver.setupNetwork();
    must(net.result, "creating the setup network");
    if (!net.bind) {
      throw new StepFailed([
        "FAILED  the setup network has no gateway address to put the registry proxy on.",
        "The run ends here, before the agent step.",
      ]);
    }
    try {
      state.proxy = await startEgressProxy({ registries: steps.registries, bind: net.bind });
    } catch (e) {
      throw new StepFailed([
        `FAILED  starting the setup registry proxy on ${net.bind}: ${e.message}`,
        "The run ends here, before the agent step.",
      ]);
    }
    const url = `http://${net.host}:${state.proxy.port}`;
    proxyEnv = [
      ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].map((v) => `${v}=${url}`),
      "NO_PROXY=localhost,127.0.0.1",
      "no_proxy=localhost,127.0.0.1",
    ];
  }

  // 3. The sandbox: no mount, no host environment, no Docker socket.
  out(`Sandbox: starting ${container} on ${runtime.name}.`);
  must(await driver.start(), "starting the sandbox");

  // 4. Copy in: the trusted ref's tree, then the grounding, and nothing else.
  const tree = archive(["--prefix=workspace/", commit], `export ${branch} (${short})`);
  must(await driver.copyIn(tree), "copying the repository in");
  out(`Copied in: ${branch} at ${short} (a git archive, not your working tree) to ${WORKSPACE}.`);
  const fetched = [];
  for (const [i, source] of steps.grounding.entries()) {
    const where = `grounding[${i}]`;
    if (/^https?:\/\//i.test(source)) {
      fetched.push({
        path: `agent-kit/grounding/urls/${i}-${basename(source)}`,
        data: await fetchGrounding(fetch, source, where, signal, interrupted),
      });
    } else {
      const files = archive(
        ["--prefix=agent-kit/grounding/", commit, "--", source],
        `${where}: ${source} is not on ${branch}`,
      );
      must(await driver.copyIn(files), `copying ${where} in`);
    }
  }
  if (fetched.length) {
    const tar = tarOf([
      { path: "agent-kit", dir: true },
      { path: "agent-kit/grounding", dir: true },
      { path: "agent-kit/grounding/urls", dir: true },
      ...fetched,
    ]);
    must(await driver.copyIn(tar), "copying the fetched grounding in");
  }
  if (steps.grounding.length) {
    out(`Copied in: ${steps.grounding.length} grounding source(s) to ${GROUNDING_DIR}.`);
  }

  // 5. The setup phase: no agent, no model credential, egress only to the
  // registries (through the proxy, and only for these steps).
  out(
    steps.registries.length
      ? `Setup: egress limited to ${steps.registries.join(", ")}, through the host-side proxy.`
      : "Setup: no registries, so no network.",
  );
  for (const field of SETUP_ORDER) {
    for (const [i, command] of steps[field].entries()) {
      const what = `${field}[${i}]`;
      // A service started in the background keeps its output in a log, so
      // the step returns; the log is shown if start or ready fails.
      const script =
        field === "start"
          ? `mkdir -p /agent-kit/logs\nexec >>/agent-kit/logs/start-${i}.log 2>&1\n${command}`
          : command;
      const r = await driver.exec(script, { env: proxyEnv });
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
      const refused = state.proxy?.refused ?? [];
      if (refused.length) {
        lines.push(
          `The setup proxy refused: ${[...new Set(refused)].join(", ")} (not in registries).`,
        );
      }
      throw new StepFailed(lines);
    }
  }

  // 6. Cut the network, and check from the host that it is cut.
  if (state.proxy) {
    await state.proxy.close();
    state.proxy = null;
  }
  const cut = await driver.cutNetwork();
  if (cut) must(cut, "cutting the network");
  const { result, attached } = await driver.networks();
  must(result, "checking that the network is cut");
  if (attached === null || attached.length) {
    throw new StepFailed([
      `FAILED  the network is not cut: docker inspect shows the sandbox on ${attached?.join(", ") || "an unknown network"}.`,
      "The run ends here, before the agent step.",
    ]);
  }
  out("Network: cut (checked from the host); the agent step has no network.");

  // 7. The agent step: a stand-in, with no model and no credential.
  out("Agent step: the stand-in agent (no model, no credential).");
  const agent = await driver.exec(STAND_IN_AGENT);
  if (agent.status !== 0) {
    err(`The agent step exited ${agent.status ?? "abnormally"}; copying out what report it left.`);
  }

  // 8. Copy out the one report file, and nothing else.
  const copied = await driver.copyOut(REPORT_PATH);
  if (copied.status !== 0) {
    throw new StepFailed([
      `FAILED  no report at ${REPORT_PATH}: ${firstLine(copied.stderr) || `exit ${copied.status}`}`,
    ]);
  }
  const file = singleFileOf(copied.stdout, { maxBytes: MAX_REPORT_BYTES });
  if ("error" in file) {
    throw new StepFailed([`FAILED  the report was not copied out: ${file.error}.`]);
  }
  const dir = reportDir ?? mkdtempSync(join(tmpdir(), "agent-kit-deep-scan-"));
  const path = join(dir, "report.md");
  writeFileSync(path, file.data, { mode: 0o600, flag: "wx" });
  out(`Report: ${path} (the only file copied out of the sandbox).`);
  return agent.status === 0 ? 0 : 1;
}

/**
 * Run each teardown command, whatever happened before. Synchronous, so it
 * finishes even while an interrupt is pending.
 * @param {Array<{ what: string, args: string[] }>} commands
 * @returns {boolean} whether nothing was left behind
 */
function teardown(runner, commands, out, err) {
  if (!commands.length) return true;
  const left = [];
  for (const { what, args } of commands) {
    const r = runner("docker", args);
    if (r.status !== 0 && !/no such|not found/i.test(r.stderr)) {
      left.push(`${what}: ${firstLine(r.stderr) || `exit ${r.status}`}`);
    }
  }
  if (left.length) {
    err(
      [
        "TEARDOWN  could not remove:",
        ...left.map((l) => `  - ${l}`),
        `Remove them by hand; every one carries the label ${LABEL}.`,
      ].join("\n"),
    );
    return false;
  }
  out(`Teardown: removed ${commands.map((c) => c.what).join(", ")}.`);
  return true;
}

async function fetchGrounding(fetch, url, where, signal, interrupted) {
  const fail = (why) =>
    new StepFailed([
      `FAILED  ${where}: could not fetch ${url}: ${why}`,
      "The run ends here, before the agent step.",
    ]);
  const tooLarge = `larger than ${MAX_GROUNDING_BYTES / 1024 / 1024} MiB`;
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.any([signal, AbortSignal.timeout(GROUNDING_TIMEOUT_MS)]),
    });
  } catch (e) {
    if (signal.aborted) throw interrupted();
    throw fail(e?.message ?? String(e));
  }
  if (!res.ok) throw fail(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? "0") > MAX_GROUNDING_BYTES) throw fail(tooLarge);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_GROUNDING_BYTES) throw fail(tooLarge);
  return data;
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

function outputLines(r) {
  const text = `${r.stdout.toString("utf8")}${r.stderr}`.trimEnd();
  return text ? ["Output:", ...indent(text)] : ["(no output)"];
}

const indent = (text) => text.split(/\r\n|\r|\n/).map((l) => `  ${l}`);
