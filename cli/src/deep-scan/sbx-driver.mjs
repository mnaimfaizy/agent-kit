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
//   `shell` agent (86), and a template (`-t`, 173) that is not the recipe's
//   image as it is. sbx v0.54.0 writes /home/agent/AGENTS.md as a sandbox
//   starts, and a plain image has no /home/agent, so `-t <plain image>` never
//   starts (#375's diagnosis, run evidence d375-sbx-diag.txt). The human chose
//   (#375, option 1): Docker on the host pulls the recipe's image and layers
//   on it the Docker driver's pinned Claude Code and what Docker's docs
//   require of a template image (TEMPLATE_LAYER: a non-root `agent`, uid
//   1000, home /home/agent, as its USER; curl, git, CA certificates and
//   bash, checked); `docker save` writes it to a private folder, `sbx template load`
//   loads it, and `sbx create --pull never -t <it>` uses it. Teardown removes
//   the template and the layered image. Only the pull and that fixed layer run
//   on the host's Docker (Docker Desktop, the WSL 2 boundary a scan refuses),
//   never a Consumer's own build steps, so a `dockerfile` recipe is refused.
// - Setup egress: `sbx policy allow network --sandbox` for each registry
//   (986-987), removed with `sbx policy rm network --sandbox --resource` for
//   the cut (1148, 1179-1180); `sbx policy ls <sandbox> --json` (812, 822)
//   then shows, from the host, that no network allow is left.
// - Files move with `sbx cp`, whose host side is a path, not stdin (377-408):
//   tars are written to a private host folder and unpacked inside; the
//   report is copied into a private host folder and checked there.
// - The model route (#370): the key-injecting model proxy listens on the
//   host's 127.0.0.1, which the sandbox calls as host.docker.internal:<its
//   port>, and one per-sandbox rule allows only that, which sbx's policy
//   names localhost:<its port>. No per-sandbox deny "**" is added: a
//   deny beats every allow (676), so it would block the proxy too, and the
//   global deny-all already decides everything else.
// - Teardown: `sbx rm --force` (449-457, 480).
// Every call passes `--no-input` (180), so sbx never waits on a prompt.

import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstLine } from "../exec.mjs";
import { layerDockerfile } from "../harness/install-layer.mjs";
import { LABEL } from "./docker-driver.mjs";
import { allowlistOf } from "./egress.mjs";
import { imageDigestNote } from "./recipe.mjs";
import { ENDS_HERE, must, StepFailed } from "./steps.mjs";

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
 * @param {{ id: string, call: import("./docker-driver.mjs").Call, plan: import("../harness/claude-code.mjs").LaunchPlan }} opts
 *   `plan` is the harness's launch plan: its install layer goes on the template.
 * @returns {import("./lifecycle.mjs").Driver}
 */
