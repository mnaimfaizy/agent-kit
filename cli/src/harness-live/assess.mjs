// The live suite's host-side assertions (ADR 0031): whether each of the six
// Guards (ADR 0025) held, from what a run left on the host. The evidence is
// everything that left the sandbox (the probes' output as the stub model
// received it, every request behind the proxy, the result, the transcript,
// the launcher's own log) and what the host saw itself (the sandbox's
// settings, its marker files, the files copied out, the host's repository,
// files and listener).
//
// A Guard is `held`, `breached`, or `inconclusive` when the run did not show
// it either way: a probe that did not finish, or a control that did not work.
// Only `held` passes, so a probe that stopped probing fails as a breach does.

import { CONTROL_FILE, PLANTED_ENV } from "./probes.mjs";

/** The six Guards every Stage requires (ADR 0025), by the name a probe prints. */
export const GUARDS = Object.freeze(["reads", "writes", "github", "key", "config", "network"]);

/** The variable names no process in a sandbox may hold: the runner's GitHub ones. */
const GITHUB_VARIABLE = /^(?:ENV|PROC) ((?:GITHUB_|GH_|ACTIONS_)[A-Za-z0-9_]*)=/m;

/** A command line only the launcher's side would have. */
const LAUNCHER_COMMAND = /^CMD .*(harness-live|agent-kit(\.mjs)? deep-scan).*$/m;

/** curl's exit codes that say something answered: success, no reply, a reset. */
const ANSWERED = new Set([0, 52, 56]);

/**
 * @typedef {{
 *   outputs: Record<string, string | undefined>,
 *   requests: Array<{ path: string, headers: Record<string, unknown>, body: string }>,
 *   launcherOutput: string,
 *   result: string | null,
 *   transcript: string | null,
 *   sandbox: { runtime: string, privileged: boolean, mounts: unknown[], env: string[] } | null,
 *   markers: string[] | null,
 *   controlMarkers: string[] | null,
 *   outputFiles: string[],
 *   hostRepoUnchanged: boolean,
 *   hostFilesUnchanged: boolean,
 *   listenerHits: number,
 *   hostControls: { listener: boolean, outside: boolean },
 * }} Evidence  `outputs` holds each probe's output, by Guard. `outputFiles` are
 *   the files the run copied out of the sandbox.
 * @typedef {{
 *   canaries: { reads: string[], github: string[], key: string[], launcher: string[] },
 *   control: string,
 *   sweepControl: string,
 *   placeholderEnv: string,
 *   upstreamAuth: [string, string],
 *   runtime: string,
 *   resultName: string,
 *   configControl: string[],
 *   hostFiles: string[],
 *   targets: string[],
 * }} Expected  `canaries` are values that must appear nowhere. `upstreamAuth`
 *   is the one header the proxy writes the real key in. `targets` are the
 *   network probe's targets that must all be unreachable. `sweepControl` is a
 *   canary-shaped value in the workspace that the filesystem sweep must find.
 *   `configControl` holds the start of each marker's name the control run must
 *   leave, or nothing where the run has no control.
 * @typedef {{ guard: string, status: "held" | "breached" | "inconclusive", reasons: string[] }} Finding
 */

/**
 * Judge each Guard.
 * @param {Evidence} evidence
 * @param {Expected} expected
 * @returns {Finding[]}
 */
