// Contract for `agent-kit deep-scan` (cli/): the sandbox lifecycle on Docker Engine, from image to teardown.
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { main } from "../cli/src/cli.mjs";
import { tarOf } from "../cli/src/deep-scan/tar.mjs";
import {
  git,
  writeTree,
  VALID,
  ADOPTED,
  makeRepo,
  PLACEHOLDER,
  failing,
  REPORT_TEXT,
  COPY_OUT,
  probeOut,
  NO_REGISTRIES,
  docker,
  run,
  recipeRepo,
  recipe,
  lifecycle,
  stdinOf,
  tarEntries,
  verb,
  isAgentStep,
  isSetupStep,
  isCopyIn,
  isCopyOut,
  removed,
  containerOf,
  gvisorWith,
  isSandboxRun,
  relayRuns,
  flagValues,
} from "./cli-deep-scan-fixtures.mjs";

describe("the sandbox lifecycle runs in order on the chosen runtime", () => {
  it("pulls, layers, starts, copies in, sets up, cuts the network, runs the agent step, copies out and tears down", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    assert.deepEqual(calls.map(verb), [
      "pull",
      "build",
      "network create",
      "network inspect",
      "network create",
      "network inspect",
      "build",
      "run",
      "run",
      "run",
      "container inspect",
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
      "rm",
      "run",
      "run",
      "network inspect",
      "run",
      "exec",
      "exec",
      "exec",
      "rm",
      "rm",
      "rm",
      "rm",
      "rm",
      "rm",
      "image",
      "network rm",
      "network rm",
      "image",
    ]);
    assert.deepEqual(calls[0], ["pull", "node:22-bookworm"]);
    // setup, start, ready, seed, in that order, each through sh -c.
    const scripts = calls.filter(isSetupStep).map((a) => a.at(-1));
    assert.equal(scripts.length, 4);
    assert.equal(scripts[0], "npm ci");
    assert.match(scripts[1], /\nnpm run start &$/);
    assert.equal(scripts[2], "curl --fail http://localhost:3000/health");
    assert.equal(scripts[3], "npm run seed");
    assert.ok(isAgentStep(calls[23]));
  });

  it("writes the copied-out report to a private folder and says where", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    assert.deepEqual(readdirSync(res.reportDir), ["report.md"]);
    assert.equal(readFileSync(join(res.reportDir, "report.md"), "utf8"), REPORT_TEXT);
    assert.ok(res.out.includes(`Report: ${join(res.reportDir, "report.md")}`), res.out);
  });

  it("runs the sandbox under the chosen Docker runtime", async () => {
    const res = await run(recipeRepo(VALID));
    const runArgs = lifecycle(res).find(isSandboxRun);
    assert.equal(runArgs[runArgs.indexOf("--runtime") + 1], "runsc");
  });
});

