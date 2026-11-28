// A read-only Stage as the live suite runs it (ADR 0031): the pinned harness,
// by its adapter's launch plan, in the Deep scan's sandbox driver, behind the
// real model proxy, handed a brief, with one result file copied out.
//
// The `agent-kit stage` command, the Launcher's path for a Stage (ADR 0024),
// does not exist yet; until it does, this composes the same driver, adapter,
// agent script and proxy, and nothing here ships to a Consumer's run. Once it
// exists, the live suite enters through it. It removes nothing from the copy,
// so the checkout's config is kept out by the adapter's launch alone.

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentScript, BRIEF_PATH } from "../deep-scan/agent.mjs";
import { callerKeyFor, withoutCredentials } from "../deep-scan/credential.mjs";
import { dockerDriver } from "../deep-scan/docker-driver.mjs";
import { StepFailed } from "../deep-scan/steps.mjs";
import { tarOf } from "../deep-scan/tar.mjs";
import { claudeCode } from "../harness/claude-code.mjs";
import { startProxy } from "../model-proxy/core.mjs";
import { anthropic } from "../model-proxy/profiles/anthropic.mjs";

/** Where the Stage's result goes in the sandbox. */
export const STAGE_RESULT_PATH = "/agent-kit/out/result.md";

/** The longest a Stage's run may take. */
const TIMEOUT_MS = 20 * 60_000;

const MAX_RESULT = 10 * 1024 * 1024;

/** The harness's turn limit and the proxy's token cap, far above what the script needs. */
const MAX_TURNS = 40;
const MAX_TOKENS = 20_000_000;

/**
 * Run the Stage. Returns 0 when the harness exited cleanly and its result came
 * out, else 1. Every sandbox resource is removed on the way out.
 * @param {{
 *   runner: import("../exec.mjs").Runner,
 *   runtime: import("../deep-scan/runtime.mjs").Runtime,
 *   root: string,
 *   commit: string,
 *   credential: string,
 *   credentialKind: "api-key" | "subscription",
 *   modelApi: string,
 *   outDir: string,
 *   beforeTeardown: (container: string, launch: { env: string[], url: string }) => Promise<void>,
 *   out: (s: string) => void,
 *   err: (s: string) => void,
 * }} opts  `modelApi` is the proxy's upstream: here, the stub model.
 *   `outDir` receives what is copied out. `beforeTeardown` reads the sandbox
 *   after the harness ran.
 */
export async function runReadOnlyStage({
  runner: hostRunner,
  runtime,
  root,
  commit,
  credential,
  credentialKind,
  modelApi,
  outDir,
  beforeTeardown,
  out,
  err,
}) {
  // No command of the launcher's inherits the model credential.
  const runner = withoutCredentials(hostRunner, [process.env]);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const call = (cmd, args, opts = {}) => runner.start(cmd, args, { ...opts, signal });
  const id = randomBytes(6).toString("hex");
  const request = { stage: "review", credentialKind };
  const driver = dockerDriver({ runtime, id, call, plan: claudeCode(request) });
  const steps = { setup: [], start: [], ready: [], seed: [], registries: [], grounding: [] };
  const must = (condition, why) => {
    if (!condition) throw new StepFailed([`FAILED  ${why}.`]);
  };
  let proxy = null;
  try {
    await driver.prepare(steps, { out, branch: "main", short: commit.slice(0, 12) });
    await driver.start(steps);
    const archive = runner(
      "git",
      ["-c", "core.autocrlf=false", "-C", root, "archive", "--prefix=workspace/", commit],
      { encoding: "buffer" },
    );
    must(archive.status === 0, `exporting the repository: ${archive.stderr}`);
    await driver.copyIn(archive.stdout, "copying the repository in");
    await driver.cutEgress();
    const left = await driver.egressLeft();
    must(left === null, `the network is not cut: ${left}`);
    const callerKey = callerKeyFor(credentialKind);
    const route = await driver.openModelRoute(async (bind) => {
      proxy = await startProxy(anthropic, {
        credential,
        kind: credentialKind,
        bind,
        callerKey,
        upstream: modelApi,
        maxTokens: MAX_TOKENS,
      });
      return proxy;
    });
    const extra = await driver.egressLeft();
    must(extra === null, `more than the model route is open: ${extra}`);
    const brief = `# Stage brief\n\nThis Stage is read-only. Write your result to ${STAGE_RESULT_PATH}.\n`;
    await driver.copyIn(
      tarOf([
        { path: "agent-kit", dir: true },
        { path: "agent-kit/in", dir: true },
        { path: BRIEF_PATH.slice(1), data: Buffer.from(brief, "utf8") },
      ]),
      "copying the brief in",
    );
    const plan = claudeCode({
      ...request,
      proxyUrl: route.url,
      briefPath: BRIEF_PATH,
      kitDir: "/agent-kit",
      maxTurns: MAX_TURNS,
      callerKey,
    });
    out(`Agent step: ${plan.identity.displayName} ${plan.identity.version}, a read-only Stage.`);
    const agent = await driver.exec(
      agentScript({ plan, report: STAGE_RESULT_PATH, workspace: "/workspace" }),
      { env: plan.launch.env },
    );
    if (agent.status !== 0) err(`The agent step exited ${agent.status}:\n${agent.stderr}`);
    await beforeTeardown(driver.container, { env: plan.launch.env, url: route.url });
    const file = await driver.copyOut(STAGE_RESULT_PATH, { maxBytes: MAX_RESULT });
    if (!("data" in file)) {
      err("FAILED  no result came out.");
      return 1;
    }
    writeFileSync(join(outDir, file.name), file.data, { mode: 0o600, flag: "wx" });
    return agent.status === 0 ? 0 : 1;
  } catch (e) {
    if (!(e instanceof StepFailed)) throw e;
    err(e.lines.join("\n"));
    return 1;
  } finally {
    out(`Model proxy: ${proxy?.summary() ?? "not started"}.`);
    await driver.close();
    for (const { what, cmd, args } of driver.teardown()) {
      const r = hostRunner(cmd, args);
      if (r.status !== 0 && !/no such|not found/i.test(r.stderr)) {
        err(`TEARDOWN  could not remove ${what}: ${r.stderr}`);
      }
    }
  }
}