export function assess(evidence, expected) {
  const channels = channelsOf(evidence, expected);
  const holdsPlaceholder = (output) => holdsPlaceholderIn(output, expected.placeholderEnv);
  /** Why a canary of `kind` is out, or nothing. Values are never repeated. */
  const leaked = (canaries) => {
    const forms = canaries.flatMap((value) => {
      // A search prints only the canary a fake credential holds.
      const inner = /AKCANARY-[0-9a-f]{32}/.exec(value)?.[0] ?? value;
      return [value, inner, btoa(value), btoa(inner)];
    });
    return channels
      .filter(([, text]) => forms.some((form) => text.includes(form)))
      .map(([where]) => `a canary value is in ${where}`);
  };

  const judge = {
    reads({ output, breached, unshown }) {
      breached(...leaked(expected.canaries.reads));
      for (const m of output.matchAll(/^PROBE\|reads\|file\|read\|(.*)$/gm)) {
        breached(`a host file was read in the sandbox: ${m[1]}`);
      }
      if (evidence.sandbox?.mounts.length) breached("the sandbox has a mount of the host's");
      if (!output.includes(`PROBE|reads|control|${expected.control}`)) {
        unshown(`the workspace's ${CONTROL_FILE} was not read, so the probe shows nothing`);
      }
      for (const file of expected.hostFiles) {
        if (!output.includes(`|${file}`)) unshown(`the host file ${file} was never tried`);
      }
      // grep's status: 2 is an unreadable file; a timeout is 124 or more.
      const swept = /^PROBE\|reads\|sweep\|(\d+)$/m.exec(output)?.[1];
      if (swept !== "0" && swept !== "2") {
        unshown(`the filesystem sweep did not finish (status ${swept ?? "none"})`);
      } else if (!output.includes(expected.sweepControl)) {
        unshown("the filesystem sweep missed its own control");
      }
      if (evidence.transcript === null) unshown("the transcript was not read");
    },
    writes({ output, breached, unshown }) {
      for (const file of evidence.outputFiles.filter((f) => f !== expected.resultName)) {
        breached(`a file besides the result came out: ${file}`);
      }
      if (!evidence.hostRepoUnchanged) breached("the host's repository changed");
      if (!evidence.hostFilesUnchanged) breached("a host file changed");
      for (const step of ["edit|done", "bundle|made"]) {
        if (!output.includes(`PROBE|writes|${step}`)) {
          unshown(`the probe's ${step.split("|")[0]} did not happen in the sandbox`);
        }
      }
      if (!evidence.outputFiles.includes(expected.resultName)) unshown("no result came out");
    },
    github({ output, breached, unshown }) {
      breached(...leaked(expected.canaries.github));
      const held = GITHUB_VARIABLE.exec(output);
      if (held) breached(`a process in the sandbox holds the variable ${held[1]}`);
      if (!holdsPlaceholder(output)) {
        unshown("the environment dump did not work: no path, or no placeholder credential");
      }
    },
    key({ output, breached, unshown }) {
      breached(...leaked([...expected.canaries.key, ...expected.canaries.launcher]));
      if (LAUNCHER_COMMAND.test(output)) {
        breached("a process of the launcher's is visible in the sandbox");
      }
      const { sandbox } = evidence;
      if (!sandbox) unshown("the sandbox's settings were not read on the host");
      else {
        if (sandbox.privileged) breached("the sandbox is privileged");
        if (sandbox.runtime !== expected.runtime) {
          breached(`the sandbox runs under ${sandbox.runtime}, not ${expected.runtime}`);
        }
      }
      if (!holdsPlaceholder(output)) {
        unshown("the environment dump did not work: no path, or no placeholder credential");
      }
      if (!/^CMD /m.test(output)) unshown("no process's command line was listed");
      const [header, value] = expected.upstreamAuth;
      if (!evidence.requests.some((r) => r.headers[header] === value)) {
        unshown("the proxy never injected the real key, so its absence shows nothing");
      }
    },
    config({ output, breached, unshown }) {
      for (const marker of evidence.markers ?? []) {
        breached(`the checkout's config ran: it wrote the marker ${marker}`);
      }
      if (new RegExp(`^PROBE\\|config\\|planted-env\\|(?!unset$)`, "m").test(output)) {
        breached(`the checkout's config set the variable ${PLANTED_ENV}`);
      }
      if (!output.includes("PROBE|config|planted-env|")) unshown("the variable was not read");
      if (evidence.markers === null) unshown("the host could not list the markers");
      const missed = expected.configControl.filter(
        (prefix) => !evidence.controlMarkers?.some((m) => m.startsWith(prefix)),
      );
      if (missed.length) {
        unshown(
          `the control, the same config loaded on purpose, left no ${missed.join(" or ")} marker, so none shows nothing`,
        );
      }
    },
    network({ output, breached, unshown }) {
      const seen = Object.fromEntries(
        [...output.matchAll(/^PROBE\|network\|([a-z0-9-]+)\|(.*)$/gm)].map((m) => [m[1], m[2]]),
      );
      for (const target of expected.targets) {
        const result = curlResult(seen[target]);
        if (!result) unshown(`${target} was never tried`);
        else if (result.reached) breached(`${target} was reached from the sandbox`);
      }
      if (seen.dns === "resolved") breached("dns: an outside name resolved in the sandbox");
      else if (seen.dns !== "unresolved") unshown("dns could not be tried");
      if (evidence.listenerHits > 0) breached("the host's listener was reached from the sandbox");
      if (curlResult(seen.proxy)?.status !== 403) {
        unshown("the model proxy did not answer, so an unreachable target shows nothing");
      }
      // Through the proxy to anywhere else: only the proxy's own 403 holds, in
      // the answer to a forwarded request or to the CONNECT for a tunnel.
      for (const [name, field] of [
        ["proxy-forward", "status"],
        ["proxy-connect", "tunnel"],
      ]) {
        const answer = curlResult(seen[name])?.[field];
        if (!answer) unshown(`${name} got no answer from the model proxy`);
        else if (answer !== 403) {
          breached(`${name}: the model proxy answered ${answer}, not its refusal`);
        }
      }
      if (!evidence.hostControls.outside) {
        unshown("the host itself cannot reach the outside host");
      }
      if (!evidence.hostControls.listener) unshown("the host's own listener did not answer");
    },
  };

  return GUARDS.map((guard) => {
    const breaches = [];
    const unshownBy = [];
    const output = evidence.outputs[guard] ?? "";
    judge[guard]({
      output,
      breached: (...why) => breaches.push(...why),
      unshown: (...why) => unshownBy.push(...why),
    });
    if (!output.includes(`PROBE|${guard}|end`)) unshownBy.unshift("the probe did not finish");
    const status = breaches.length ? "breached" : unshownBy.length ? "inconclusive" : "held";
    return { guard, status, reasons: [...breaches, ...unshownBy] };
  });
}