describe("the image layers a pinned Claude Code with the auto-updater off", () => {
  it("builds FROM the recipe's image, installing an exact Claude Code version", async () => {
    const res = await run(recipeRepo(VALID));
    const dockerfile = stdinOf(res, (a) => a[0] === "build")?.toString("utf8");
    assert.ok(dockerfile, "the layer's Dockerfile comes on stdin");
    assert.match(dockerfile, /^FROM node:22-bookworm\n/);
    assert.match(dockerfile, /npm install --global @anthropic-ai\/claude-code@\d+\.\d+\.\d+ /);
    assert.match(dockerfile, /^ENV DISABLE_AUTOUPDATER=1$/m);
    assert.match(
      dockerfile,
      /'\{"env":\{"DISABLE_AUTOUPDATER":"1"\}\}' > \/etc\/claude-code\/managed-settings\.json/,
    );
    const build = lifecycle(res).find((a) => a[0] === "build");
    assert.equal(build.at(-1), "-", "built from stdin, with no host folder as context");
  });

  it("builds a recipe's Dockerfile from the trusted ref's tree, then layers on it", async () => {
    const text = recipe({ drop: ["image"], add: "dockerfile: docker/scan.Dockerfile" });
    const dir = makeRepo({
      committed: {
        ".security/scan-recipe.yml": text,
        "docker/scan.Dockerfile": "FROM node:22\n",
      },
      working: { "docker/scan.Dockerfile": "FROM evil:latest\n", "untracked.txt": "x\n" },
    });
    const res = await run(dir);
    assert.equal(res.code, 0, res.text);
    // The recipe's build and the layer, not the relay image's (#404).
    const builds = lifecycle(res).filter(
      (a) => a[0] === "build" && !a[a.indexOf("--tag") + 1].endsWith("-relay"),
    );
    assert.equal(builds.length, 2);
    assert.deepEqual(builds[0].slice(0, 3), ["build", "--file", "docker/scan.Dockerfile"]);
    const base = builds[0][builds[0].indexOf("--tag") + 1];
    const context = tarEntries(stdinOf(res, (a) => a[0] === "build" && a[1] === "--file"));
    const names = context.map((e) => e.name);
    assert.ok(names.includes("docker/scan.Dockerfile"), names.join(", "));
    assert.ok(!names.includes("untracked.txt"));
    const df = context.find((e) => e.name === "docker/scan.Dockerfile");
    assert.equal(df.data.toString("utf8"), "FROM node:22\n");
    const layer = stdinOf(res, (a) => a[0] === "build" && a[1] !== "--file").toString("utf8");
    assert.ok(layer.startsWith(`FROM ${base}\n`), layer);
  });
});

