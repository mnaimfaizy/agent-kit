// The sandbox driver for Docker Sandboxes (`sbx`, #369): one microVM per
// sandbox. Built only on the commands of sbx v0.54.0's own help, as the
// Chief of Staff captured it (run evidence sbx-help.txt; the line numbers
// below are that file's). The human chose this design (option 1):
//
// - The human's global sbx network policy must be deny-all. Per-sandbox rules
//   only add to it, and a deny always wins over an allow (help 641-643, 676),
//   so on any other global policy setup could reach more than `registries`.
//   It is read with `sbx policy ls --json` (811-828) and never changed: the
//   launcher never runs `sbx policy init` or `sbx policy reset`.
// - The sandbox is mountless: `sbx create` with no PATH (81-82, 103-104), the
//   recipe's image as its template (`-t`, 173), the `shell` agent (86).
// - sbx has no build command, so Claude Code is installed inside the sandbox
//   as the first setup step, with only registry.npmjs.org allowed, for that
//   step alone. A `dockerfile` recipe is refused.
// - Setup egress: `sbx policy allow network --sandbox` for each registry
//   (986-987), removed with `sbx policy rm network --sandbox --resource` for
//   the cut (1148, 1179-1180); `sbx policy ls <sandbox> --json` (812, 822)
//   then shows, from the host, that no network allow is left.
// - Files move with `sbx cp`, whose host side is a path, not stdin (377-408):
//   tars are written to a private host folder and unpacked inside; the
//   report is copied into a private host folder and checked there.
// - Teardown: `sbx rm --force` (449-457, 480).
// Every call passes `--no-input` (180), so sbx never waits on a prompt.

import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstLine } from "../exec.mjs";
import { AUTO_UPDATER_OFF, INSTALL_SCRIPT, NPM_REGISTRY } from "./claude-code.mjs";
import { allowlistOf } from "./egress.mjs";
import { ENDS_HERE, must, outputLines, StepFailed } from "./steps.mjs";

const UNINITIALIZED = /global network policy has not been initialized/i;

/**
 * Why the global sbx network policy is not deny-all, as refusal lines, or
 * null when it is. From `sbx policy ls --json`: deny-all is the active global
 * `default-deny-all` network rule denying "**", with no active global network
 * allow rule beside it.
 * @param {import("../exec.mjs").StartResult} r
 * @returns {string[] | null}
 */
export function globalPolicyProblem(r) {
  const text = `${r.stdout.toString("utf8")}\n${r.stderr}`;
  const init =
    "Run `sbx policy init deny-all` yourself (deep-scan never changes your sbx policy), then run deep-scan again.";
  if (r.status !== 0) {
    if (UNINITIALIZED.test(text)) {
      return [
        "REFUSED  Docker Sandboxes' global network policy has not been initialized; deep-scan needs it to be deny-all.",
        init,
      ];
    }
    return [
      `REFUSED  Could not read the Docker Sandboxes network policy: ${firstLine(r.stderr) || `exit ${r.status}`}`,
    ];
  }
  const rules = rulesOf(r);
  if (rules === null) {
    return [
      "REFUSED  Could not read the Docker Sandboxes network policy: `sbx policy ls --json` did not give a rules list.",
    ];
  }
  const network = rules.filter(
    (rule) =>
      rule.resource_type === "network" && rule.scope === "global" && rule.status === "active",
  );
  const denyAll = network.some(
    (rule) =>
      rule.id === "default-deny-all" &&
      rule.decision === "deny" &&
      Array.isArray(rule.resources) &&
      rule.resources.includes("**"),
  );
  const allows = network.filter((rule) => rule.decision === "allow");
  if (denyAll && allows.length === 0) return null;
  return [
    "REFUSED  Docker Sandboxes' global network policy is not deny-all, so a sandbox's setup could reach more than the recipe's registries.",
    ...(allows.length
      ? [
          `Global allow rules: ${allows.map((a) => String(a.id ?? a.name ?? "(no id)")).join(", ")}.`,
        ]
      : []),
    "deep-scan needs a deny-all global policy and never changes it itself: change it with `sbx policy`, for example `sbx policy init deny-all` on a fresh policy, then run deep-scan again.",
  ];
}

/** The rules list of `sbx policy ls --json`, or null. */
function rulesOf(r) {
  try {
    const parsed = JSON.parse(r.stdout.toString("utf8"));
    return parsed && Array.isArray(parsed.rules)
      ? parsed.rules.filter((x) => x && typeof x === "object")
      : null;
  } catch {
    return null;
  }
}

/** Each registry as the sbx network resources that allow it: host:port. */
export function sbxResources(registries) {
  const out = [];
  for (const [host, ports] of allowlistOf(registries)) {
    for (const port of ports)
      out.push(host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);
  }
  return out;
}

/**
 * @param {{ id: string, call: import("./docker-driver.mjs").Call }} opts
 * @returns {import("./lifecycle.mjs").Driver}
 */