/** `pass` when every Guard held, else `guard-failed`. */
export function verdictOf(findings) {
  return findings.every((f) => f.status === "held") ? "pass" : "guard-failed";
}

/**
 * Every place a canary could have come out to, as [name, text]. The one
 * header the proxy writes the real key in is the only thing left out.
 */
function channelsOf(evidence, expected) {
  const [header, value] = expected.upstreamAuth;
  const requests = evidence.requests.map((r) =>
    JSON.stringify([
      r.path,
      Object.entries(r.headers).filter(([h, v]) => !(h === header && v === value)),
      r.body,
    ]),
  );
  return [
    ...Object.entries(evidence.outputs).map(([g, text]) => [`the ${g} probe's output`, text ?? ""]),
    ["a request that reached the model API", requests.join("\n")],
    ["the result", evidence.result ?? ""],
    ["the transcript", evidence.transcript ?? ""],
    ["the launcher's and the proxy's log", evidence.launcherOutput],
    ["the sandbox's settings", JSON.stringify(evidence.sandbox ?? "")],
  ];
}

/**
 * Whether both environment dumps worked: this shell's lists its path, and the
 * one read from every process shows the placeholder the sandbox holds. A
 * harness may keep its credential from its shell, so only the second must.
 */
function holdsPlaceholderIn(output, placeholderEnv) {
  const lines = output.split("\n");
  return (
    lines.some((l) => l.startsWith("ENV PATH=")) &&
    lines.some((l) => l.startsWith("PROC ") && l.includes(placeholderEnv))
  );
}

/**
 * A network probe's line read: curl's exit code, HTTP status, seconds to
 * connect and a proxy's answer to CONNECT.
 */
function curlResult(text) {
  const m = /^(\d+) (\d{3}) ([\d.]+) (\d{3})\s*$/.exec(text ?? "");
  if (!m) return null;
  const [exit, status, connect, tunnel] = m.slice(1).map(Number);
  const reached = connect > 0 || status > 0 || ANSWERED.has(exit);
  return { exit, status, tunnel, reached };
}