describe("the repository is copied in, never mounted, and only the listed inputs go in", () => {
  it("starts the sandbox with no mount, no host environment, no socket and no privilege", async () => {
    const res = await run(recipeRepo(VALID), [], {
      env: { PATH: "/usr/bin", HOME: "/home/me", AWS_PROFILE: "prod", ANTHROPIC_API_KEY: "sk" },
    });
    assert.equal(res.code, 0, res.text);
    const banned = ["-v", "--volume", "--mount", "--privileged", "--env-file", "--volumes-from"];
    for (const args of lifecycle(res)) {
      for (const a of args) {
        assert.ok(!banned.includes(a), `docker ${args.join(" ")} uses ${a}`);
        assert.doesNotMatch(a, /docker\.sock|\/home\/me|\.ssh|\.aws|gcloud|AWS_PROFILE/);
      }
      // The only variables set in the sandbox are the setup proxy's, and the
      // agent's placeholder key and traffic switch.
      args.forEach((a, i) => {
        if (a === "--env" || a === "-e") {
          assert.match(
            args[i + 1],
            new RegExp(
              `^(HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy)=|^ANTHROPIC_API_KEY=${PLACEHOLDER}-[0-9a-f]{48}$|^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1$`,
            ),
          );
        }
      });
    }
  });

  it("copies in a git archive of the default branch's tip, not a dirty working tree", async () => {
    const dir = makeRepo({
      committed: { ".security/scan-recipe.yml": VALID, "src/app.js": "committed\n" },
      working: { "src/app.js": "uncommitted edit\n", "scratch.txt": "untracked\n" },
    });
    const res = await run(dir);
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const cp = calls.find(isCopyIn);
    assert.deepEqual(cp, [
      "exec",
      "-i",
      "--user",
      "0:0",
      containerOf(calls),
      "tar",
      "-x",
      "-f",
      "-",
      "-C",
      "/",
    ]);
    const tree = tarEntries(stdinOf(res, isCopyIn));
    const files = tree.filter((e) => e.type === "0");
    assert.deepEqual(
      files.map((e) => e.name).sort(),
      [
        "workspace/.security/scan-recipe.yml",
        "workspace/README.md",
        "workspace/src/app.js",
        ...Object.keys(ADOPTED).map((p) => `workspace/${p}`),
      ].sort(),
    );
    assert.equal(
      files.find((e) => e.name === "workspace/src/app.js").data.toString("utf8"),
      "committed\n",
    );
    assert.match(
      res.out,
      /Copied in: main at [0-9a-f]{12} \(a git archive, not your working tree\)/,
    );
  });

  it("copies the default branch's tip when another branch is checked out", async () => {
    const dir = recipeRepo(VALID);
    git(dir, "switch", "-qc", "feature");
    writeTree(dir, { "feature.js": "off-branch\n" });
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "feature");
    const res = await run(dir);
    assert.equal(res.code, 0, res.text);
    const names = tarEntries(stdinOf(res, isCopyIn)).map((e) => e.name);
    assert.ok(names.includes("workspace/README.md"));
    assert.ok(!names.includes("workspace/feature.js"), names.join(", "));
  });

  it("copies the grounding in: repository paths from the trusted ref, URLs as fetched", async () => {
    const text = recipe({
      drop: ["grounding"],
      add: "grounding:\n  - docs/security.md\n  - https://example.com/guides/framework-security.md",
    });
    const dir = makeRepo({
      committed: { ".security/scan-recipe.yml": text, "docs/security.md": "committed doc\n" },
      working: { "docs/security.md": "edited doc\n" },
    });
    const fetched = [];
    const res = await run(dir, [], {
      fetch: async (url, init) => {
        fetched.push(url);
        assert.ok(init.signal, "the fetch can be stopped");
        return new Response("framework guide\n");
      },
    });
    assert.equal(res.code, 0, res.text);
    assert.deepEqual(fetched, ["https://example.com/guides/framework-security.md"]);
    const copies = res.shims.filter(
      (c) => c[0] === "docker" && isCopyIn(c.slice(1).filter((a) => typeof a === "string")),
    );
    assert.equal(
      copies.length,
      4,
      "the tree, the repository path, the fetched URL and the launcher's brief",
    );
    const entries = copies.flatMap((c) =>
      tarEntries(readFileSync(join(res.host.dir, c.find((a) => a?.stdin).stdin))),
    );
    const file = (name) => entries.find((e) => e.name === name && e.type === "0");
    assert.equal(
      file("agent-kit/grounding/docs/security.md").data.toString("utf8"),
      "committed doc\n",
    );
    assert.equal(
      file("agent-kit/grounding/urls/1-framework-security.md").data.toString("utf8"),
      "framework guide\n",
    );
    for (const e of entries) {
      assert.match(e.name, /^(workspace|agent-kit)(\/|$)/, `${e.name} is not a listed input`);
    }
  });

  it("ends the run before the agent step when a grounding URL cannot be fetched", async () => {
    const res = await run(recipeRepo(VALID), [], {
      fetch: async () => new Response("gone", { status: 404 }),
    });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /FAILED {2}grounding\[0\]: could not fetch https:\/\/example\.com\/framework-security\.md: HTTP 404/,
    );
    assert.ok(!lifecycle(res).some(isAgentStep));
    assert.ok(
      lifecycle(res).some((a) => a[0] === "rm"),
      "torn down",
    );
  });
});