export function sbxDriver({ id, call }) {
  const name = `agent-kit-deep-${id}`;
  const sbx = (args, opts) => call("sbx", ["--no-input", ...args], opts);
  let created = false;
  /** The per-sandbox allow rules in place, as their resource lists. */
  const allowed = [];
  let host = null; // a private host folder for the files sbx cp moves
  let copies = 0;

  const hostDir = () => (host ??= mkdtempSync(join(tmpdir(), "agent-kit-deep-scan-sbx-")));

  const allow = async (resources, what) => {
    const list = resources.join(",");
    allowed.push(list);
    must(await sbx(["policy", "allow", "network", "--sandbox", name, list]), what);
  };
  const disallow = async (list, what) => {
    must(
      await sbx(["policy", "rm", "network", "--sandbox", name, "--resource", list, "--force"]),
      what,
    );
    allowed.splice(allowed.indexOf(list), 1);
  };
  const exec = (script, { env = [], workdir = "/workspace", user } = {}) =>
    sbx([
      "exec",
      ...(user ? ["-u", user] : []),
      ...env.flatMap((v) => ["-e", v]),
      ...(workdir ? ["-w", workdir] : []),
      name,
      "sh",
      "-c",
      script,
    ]);

  return {
    container: name,

    async prepare(steps, { out }) {
      if (steps.dockerfile !== undefined) {
        throw new StepFailed([
          `REFUSED  The recipe builds ${steps.dockerfile}, and Docker Sandboxes cannot build a Dockerfile.`,
          "On Docker Sandboxes, name a base image with `image:` instead (one with Node.js and npm), or run on another accepted runtime.",
        ]);
      }
      const problem = globalPolicyProblem(await sbx(["policy", "ls", "--json"]));
      if (problem) throw new StepFailed(problem);
      out("Network policy: Docker Sandboxes' global policy is deny-all (checked read-only).");
      out(`Image: ${steps.image}, as the sandbox's template; Claude Code is installed inside it.`);
    },

    async start(steps) {
      created = true;
      must(
        await sbx([
          "create",
          "--name",
          name,
          "--no-progress",
          "-t",
          steps.image,
          "-e",
          AUTO_UPDATER_OFF,
          "shell",
        ]),
        "creating the sandbox",
        { showOutput: true },
      );
    },

    async copyIn(tar, what) {
      const file = `in-${copies++}.tar`;
      writeFileSync(join(hostDir(), file), tar, { mode: 0o600 });
      const inside = `/tmp/agent-kit-${file}`;
      try {
        // Relative to the private folder, so a Windows drive letter is never
        // read as a sandbox name.
        must(await sbx(["cp", file, `${name}:${inside}`], { cwd: hostDir() }), what);
      } finally {
        rmSync(join(hostDir(), file), { force: true });
      }
      must(
        await exec(
          // Unpacked as root; then the sandbox's own user may write there.
          `tar -xf ${inside} -C / && rm -f ${inside} && { chmod -R a+rwX /workspace /agent-kit 2>/dev/null || true; }`,
          { user: "root", workdir: null },
        ),
        `${what} (unpacking it)`,
        { showOutput: true },
      );
    },

    async installAgent(out) {
      out(`Setup: installing the pinned Claude Code, with only ${NPM_REGISTRY} reachable.`);
      const resources = [`${NPM_REGISTRY}:443`];
      await allow(resources, `allowing ${NPM_REGISTRY} for the Claude Code install`);
      const r = await exec(INSTALL_SCRIPT, { user: "root", workdir: null });
      if (r.status !== 0) {
        throw new StepFailed([
          `FAILED  installing Claude Code exited ${r.status ?? "abnormally"} (the image needs Node.js and npm).`,
          ...outputLines(r),
          ENDS_HERE,
        ]);
      }
      await disallow(resources.join(","), `removing the ${NPM_REGISTRY} rule`);
    },

    async openSetupEgress(registries) {
      const resources = sbxResources(registries);
      if (!resources.length) return { env: [], note: "no registries, so no network" };
      await allow(resources, "allowing the recipe's registries for setup");
      return {
        env: [],
        note: `egress limited to ${registries.join(", ")}, by a per-sandbox sbx policy on a deny-all global policy`,
      };
    },

    refused: () => [],

    exec,

    async cutEgress() {
      for (const list of [...allowed]) await disallow(list, "cutting the network");
    },

    async egressLeft() {
      const r = must(
        await sbx(["policy", "ls", name, "--json"]),
        "checking that the network is cut",
      );
      const rules = rulesOf(r);
      if (rules === null) return "sbx policy ls shows no readable rules";
      const open = rules.filter(
        (rule) =>
          rule.resource_type === "network" && rule.decision === "allow" && rule.status === "active",
      );
      if (open.length) {
        return `sbx policy ls still allows ${open.map((o) => (Array.isArray(o.resources) ? o.resources.join(",") : String(o.id))).join("; ")}`;
      }
      const denied = rules.some(
        (rule) =>
          rule.id === "default-deny-all" &&
          rule.resource_type === "network" &&
          rule.decision === "deny" &&
          rule.status === "active",
      );
      return denied ? null : "sbx policy ls no longer shows the deny-all rule";
    },

    async copyOut(path, { maxBytes }) {
      const into = mkdtempSync(join(hostDir(), "out-"));
      const r = await sbx(["cp", `${name}:${path}`, "."], { cwd: into });
      if (r.status !== 0) return { missing: r };
      const entries = readdirSync(into);
      if (entries.length !== 1)
        return { error: `the copy holds ${entries.length} entries, not one file` };
      const file = join(into, entries[0]);
      const stat = lstatSync(file);
      if (!stat.isFile()) return { error: `${entries[0]} is not a regular file` };
      if (stat.size > maxBytes) return { error: `it is larger than ${maxBytes / 1024 / 1024} MiB` };
      return { name: entries[0], data: readFileSync(file) };
    },

    async close() {},

    teardown() {
      if (!created) return [];
      return [
        ...allowed.map((list) => ({
          what: `the sbx policy rule for ${list}`,
          cmd: "sbx",
          args: [
            "--no-input",
            "policy",
            "rm",
            "network",
            "--sandbox",
            name,
            "--resource",
            list,
            "--force",
          ],
        })),
        { what: `sandbox ${name}`, cmd: "sbx", args: ["--no-input", "rm", "--force", name] },
      ];
    },

    /** Remove the private host folder the copies went through. */
    cleanup() {
      if (host) rmSync(host, { recursive: true, force: true });
    },
  };
}
