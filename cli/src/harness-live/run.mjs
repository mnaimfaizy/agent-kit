// The live suite's entry, as .github/workflows/harness-live.yml runs it:
//
//   node cli/src/harness-live/run.mjs
//
// Every scenario in turn, on gVisor alone (ADR 0031): Linux with `runsc`
// registered as a Docker runtime. It needs no secret. Exit 0 when every Guard
// held in every scenario, else 1. In GitHub Actions it also sets the outputs
// `guard_failed` (true when a Guard was breached or not shown held) and
// `failed` (which, as `scenario:guard` entries), and writes the job summary.
// Everything it prints is made up for the run, so a public log may hold it.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runnerFor } from "../exec.mjs";
import { selectRuntime } from "../deep-scan/runtime.mjs";
import { runScenario, SCENARIOS } from "./suite.mjs";

/** A scenario's name as an output holds it: no space or bracket. */
const slug = (name) => name.replace(/[^A-Za-z0-9]+/g, "-").replace(/-$/, "");

/**
 * The suite's results as the workflow reads them.
 * @param {Array<Awaited<ReturnType<typeof runScenario>>>} results
 */
export function report(results) {
  const failed = results.flatMap((r) =>
    r.verdict === "guard-failed"
      ? [
          ...r.findings.filter((f) => f.status !== "held").map((f) => `${slug(r.name)}:${f.guard}`),
          // A sandbox that failed its own isolation check before any probe ran.
          ...(r.findings.every((f) => f.status === "held") ? [`${slug(r.name)}:isolation`] : []),
        ]
      : [],
  );
  const summary = [
    "## Harness live suite",
    "",
    "| Scenario | Verdict | Guards not held |",
    "| --- | --- | --- |",
    ...results.map((r) => {
      const bad = r.findings.filter((f) => f.status !== "held");
      return `| ${r.name} | ${r.verdict} | ${bad.map((f) => `${f.guard} (${f.status})`).join(", ") || "none"} |`;
    }),
    "",
  ].join("\n");
  return {
    exit: results.length > 0 && results.every((r) => r.verdict === "pass") ? 0 : 1,
    outputs: [`guard_failed=${failed.length > 0}`, `failed=${failed.join(",")}`].join("\n"),
    summary,
  };
}

/** One scenario's findings and, when it did not pass, everything to debug it with. */
function describe(result) {
  const lines = [
    `::group::${result.name}: ${result.verdict} (exit ${result.exit})`,
    ...result.findings.map(
      (f) => `${f.guard}: ${f.status}${f.reasons.map((r) => `\n  - ${r}`).join("")}`,
    ),
  ];
  if (result.verdict !== "pass") {
    lines.push("--- the launcher's output", result.log);
    for (const [guard, text] of Object.entries(result.outputs)) {
      lines.push(`--- the ${guard} probe's output`, text.slice(0, 4000));
    }
  }
  // Nothing printed from the sandbox may start a workflow command of its own.
  const [open, ...rest] = lines;
  return [open, ...rest.map((l) => l.replace(/^(\s*)::/gm, "$1: :")), "::endgroup::"].join("\n");
}

async function suite() {
  const runner = runnerFor("deep-scan");
  const choice = selectRuntime({ runner, platform: process.platform });
  if ("refused" in choice || choice.runtime.id !== "gvisor") {
    console.error(
      [
        "The live suite proves the Guards under gVisor: run it on Linux with runsc registered as a Docker runtime.",
        ...("refused" in choice ? choice.refused : [`This host offers ${choice.runtime.name}.`]),
      ].join("\n"),
    );
    return 1;
  }
  const results = [];
  for (const scenario of SCENARIOS) {
    console.log(`Running ${scenario.name} ...`);
    let result;
    try {
      result = await runScenario(scenario, {
        runner,
        runtime: choice.runtime,
        expectedRuntime: choice.runtime.dockerRuntime,
      });
    } catch (e) {
      result = {
        name: scenario.name,
        verdict: "error",
        findings: [],
        exit: 1,
        log: e?.stack ?? String(e),
        outputs: {},
      };
    }
    results.push(result);
    console.log(describe(result));
  }
  const { exit, outputs, summary } = report(results);
  console.log(summary);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${outputs}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  return exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await suite();
}