describe("setup runs with the registry allowlist and no credential, and the network is cut before the agent step", () => {
  it("puts the sandbox on an internal network and sends setup through the host-side proxy", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const create = calls.find(
      (a) => a[0] === "network" && a[1] === "create" && a.includes("--internal"),
    );
    const net = create.at(-1);
    const runArgs = calls.find(isSandboxRun);
    assert.equal(runArgs[runArgs.indexOf("--network") + 1], net);
    for (const step of calls.filter(isSetupStep)) {
      assert.ok(
        step.some((a) => /^HTTPS_PROXY=http:\/\/198\.1[89]\.\d+\.10:\d+$/.test(a)),
        step.join(" "),
      );
    }
    assert.match(res.out, /Setup: egress limited to registry\.npmjs\.org/);
  });

  it("passes no model credential or agent to the setup phase", async () => {
    const res = await run(recipeRepo(VALID), [], {
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-real", CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
    });
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    // No setup step, nor anything before the agent step, sees a credential
    // variable; and the real values reach no runtime call at all.
    const beforeAgent = JSON.stringify(calls.slice(0, calls.findIndex(isAgentStep)));
    assert.doesNotMatch(beforeAgent, /ANTHROPIC|CLAUDE_CODE_OAUTH/);
    assert.doesNotMatch(JSON.stringify(calls), /sk-real|oauth/);
    for (const step of calls.filter(isSetupStep)) {
      assert.doesNotMatch(step.at(-1), /\bclaude\b/);
    }
  });

  it("lets setup reach a listed registry and refuses any other host", async () => {
    const server = createNetServer((socket) => socket.end("hi"));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const text = recipe({ drop: ["registries"], add: `registries:\n  - 127.0.0.1:${port}` });
      const host = gvisorWith({
        "~npm ci": { status: 0, probe: `127.0.0.1:${port}` },
        "~npm run seed": { status: 0, probe: "evil.example:443" },
      });
      const res = await run(recipeRepo(text), [], { host });
      assert.equal(res.code, 0, res.text);
      const probes = readFileSync(join(host.dir, "probes.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      assert.deepEqual(probes, [
        [`127.0.0.1:${port}`, 200],
        ["evil.example:443", 403],
      ]);
    } finally {
      server.close();
    }
  });

  it("gives setup nothing to reach when the recipe lists no registries", async () => {
    const text = recipe({ drop: ["registries"], add: "registries: []" });
    const res = await run(recipeRepo(text), [], { host: gvisorWith(NO_REGISTRIES) });
    assert.equal(res.code, 0, res.text);
    const all = lifecycle(res);
    // Up to the cut's probe: the model route comes after it.
    const calls = all.slice(
      0,
      all.findIndex((a) => flagValues(a, "--name")[0]?.endsWith("-probe-cut")),
    );
    const name = containerOf(calls);
    const runArgs = calls.find(isSandboxRun);
    assert.deepEqual(flagValues(runArgs, "--network"), [name]);
    assert.equal(relayRuns(calls).length, 0, "no setup relay");
    assert.ok(!JSON.stringify(calls).includes("PROXY"));
    assert.match(res.out, /Setup: no registries, so nothing on its network to reach\./);
    assert.match(
      res.out,
      /^Isolation: .* before the target starts; the sandbox reaches nothing\.$/m,
    );
  });

  it("cuts the network, and checks it from the host, before the agent step", async () => {
    const res = await run(recipeRepo(VALID));
    const calls = lifecycle(res);
    const cut = calls.findIndex((a) => a[0] === "rm" && !a.includes("--volumes"));
    const check = calls.findIndex((a) => flagValues(a, "--name")[0]?.endsWith("-probe-cut"));
    const agent = calls.findIndex(isAgentStep);
    const lastSetup = calls.findLastIndex(isSetupStep);
    assert.ok(lastSetup < cut && cut < check && check < agent, calls.map(verb).join(", "));
    assert.ok(!calls[agent].some((a) => /PROXY/.test(a)), "the agent step has no proxy");
    assert.match(res.out, /Network: cut \(checked from the host\)/);
  });

  it("ends the run before the agent step when the cut probe reaches the host", async () => {
    const host = gvisorWith({
      "~-probe-cut --label": {
        status: 0,
        stdout: probeOut(["unreachable", "unreachable", "refused"]),
      },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /the network is not cut: a probe on it reached the host network's gateway at 127\.0\.0\.1:22 \(refused\)/,
    );
    assert.ok(!lifecycle(res).some(isAgentStep));
    assert.ok(removed(lifecycle(res)).some((a) => a[0] === "rm"));
  });
});