export function sbxDriver({ id, call, plan }) {
  const { displayName } = plan.identity;
  const name = `agent-kit-deep-${id}`;
  /** The layered image, and the sbx template loaded from it. */
  const template = `${name}:sbx`;
  const sbx = (args, opts) => call("sbx", ["--no-input", ...args], opts);
  const docker = (args, opts) => call("docker", args, opts);
  let created = false;
  let imageBuilt = false; // asked for, so removed whether or not it finished
  let templateLoaded = false;
  /** The loaded template's image id: removing it removes every tag sbx gave it. */
  let templateId = null;
  /** The per-sandbox allow rules in place, as their resource lists. */
  const allowed = [];
  let host = null; // a private host folder for the files sbx cp moves
  let copies = 0;
  let modelRoute = null; // the one allow rule the scan may have
  let modelProxy = null;

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
          `REFUSED  The recipe builds ${steps.dockerfile}, and on Docker Sandboxes its build steps would run on this machine's Docker (Docker Desktop's WSL 2 VM on Windows), outside the sandbox.`,
          "On Docker Sandboxes, name a base image with `image:` instead (one with Node.js and npm), or run on another accepted runtime.",
        ]);
      }
      const problem = globalPolicyProblem(await sbx(["policy", "ls", "--json"]));
      if (problem) throw new StepFailed(problem);
      out("Network policy: Docker Sandboxes' global policy is deny-all (checked read-only).");
      out(
        `Image: layering the pinned ${displayName} on ${steps.image} with Docker on this machine, auto-updater off, as the sandbox's template.`,
      );
      const note = imageDigestNote(steps.image);
      if (note) out(note);
      const pulled = await docker(["pull", steps.image]);
      if (pulled.status === null) {
        throw new StepFailed([
          "FAILED  Docker Sandboxes' template is built with Docker on this machine, and docker could not run: " +
            (firstLine(pulled.stderr) || "not found"),
          "Install Docker Desktop (it only builds the template here; the scan runs in the sbx microVM), then run deep-scan again.",
          ENDS_HERE,
        ]);
      }
      must(pulled, `pulling ${steps.image}`, { showOutput: true });
      imageBuilt = true;
      must(
        await docker(["build", "--label", `${LABEL}=${id}`, "--tag", template, "-"], {
          stdin: `${layerDockerfile(steps.image, plan.installLayer)}${TEMPLATE_LAYER}`,
        }),
        `layering ${displayName} on ${steps.image}`,
        { showOutput: true },
      );
      // A private host file, by a name relative to its folder, so a Windows
      // drive letter is never read as anything else; gone once it is loaded.
      const tar = "template.tar";
      try {
        must(
          await docker(["save", "--output", tar, template], { cwd: hostDir() }),
          "saving the layered image",
        );
        must(
          await sbx(["template", "load", tar], { cwd: hostDir() }),
          "loading the layered image into Docker Sandboxes",
          { showOutput: true },
        );
        templateLoaded = true;
        templateId = idOf(
          await sbx(["template", "ls", "--json"]),
          `docker.io/library/${template.split(":")[0]}`,
          "sbx",
        );
      } finally {
        rmSync(join(hostDir(), tar), { force: true });
      }
    },

    async start() {
      created = true;
      must(
        await sbx([
          "create",
          "--name",
          name,
          "--no-progress",
          "--pull",
          "never",
          "-t",
          template,
          ...plan.installLayer.env.flatMap((v) => ["-e", v]),
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

    /** The harness is in the template already: nothing to install. */
    async installAgent() {},

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
          rule.resource_type === "network" &&
          rule.decision === "allow" &&
          rule.status === "active" &&
          !(
            modelRoute &&
            Array.isArray(rule.resources) &&
            rule.resources.length > 0 &&
            rule.resources.every((r) => r === modelRoute)
          ),
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

    /**
     * Allow only the model proxy on the host. The sandbox calls it as
     * host.docker.internal:<port>, which sbx v0.54.0's policy checks as
     * localhost:<port> (#375's diagnosis), so the rule names that.
     */
    async openModelRoute(startProxy) {
      const bind = "127.0.0.1";
      try {
        modelProxy = await startProxy(bind);
      } catch (e) {
        throw new StepFailed([
          `FAILED  starting the model proxy on ${bind}: ${e.message}`,
          ENDS_HERE,
        ]);
      }
      modelRoute = `localhost:${modelProxy.port}`;
      await allow([modelRoute], "allowing the model proxy, and nothing else, for the scan");
      return {
        url: `http://host.docker.internal:${modelProxy.port}`,
        note: `host.docker.internal:${modelProxy.port} from the sandbox, a per-sandbox sbx policy allowing only ${modelRoute}`,
      };
    },

    async copyOut(path, { maxBytes }) {
      // `sbx cp` writes whatever is there to the host before the checks
      // below can look, so check type and size in the sandbox first: a
      // filter against filling the host's disk, not the check itself.
      if (!/^[\w./-]+$/.test(path)) throw new Error(`copyOut: unsafe path ${path}`);
      const pre = await exec(
        `p=${path}; if [ -e "$p" ] || [ -L "$p" ]; then { [ -f "$p" ] && [ ! -L "$p" ]; } || exit 4; [ "$(wc -c < "$p")" -le ${maxBytes} ] || exit 5; fi`,
        { workdir: "" },
      );
      if (pre.status === 4) return { error: "it is not a regular file (checked in the sandbox)" };
      if (pre.status === 5) {
        return {
          error: `it is larger than ${maxBytes / 1024 / 1024} MiB (checked in the sandbox)`,
        };
      }
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

    async close() {
      if (modelProxy) {
        const p = modelProxy;
        modelProxy = null;
        await p.close();
      }
    },

    teardown() {
      return [
        ...(created ? sandboxTeardown() : []),
        ...(templateLoaded
          ? [
              {
                what: `template ${template}`,
                cmd: "sbx",
                // By id when sbx listed it: a create gives the template a
                // second, assembled tag, which removing the tag alone leaves.
                args: ["--no-input", "template", "rm", "--force", templateId ?? template],
              },
            ]
          : []),
        ...(imageBuilt
          ? [
              {
                what: `image ${template}`,
                cmd: "docker",
                args: ["image", "rm", "--force", template],
              },
            ]
          : []),
      ];
    },

    /** Remove the private host folder the copies went through. */
    cleanup() {
      if (host) rmSync(host, { recursive: true, force: true });
    },
  };

  function sandboxTeardown() {
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
  }
}

/**
 * A template's image id (hex, no `sha256:`) from `sbx template ls --json`,
 * or null when it is not listed or the list cannot be read.
 * @param {import("../exec.mjs").StartResult} r
 * @param {string} repository
 * @param {string} tag
 */
function idOf(r, repository, tag) {
  if (r.status !== 0) return null;
  try {
    const list = JSON.parse(r.stdout.toString("utf8"));
    const entry = Array.isArray(list)
      ? list.find((t) => t && t.repository === repository && t.tag === tag)
      : undefined;
    const id = typeof entry?.id === "string" ? entry.id.replace(/^sha256:/, "") : "";
    return /^[0-9a-f]{64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * The layer that makes an image a Docker Sandboxes template, as Docker's
 * docs require of one (docs.docker.com/ai/sandboxes/customize/author/
 * base-images/): curl, git, CA certificates, /bin/sh and /bin/bash, and a
 * non-root `agent` account, uid 1000 with home /home/agent, set as the
 * image's USER. sbx writes /home/agent/AGENTS.md as a sandbox starts, so
 * without that home no sandbox starts at all.
 *
 * The tools are checked, never installed: an install would reach the base
 * image's package mirror from the host, which no recipe field names. An
 * existing uid 1000 account (`node`, in the Node.js images) is renamed to
 * `agent`, its home moved, rather than given a second name for one uid.
 * It runs as root, after the harness's install layer, and ends on USER agent.
 */
const TEMPLATE_LAYER = [
  "USER root",
  "RUN set -eu; \\",
  "  missing=''; \\",
  '  for tool in curl git bash sh; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done; \\',
  '  [ -s /etc/ssl/certs/ca-certificates.crt ] || [ -s /etc/pki/tls/certs/ca-bundle.crt ] || missing="$missing ca-certificates"; \\',
  '  if [ -n "$missing" ]; then \\',
  '    echo "agent-kit deep-scan: the recipe\'s image lacks$missing, which a Docker Sandboxes template needs (curl, git, CA certificates, sh and bash). Name an image that has them." >&2; exit 1; \\',
  "  fi; \\",
  "  command -v useradd >/dev/null 2>&1 && command -v usermod >/dev/null 2>&1 || { \\",
  '    echo "agent-kit deep-scan: the recipe\'s image has no useradd and usermod, to make the agent account a Docker Sandboxes template needs." >&2; exit 1; }; \\',
  '  existing="$(getent passwd 1000 | cut -d: -f1)"; \\',
  '  if [ "$existing" = agent ]; then :; \\',
  '  elif [ -n "$existing" ]; then \\',
  '    usermod -l agent -d /home/agent -m "$existing"; \\',
  '    group="$(getent group 1000 | cut -d: -f1)"; \\',
  '    if [ -n "$group" ] && [ "$group" != agent ]; then groupmod -n agent "$group"; fi; \\',
  "  else \\",
  "    getent group 1000 >/dev/null || groupadd -g 1000 agent; \\",
  "    useradd -u 1000 -g 1000 -m -d /home/agent -s /bin/bash agent; \\",
  "  fi; \\",
  "  mkdir -p /home/agent; chown 1000:1000 /home/agent",
  "USER agent",
  "",
].join("\n");
