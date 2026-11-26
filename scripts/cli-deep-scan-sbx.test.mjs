// Contract for `agent-kit deep-scan` (cli/): the same lifecycle on Docker Sandboxes.
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  VALID,
  tmp,
  makeRepo,
  TEMPLATE_ID,
  REPORT_TEXT,
  docker,
  SBX_DENY_ALL,
  sbxAnswers,
  makeHost,
  run,
  recipeRepo,
  recipe,
  tarEntries,
  isAgentStep,
  sbxCalls,
  sbxHost,
  dockerCalls,
  untemplated,
  sbxVerb,
  withRule,
  sandboxName,
} from "./cli-deep-scan-fixtures.mjs";

describe("Docker Sandboxes runs the same lifecycle, on a deny-all global policy", () => {
  it("checks the policy, loads the layered template, creates a mountless sandbox, sets up, cuts, runs the agent, copies out and removes both", async () => {
    const res = await run(recipeRepo(VALID), [], { host: sbxHost() });
    assert.equal(res.code, 0, res.text);
    const calls = sbxCalls(res);
    assert.deepEqual(calls.map(sbxVerb), [
      "version",
      "policy ls",
      "template",
      "template",
      "create",
      "cp",
      "exec",
      "cp",
      "exec",
      "policy allow network",
      "exec",
      "exec",
      "exec",
      "exec",
      "policy rm network",
      "policy ls",
      "policy allow network",
      "policy ls",
      "cp",
      "exec",
      "exec",
      // The report's in-sandbox type and size check, before sbx cp.
      "exec",
      "cp",
      "policy rm network",
      "rm",
      "template",
    ]);
    assert.deepEqual(calls[2].slice(0, 2), ["template", "load"]);
    assert.deepEqual(calls[3], ["template", "ls", "--json"]);
    assert.deepEqual(calls.at(-1).slice(0, 2), ["template", "rm"]);
    assert.equal(readFileSync(join(res.reportDir, "report.md"), "utf8"), REPORT_TEXT);
    assert.ok(isAgentStep(calls[20]), calls[20].join(" "));
    assert.match(res.out, /Network policy: Docker Sandboxes' global policy is deny-all/);
  });

  it("creates the sandbox mountless, from the template layered on the recipe's image, with the auto-updater off", async () => {
    const res = await run(recipeRepo(VALID), [], { host: sbxHost() });
    const create = sbxCalls(res).find((a) => a[0] === "create");
    const name = sandboxName(sbxCalls(res));
    assert.match(name, /^agent-kit-deep-[0-9a-f]{12}$/);
    assert.equal(create[create.indexOf("-t") + 1], `${name}:sbx`);
    // The template is the one just loaded: sbx never pulls it.
    assert.equal(create[create.indexOf("--pull") + 1], "never");
    assert.equal(create[create.indexOf("-e") + 1], "DISABLE_AUTOUPDATER=1");
    assert.equal(create.at(-1), "shell", "the agent, and no workspace path after it");
    for (const flag of ["--mount", "-v", "--volume", "--env-file", "--clone", "--cloud"]) {
      assert.ok(!create.includes(flag), `create uses ${flag}`);
    }
  });

  it("layers the pinned Claude Code and /home/agent on the recipe's image with Docker on the host, and loads it as the template", async () => {
    const res = await run(recipeRepo(VALID), [], { host: sbxHost() });
    assert.equal(res.code, 0, res.text);
    const name = sandboxName(sbxCalls(res));
    const tag = `${name}:sbx`;
    const docker = dockerCalls(res);
    const strings = (a) => a.filter((x) => typeof x === "string");
    assert.deepEqual(
      docker.map((a) => (a[0] === "image" ? a.slice(0, 2).join(" ") : a[0])),
      ["pull", "build", "save", "image rm"],
    );
    assert.deepEqual(docker[0], ["pull", "node:22-bookworm"]);
    assert.deepEqual(strings(docker[1]), [
      "build",
      "--label",
      `agent-kit.deep-scan=${name.slice("agent-kit-deep-".length)}`,
      "--tag",
      tag,
      "-",
    ]);
    // The layer: the Docker driver's, then what Docker's docs require of a
    // Sandboxes template image (run evidence sbx-docs-custom-images.txt).
    const stdin = docker[1].find((x) => x && typeof x === "object" && x.stdin);
    const dockerfile = readFileSync(join(res.host.dir, stdin.stdin), "utf8");
    assert.match(dockerfile, /^FROM node:22-bookworm\n/);
    assert.match(dockerfile, /npm install --global @anthropic-ai\/claude-code@\d+\.\d+\.\d+/);
    assert.match(dockerfile, /managed-settings\.json/);
    // Tools are checked, never installed: the build reaches no package mirror.
    for (const tool of ["curl", "git", "bash", "sh"]) {
      assert.match(dockerfile, new RegExp(`for tool in [^;]*\\b${tool}\\b`), tool);
    }
    assert.match(dockerfile, /ca-certificates\.crt/);
    assert.ok(!/apt-get|apk add|dnf |yum /.test(dockerfile), "nothing is installed");
    // A non-root agent at uid 1000 with home /home/agent: an existing uid
    // 1000 user (node, in node images) is renamed, not doubled.
    assert.match(dockerfile, /usermod -l agent -d \/home\/agent -m "\$existing"/);
    assert.match(dockerfile, /useradd -u 1000 -g 1000 -m -d \/home\/agent -s \/bin\/bash agent/);
    assert.match(dockerfile, /\nUSER agent\n$/, "the image's last word is USER agent");
    assert.ok(dockerfile.indexOf("USER agent") > dockerfile.indexOf("claude-code@"));
    // Saved to a private host file, loaded by its name, then gone.
    assert.deepEqual(docker[2].slice(0, 2), ["save", "--output"]);
    assert.equal(docker[2][3], tag);
    const load = sbxCalls(res).find((a) => a[0] === "template" && a[1] === "load");
    assert.deepEqual(load, ["template", "load", docker[2][2]]);
    assert.ok(!/[\\/]/.test(docker[2][2]), "relative to the private folder");
    // Teardown: the sandbox, then its template by image id, which removes
    // the assembled tag sbx gave it as well, then the layered image.
    assert.deepEqual(sbxCalls(res).at(-1), ["template", "rm", "--force", TEMPLATE_ID.slice(7)]);
    assert.deepEqual(docker.at(-1), ["image", "rm", "--force", tag]);
    assert.match(
      res.out,
      /Image: layering the pinned Claude Code on node:22-bookworm with Docker on this machine/,
    );
  });

  it("runs no install and opens no registry.npmjs.org rule in the sandbox", async () => {
    const res = await run(recipeRepo(VALID), [], { host: sbxHost() });
    assert.equal(res.code, 0, res.text);
    const calls = sbxCalls(res);
    assert.ok(!calls.some((a) => a[0] === "exec" && /claude-code@/.test(a.at(-1))));
    assert.ok(!calls.some((a) => a.includes("registry.npmjs.org:443")));
  });

  it("ends before any sandbox when the layer build fails, removing the layered image and leaving no template", async () => {
    const host = sbxHost(
      {},
      { build: { status: 1, stderr: "failed to resolve source metadata\n" } },
    );
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /FAILED {2}layering Claude Code on node:22-bookworm/);
    assert.ok(!sbxCalls(res).some((a) => a[0] === "create" || a[0] === "template"));
    assert.deepEqual(dockerCalls(res).at(-1).slice(0, 3), ["image", "rm", "--force"]);
  });

  it("refuses, before any sandbox, when Docker is not installed to build the template", async () => {
    const host = makeHost("win32", { sbx: sbxAnswers() });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /Docker Sandboxes' template is built with Docker on this machine/);
    assert.ok(!sbxCalls(res).some((a) => a[0] === "create" || a[0] === "template"));
  });

  it("removes the template by its tag when sbx does not list it, and still removes the image", async () => {
    const host = sbxHost({ "--no-input template ls --json": { status: 0, stdout: "[]" } });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 0, res.text);
    const name = sandboxName(sbxCalls(res));
    assert.deepEqual(sbxCalls(res).at(-1), ["template", "rm", "--force", `${name}:sbx`]);
    assert.deepEqual(dockerCalls(res).at(-1), ["image", "rm", "--force", `${name}:sbx`]);
  });

  it("removes the layered image when the template load fails, and creates no sandbox", async () => {
    const host = sbxHost({ "--no-input template load": { status: 1, stderr: "no space left\n" } });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /loading the layered image into Docker Sandboxes/);
    const calls = sbxCalls(res);
    assert.ok(!calls.some((a) => a[0] === "create"));
    assert.ok(!calls.some((a) => a[0] === "template" && a[1] === "rm"), "no template was loaded");
    assert.deepEqual(dockerCalls(res).at(-1).slice(0, 3), ["image", "rm", "--force"]);
  });

  it("allows only the registries for setup, per sandbox, and removes them before the agent step", async () => {
    const res = await run(recipeRepo(VALID), [], { host: sbxHost() });
    const calls = sbxCalls(res);
    const name = sandboxName(calls);
    // The setup rule is the last before the cut's check; the model route's
    // comes after it.
    const check = calls.findIndex((a) => a[0] === "policy" && a[1] === "ls" && a[2] === name);
    const allows = calls.slice(0, check).filter((a) => a[0] === "policy" && a[1] === "allow");
    assert.deepEqual(allows.at(-1), [
      "policy",
      "allow",
      "network",
      "--sandbox",
      name,
      "registry.npmjs.org:80,registry.npmjs.org:443",
    ]);
    for (const a of calls.filter((x) => x[0] === "policy")) {
      assert.ok(a.includes("--sandbox") || a[1] === "ls", `sbx ${a.join(" ")} is not per sandbox`);
      assert.ok(!["init", "reset"].includes(a[1]), "never changes the global policy");
    }
    const cut = calls.slice(0, check).findLastIndex((a) => a[0] === "policy" && a[1] === "rm");
    const agent = calls.findIndex(isAgentStep);
    assert.deepEqual(calls[cut].slice(-3), [
      "--resource",
      "registry.npmjs.org:80,registry.npmjs.org:443",
      "--force",
    ]);
    assert.deepEqual(calls[check], ["policy", "ls", name, "--json"]);
    assert.ok(cut < check && check < agent);
    assert.ok(!calls.some((a) => a[0] === "reset"));
    // Setup steps get no proxy variables: sbx's own host proxy enforces it.
    for (const a of calls.filter((x) => x[0] === "exec")) {
      assert.ok(!a.some((x) => /PROXY=/.test(x)), a.join(" "));
    }
  });

  it("copies in the default branch's tree through a private host file, never a mount", async () => {
    const dir = makeRepo({
      committed: { ".security/scan-recipe.yml": VALID, "src/app.js": "committed\n" },
      working: { "src/app.js": "edited\n" },
    });
    const res = await run(dir, [], { host: sbxHost() });
    assert.equal(res.code, 0, res.text);
    const cp = res.shims.find((c) => c[0] === "sbx" && c[2] === "cp");
    assert.match(cp[3], /^in-\d+\.tar$/, "a relative host path, never a drive letter");
    assert.match(cp[4], /^agent-kit-deep-[0-9a-f]+:\/tmp\/agent-kit-in-\d+\.tar$/);
    const tree = tarEntries(readFileSync(join(res.host.dir, cp.find((a) => a?.stdin).stdin)));
    const app = tree.find((e) => e.name === "workspace/src/app.js");
    assert.equal(app.data.toString("utf8"), "committed\n");
    const unpack = sbxCalls(res)[6];
    assert.match(unpack.at(-1), /^tar -xf \/tmp\/agent-kit-in-0\.tar -C \/ && rm -f /);
  });

  it("ends before the agent step when unpacking the copied-in tree fails", async () => {
    const host = sbxHost({ "~tar -xf": { status: 2, stderr: "tar: not found\n" } });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /FAILED {2}copying the repository in \(unpacking it\): tar: not found/);
    assert.ok(!sbxCalls(res).some(isAgentStep));
    assert.equal(untemplated(sbxCalls(res)).at(-1)[0], "rm");
  });

  it("refuses an uninitialised global policy, says what to run, and starts nothing", async () => {
    const host = sbxHost({
      "--no-input policy ls --json": {
        status: 1,
        stderr:
          "error: global network policy has not been initialized\n  try: sbx policy init <allow-all|balanced|deny-all>\n",
      },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /REFUSED {2}Docker Sandboxes' global network policy has not been initialized/,
    );
    assert.match(res.err, /Run `sbx policy init deny-all` yourself/);
    assert.deepEqual(sbxCalls(res).map(sbxVerb), ["version", "policy ls"]);
  });

  it("refuses a global policy with a network allow rule, naming it, and starts nothing", async () => {
    const host = sbxHost({
      "--no-input policy ls --json": {
        status: 0,
        stdout: withRule({ id: "balanced-npm", decision: "allow" }),
      },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /global network policy is not deny-all/);
    assert.match(res.err, /Global allow rules: balanced-npm\./);
    assert.ok(!sbxCalls(res).some((a) => a[0] === "create"));
  });

  it("refuses a policy without the active deny-all rule, or one it cannot read", async () => {
    const noDeny = JSON.parse(SBX_DENY_ALL);
    noDeny.rules = noDeny.rules.filter((r) => r.id !== "default-deny-all");
    for (const stdout of [JSON.stringify(noDeny), "not json\n", '{"rules": "x"}']) {
      const host = sbxHost({ "--no-input policy ls --json": { status: 0, stdout } });
      const res = await run(recipeRepo(VALID), [], { host });
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, /REFUSED {2}/);
      assert.ok(!sbxCalls(res).some((a) => a[0] === "create"));
    }
  });

  it("refuses a dockerfile recipe, whose build would run on the host's Docker, before touching anything", async () => {
    const text = recipe({ drop: ["image"], add: "dockerfile: docker/scan.Dockerfile" });
    const res = await run(recipeRepo(text), [], { host: sbxHost() });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /on Docker Sandboxes its build steps would run on this machine's Docker/);
    assert.deepEqual(sbxCalls(res).map(sbxVerb), ["version"]);
    assert.deepEqual(dockerCalls(res), [], "nothing is pulled or built");
  });

  it("ends before the agent step when the sandbox's policy still allows a host", async () => {
    const host = sbxHost({
      "--no-input policy ls agent-kit-deep-": {
        status: 0,
        stdout: withRule({ scope: "local", decision: "allow", resources: ["evil.example:443"] }),
      },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /the network is not cut: sbx policy ls still allows evil\.example:443/);
    assert.ok(!sbxCalls(res).some(isAgentStep));
    assert.equal(untemplated(sbxCalls(res)).at(-1)[0], "rm");
  });

  it("removes the setup rule and the sandbox on an interrupt during setup", async () => {
    const host = sbxHost({ "~npm ci": { hang: true } });
    const signals = new EventEmitter();
    const res = await run(recipeRepo(VALID), [], {
      host,
      signals,
      onSpawn: (cmd, args, child) => {
        if (cmd === "sbx" && args.at(-1) === "npm ci") {
          child.stdout.once("data", () => signals.emit("SIGINT"));
        }
      },
    });
    assert.equal(res.code, 130, res.text);
    const calls = sbxCalls(res);
    assert.deepEqual(untemplated(calls).slice(-2).map(sbxVerb), ["policy rm network", "rm"]);
    assert.deepEqual(untemplated(calls).at(-1).slice(0, 2), ["rm", "--force"]);
  });

  const outs = [
    ["a folder", [{ name: "report.md", dir: true }], /report\.md is not a regular file/],
    [
      "two entries",
      [
        { name: "report.md", text: "a" },
        { name: "x.sh", text: "b" },
      ],
      /holds 2 entries, not one file/,
    ],
  ];
  for (const [what, writes, why] of outs) {
    it(`refuses a copy-out that is ${what}, and writes no report`, async () => {
      const host = sbxHost({ "--no-input cp agent-kit-deep-": { status: 0, writes } });
      const res = await run(recipeRepo(VALID), [], { host });
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, why);
      assert.equal(readdirSync(res.reportDir).length, 0);
      assert.equal(untemplated(sbxCalls(res)).at(-1)[0], "rm");
    });
  }

  it("copies the report out into a private folder, relative to it", async () => {
    const res = await run(recipeRepo(VALID), [], { host: sbxHost() });
    const out = sbxCalls(res).filter((a) => a[0] === "cp" && a[1].startsWith("agent-kit-deep-"));
    assert.equal(out.length, 1);
    assert.match(out[0][1], /^agent-kit-deep-[0-9a-f]+:\/agent-kit\/out\/report\.md$/);
    assert.equal(out[0][2], ".");
  });
});