describe("a failing setup, start or ready step ends the run before the agent step, with its output", () => {
  const cases = [
    ["setup", "~npm ci", 1],
    ["start", "~npm run start &", 1],
    ["ready", "~curl --fail", 7],
  ];
  for (const [field, key, status] of cases) {
    it(`ends at a failing ${field} step and shows its output`, async () => {
      const host = gvisorWith({
        [key]: { status, stdout: `${field} says hello\n`, stderr: `${field} broke\n` },
        "~cat /agent-kit/logs/start-": { status: 0, stdout: "server log: port in use\n" },
      });
      const res = await run(recipeRepo(VALID), [], { host });
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, new RegExp(`FAILED {2}${field}\\[0\\] exited ${status}`));
      assert.match(res.err, new RegExp(`${field} says hello`));
      assert.match(res.err, new RegExp(`${field} broke`));
      assert.match(res.err, /the run ends here, before the agent step/);
      if (field !== "setup") assert.match(res.err, /Output of start:\n {2}server log: port in use/);
      const calls = lifecycle(res);
      assert.ok(!calls.some(isAgentStep), "the agent step never ran");
      assert.ok(!calls.some(isCopyOut), "nothing was copied out");
      assert.equal(readdirSync(res.reportDir).length, 0);
      assert.deepEqual(removed(calls).map(verb), [
        "rm",
        "rm",
        "rm",
        "image",
        "network rm",
        "network rm",
        "image",
      ]);
    });
  }

  it("names the hosts the setup proxy refused", async () => {
    const host = gvisorWith({ "~npm ci": { status: 1, probe: "evil.example:443" } });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /The setup proxy refused: evil\.example:443 \(not in registries\)/);
  });

  it("shows the output when the image cannot be pulled", async () => {
    const host = gvisorWith({ pull: { status: 1, stderr: "manifest unknown\n" } });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /FAILED {2}pulling node:22-bookworm: manifest unknown/);
    assert.ok(!lifecycle(res).some((a) => a[0] === "run"));
  });
});

describe("only the report file comes out", () => {
  it("copies out the one report path, and nothing else", async () => {
    const res = await run(recipeRepo(VALID));
    const calls = lifecycle(res);
    const out = calls.filter(isCopyOut);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].slice(0, -1), [
      "exec",
      "--user",
      "0:0",
      containerOf(calls),
      "sh",
      "-c",
    ]);
    assert.match(out[0].at(-1), /^p=\/agent-kit\/out\/report\.md; /);
    assert.match(out[0].at(-1), /tar -c -f - -C \/agent-kit\/out report\.md$/);
  });

  it("moves files with docker exec, never docker cp, which gVisor's overlay hides (#404)", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    assert.ok(!calls.some((a) => a[0] === "cp"), calls.map((a) => a.join(" ")).join("\n"));
    // The brief goes in after the start step wrote under /agent-kit: through exec.
    const docker = res.shims.filter((c) => c[0] === "docker").map((c) => c.slice(1));
    const strings = (c) => c.filter((x) => typeof x === "string");
    const start = docker.findIndex(
      (c) => isSetupStep(strings(c)) && /mkdir -p \/agent-kit\/logs/.test(c.at(-1)),
    );
    const brief = docker.findIndex((c) => {
      const tag = c.find((x) => x && typeof x === "object" && x.stdin);
      if (!isCopyIn(strings(c)) || !tag) return false;
      const names = tarEntries(readFileSync(join(res.host.dir, tag.stdin))).map((e) => e.name);
      return names.includes("agent-kit/in/brief.md");
    });
    assert.ok(start >= 0 && brief > start, docker.map((c) => verb(strings(c))).join(", "));
    // The report comes out after the agent step wrote it: through exec too.
    assert.ok(calls.findIndex(isCopyOut) > calls.findIndex(isAgentStep));
  });

  for (const [status, why] of [
    [4, /the report was not copied out: it is not a regular file \(checked in the sandbox\)\./],
    [5, /the report was not copied out: it is larger than 10 MiB \(checked in the sandbox\)\./],
  ]) {
    it(`refuses a report the sandbox's check fails with ${status}, and writes nothing`, async () => {
      const host = gvisorWith({ [COPY_OUT]: { status, stderr: "" } });
      const res = await run(recipeRepo(VALID), [], { host });
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, why);
      assert.equal(readdirSync(res.reportDir).length, 0);
    });
  }

  const file = (path, text) => ({ path, data: Buffer.from(text) });
  const bad = [
    [
      "two files",
      () => tarOf([file("report.md", "a"), file("x.sh", "b")]),
      /holds 2 files, not one/,
    ],
    ["a folder", () => tarOf([{ path: "report.md", dir: true }]), /is not a regular file/],
    ["nothing", () => tarOf([]), /holds no file/],
  ];
  for (const [name, archive, why] of bad) {
    it(`refuses a copy-out that is ${name}, and writes no report`, async () => {
      const host = gvisorWith({
        [COPY_OUT]: { status: 0, base64: archive().toString("base64") },
      });
      const res = await run(recipeRepo(VALID), [], { host });
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, why);
      assert.equal(readdirSync(res.reportDir).length, 0);
      assert.ok(lifecycle(res).some((a) => a[0] === "rm"));
    });
  }

  it("refuses a symbolic link in place of the report", async () => {
    const link = tarOf([file("report.md", "")]);
    link[156] = "2".charCodeAt(0);
    const host = gvisorWith({
      [COPY_OUT]: { status: 0, base64: link.toString("base64") },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /is not a regular file \(tar type 2\)/);
    assert.equal(readdirSync(res.reportDir).length, 0);
  });

  it("ends with exit 1 when the agent step leaves no report", async () => {
    const host = gvisorWith({
      [COPY_OUT]: { status: 1, stderr: "Error: Could not find the file\n" },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /no report at \/agent-kit\/out\/report\.md/);
  });
});

describe("teardown runs on success, failure and interrupt", () => {
  const teardownOf = (res) => {
    const calls = lifecycle(res);
    const [net] = calls
      .filter((a) => a[0] === "network" && a[1] === "create" && a.includes("--internal"))
      .map((a) => a.at(-1));
    const build = calls.find((a) => a[0] === "build");
    const image = build?.[build.indexOf("--tag") + 1];
    return { calls: removed(calls), container: containerOf(calls), net, image };
  };

  it("removes the container, the relays, the probes, both networks and the images after a run that succeeds, the container first", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const t = teardownOf(res);
    assert.deepEqual(t.calls, [
      ["rm", "--force", "--volumes", t.container],
      ["rm", "--force", "--volumes", `${t.container}-probe-model`],
      ["rm", "--force", "--volumes", `${t.container}-relay-model`],
      ["rm", "--force", "--volumes", `${t.container}-probe-cut`],
      ["rm", "--force", "--volumes", `${t.container}-probe-setup`],
      ["rm", "--force", "--volumes", `${t.container}-relay-setup`],
      ["image", "rm", "--force", `${t.container}-relay`],
      ["network", "rm", t.net],
      ["network", "rm", `${t.container}-host`],
      ["image", "rm", "--force", t.image],
    ]);
    assert.match(res.out, /Teardown: removed /);
  });

  it("removes what was created when the agent step fails", async () => {
    const host = gvisorWith({ "~set -eu": { status: 2 } });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /The agent step exited 2/);
    assert.equal(teardownOf(res).calls.length, 10);
  });

  it("removes the container even when starting it failed", async () => {
    const host = gvisorWith({ "run --detach --init": { status: 125, stderr: "runsc: boom\n" } });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /FAILED {2}starting the sandbox: runsc: boom/);
    assert.deepEqual(teardownOf(res).calls.map(verb), [
      "rm",
      "rm",
      "rm",
      "image",
      "network rm",
      "network rm",
      "image",
    ]);
  });

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    it(`stops the running agent step on ${signal}, tears down, and exits ${code}`, async () => {
      const host = gvisorWith({ "~set -eu": { hang: true } });
      const signals = new EventEmitter();
      const res = await run(recipeRepo(VALID), [], {
        host,
        signals,
        onSpawn: (cmd, args, child) => {
          if (cmd === "docker" && isAgentStep(args)) {
            child.stdout.once("data", () => signals.emit(signal));
          }
        },
      });
      assert.equal(res.code, code, res.text);
      assert.match(res.err, new RegExp(`Interrupted \\(${signal}\\)`));
      const calls = lifecycle(res);
      assert.ok(!calls.some(isCopyOut), "nothing copied out");
      assert.deepEqual(removed(calls).map(verb), [
        "rm",
        "rm",
        "rm",
        "rm",
        "rm",
        "rm",
        "image",
        "network rm",
        "network rm",
        "image",
      ]);
      assert.equal(signals.listenerCount(signal), 0, "the handlers are removed");
    });
  }

  it("counts a step's docker child ended by Ctrl+C as an interrupt, not a failure", async () => {
    // A terminal sends SIGINT to the whole process group: the child can end
    // before the launcher's own handler runs.
    const host = gvisorWith({ "~npm ci": { killedBy: "SIGINT" } });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 130, res.text);
    assert.doesNotMatch(res.err, /FAILED/);
    assert.ok(!lifecycle(res).some(isAgentStep));
    assert.equal(removed(lifecycle(res)).length, 7);
  });

  it("tears down on an interrupt during setup, before the agent step", async () => {
    const host = gvisorWith({ "~npm ci": { hang: true } });
    const signals = new EventEmitter();
    const res = await run(recipeRepo(VALID), [], {
      host,
      signals,
      onSpawn: (cmd, args, child) => {
        if (args.at(-1) === "npm ci") child.stdout.once("data", () => signals.emit("SIGINT"));
      },
    });
    assert.equal(res.code, 130, res.text);
    assert.ok(!lifecycle(res).some(isAgentStep));
    assert.equal(removed(lifecycle(res)).length, 7);
  });

  it("says what it could not remove, and exits 1", async () => {
    const host = gvisorWith({
      "network rm": { status: 1, stderr: "Error: network has active endpoints\n" },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /TEARDOWN {2}could not remove:\n {2}- network agent-kit-deep-[0-9a-f]+: Error: network has active endpoints\n {2}- network agent-kit-deep-[0-9a-f]+-host: Error/,
    );
    assert.equal(removed(lifecycle(res)).length, 10, "it still tries every resource");
  });
});

describe("the sandbox docs", () => {
  it("say what goes into and out of the sandbox", () => {
    const page = readFileSync(join(import.meta.dirname, "..", "docs", "security-audit.md"), "utf8");
    const at = page.indexOf("## What goes into and out of the sandbox");
    assert.ok(at >= 0, "docs/security-audit.md has the section");
    const end = page.indexOf("\n## ", at + 1);
    const section = page.slice(at, end < 0 ? undefined : end);
    for (const fact of [
      "key-injecting model proxy",
      "`--bare`",
      "the run's caller key as its `ANTHROPIC_API_KEY`",
      "only `POST` to the Messages API's own paths",
      "a server-side tool",
      "`mcp_servers`",
      "`--settings`",
      "`--setting-sources user`",
      "web tools off",
      "`DEEP.md`",
      "Threat pack",
      "`/workspace`",
      "`/agent-kit/grounding`",
      "`host.docker.internal:<port>`",
      "Nothing is filed or posted",
      "auto-updater is off",
      "no mount",
      "`git archive`",
      "never the working tree",
      "grounding",
      "no model credential",
      "`registries`",
      "`--internal`",
      "checks from your machine",
      "Exactly one file comes out",
      "/agent-kit/out/report.md",
      "every exit path",
      "interrupt",
      "agent-kit.deep-scan",
      "On Docker Sandboxes",
      "must be deny-all",
      "`sbx policy ls --json`",
      "never changes your global policy",
      "A `dockerfile` recipe is refused",
    ]) {
      assert.ok(section.includes(fact), `the section says ${fact}`);
    }
  });
});
