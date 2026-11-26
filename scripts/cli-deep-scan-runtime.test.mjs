// Contract for `agent-kit deep-scan` (cli/): the sandbox runtime chosen from the host, its refusal, and the pre-flight refusals.
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { allowedCommands, RUNTIME_CLIS, runnerFor } from "../cli/src/exec.mjs";
import {
  git,
  VALID,
  makeRepo,
  ok,
  REAL_KEY,
  failing,
  docker,
  RUNC,
  makeHost,
  run,
  recipeRepo,
  ACCEPTED_LIST,
  CI_PATH,
  NO_OVERRIDE,
  RUNTIME_DOCS,
  assertNothingStarted,
  ALL_RUNTIMES,
  without,
} from "./cli-deep-scan-fixtures.mjs";

describe("the sandbox runtime is chosen from the host in preference order", () => {
  const desktop = (kernel) => docker({ os: "Docker Desktop", kernel });
  const cases = [
    [
      "Linux with every runtime: Docker Sandboxes",
      "linux",
      ALL_RUNTIMES,
      /Docker Sandboxes \(sbx\)/,
    ],
    [
      "Linux without sbx: Kata before Firecracker and gVisor",
      "linux",
      without("sbx"),
      /Kata Containers, as the Docker runtime "kata"/,
    ],
    [
      "Linux with Firecracker and gVisor: Firecracker",
      "linux",
      without("sbx", "kata-runtime"),
      /Firecracker, as the Docker runtime "kata-fc"/,
    ],
    [
      "Linux with gVisor only: gVisor",
      "linux",
      without("sbx", "kata-runtime", "firecracker"),
      /gVisor \(runsc\), as the Docker runtime "runsc"/,
    ],
    [
      "Linux where sbx fails: the next accepted runtime",
      "linux",
      { ...without("kata-runtime", "firecracker"), sbx: failing("sbx: not supported") },
      /gVisor \(runsc\)/,
    ],
    [
      "macOS with sbx and Docker Desktop: Docker Sandboxes",
      "darwin",
      { sbx: ALL_RUNTIMES.sbx, docker: desktop("6.10.14-linuxkit") },
      /Docker Sandboxes \(sbx\)/,
    ],
    [
      "Windows with sbx beside Docker Desktop on WSL 2: Docker Sandboxes",
      "win32",
      { sbx: ALL_RUNTIMES.sbx, docker: desktop("5.15.167.4-microsoft-standard-WSL2") },
      /Docker Sandboxes \(sbx\)/,
    ],
  ];
  for (const [name, platform, clis, chosen] of cases) {
    it(name, async () => {
      const res = await run(recipeRepo(VALID), [], { host: makeHost(platform, clis) });
      const line = res.out.split("\n").find((l) => l.startsWith("Sandbox runtime: "));
      assert.ok(line, res.text);
      assert.match(line, chosen);
      assert.equal(res.code, 0, res.text);
      // The lifecycle ran on the chosen runtime's own CLI.
      const cli = /sbx/.test(line) ? "sbx" : "docker";
      assert.ok(
        res.shims.some(([c, ...a]) => c === cli && a.some((x) => /^agent-kit-deep-/.test(x))),
        `${cli} ran the sandbox`,
      );
    });
  }

  it("counts kata-fc on Kata's shared shim path as Firecracker, not Kata", async () => {
    const host = makeHost("linux", {
      docker: docker({
        runtimes: { ...RUNC, "kata-fc": { path: "/opt/kata/bin/containerd-shim-kata-v2" } },
      }),
      "kata-runtime": ALL_RUNTIMES["kata-runtime"],
      firecracker: ALL_RUNTIMES.firecracker,
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 0, res.text);
    assert.match(res.out, /Sandbox runtime: Firecracker, as the Docker runtime "kata-fc"/);
  });

  it("checks the backend from the host: a Kata CLI that Docker does not run is not Kata", async () => {
    const host = makeHost("linux", {
      docker: docker({ runtimes: RUNC }),
      "kata-runtime": ALL_RUNTIMES["kata-runtime"],
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /Plain Docker on Linux/);
  });

  it("probes only from the host: docker info and version checks, nothing inside a container", async () => {
    const res = await run(recipeRepo(VALID), [], { host: makeHost("linux", without("sbx")) });
    assert.equal(res.code, 0, res.text);
    const isProbe = ([cli, ...args]) =>
      (cli === "docker" && args.join(" ") === "info --format {{json .}}") ||
      (cli === "sbx" && args.join(" ") === "version") ||
      args.join(" ") === "--version";
    // The probes come first, and the first command after them is the image
    // pull: the runtime is chosen before anything starts.
    const first = res.shims.findIndex((c) => !isProbe(c));
    assert.ok(first > 0, JSON.stringify(res.shims));
    assert.deepEqual(res.shims[first].slice(0, 2), ["docker", "pull"]);
    assert.ok(!res.shims.slice(first).some(isProbe), "no probe after the lifecycle began");
  });
});

describe("a host with no accepted runtime is refused, with no override", () => {
  const cases = [
    [
      "plain Docker on Linux, saying what to install",
      "linux",
      { docker: docker({ runtimes: RUNC }) },
      [
        /REFUSED  Plain Docker on Linux shares the host's kernel/,
        /Install one of: gVisor \(runsc\), Kata Containers or Firecracker, each registered as a Docker runtime, or Docker Sandboxes \(sbx\)/,
      ],
    ],
    [
      "Docker Desktop on Windows with WSL 2, explaining the shared kernel and network namespace",
      "win32",
      { docker: docker({ os: "Docker Desktop", kernel: "5.15.167.4-microsoft-standard-WSL2" }) },
      [
        /REFUSED  Docker Desktop on Windows with the WSL 2 backend/,
        /shares one Linux kernel and network namespace with your other WSL distros/,
      ],
    ],
    [
      "a host with nothing installed",
      "linux",
      {},
      [/REFUSED  No accepted sandbox runtime found on this Linux host/],
    ],
    [
      "a Docker daemon that does not answer",
      "linux",
      { docker: failing("Cannot connect to the Docker daemon") },
      [
        /REFUSED  No accepted sandbox runtime found on this Linux host/,
        /docker info failed: Cannot connect to the Docker daemon/,
      ],
    ],
    [
      "a Docker daemon that is down while docker info exits 0",
      "linux",
      {
        docker: {
          "info --format {{json .}}": {
            status: 0,
            stdout: JSON.stringify({ ServerErrors: ["Cannot connect to the Docker daemon"] }),
          },
        },
      },
      [/REFUSED  No accepted sandbox runtime found/, /docker info failed: Cannot connect/],
    ],
    [
      "Docker on macOS that is not Docker Desktop",
      "darwin",
      { docker: docker({ os: "Ubuntu 24.04 LTS" }) },
      [/REFUSED  Docker \(Ubuntu 24\.04 LTS\) on macOS is not an accepted sandbox runtime/],
    ],
    [
      "Docker Desktop on Windows with the Hyper-V backend",
      "win32",
      { docker: docker({ os: "Docker Desktop", kernel: "6.10.14-linuxkit" }) },
      [/REFUSED  Docker \(Docker Desktop\) on Windows is not an accepted sandbox runtime/],
    ],
    [
      "gVisor on a host that is not Linux",
      "win32",
      { runsc: ok("runsc version\n") },
      [/REFUSED  No accepted sandbox runtime found on this Windows host/],
    ],
  ];
  for (const [name, platform, clis, messages] of cases) {
    it(`refuses ${name}, naming the accepted runtimes and the CI path`, async () => {
      const res = await run(recipeRepo(VALID), [], { host: makeHost(platform, clis) });
      assert.equal(res.code, 1, res.text);
      for (const m of messages) assert.match(res.err, m);
      assert.match(res.err, ACCEPTED_LIST);
      assert.match(res.err, CI_PATH);
      assert.match(res.err, NO_OVERRIDE);
      assert.match(res.err, RUNTIME_DOCS);
      assertNothingStarted(res);
    });
  }

  for (const flag of [
    "--runtime=docker",
    "--allow-runtime",
    "--force",
    "--unsafe",
    "--no-sandbox",
  ]) {
    it(`has no override flag: ${flag} is a usage error that runs nothing`, async () => {
      const host = makeHost("linux", { docker: docker({ runtimes: RUNC }) });
      const res = await run(recipeRepo(VALID), [flag], { host });
      assert.equal(res.code, 2, res.text);
      assert.equal(res.calls.length, 0);
    });
  }
});

describe("pre-flight: a stray credential refuses the run before any runtime is touched", () => {
  for (const [name, env, named] of [
    ["GH_TOKEN", { GH_TOKEN: "ghp_x" }, /GH_TOKEN/],
    ["GITHUB_TOKEN", { GITHUB_TOKEN: "ghs_x" }, /GITHUB_TOKEN/],
    ["both tokens, naming both", { GH_TOKEN: "a", GITHUB_TOKEN: "b" }, /GH_TOKEN and GITHUB_TOKEN/],
    ["a token in another letter case", { Gh_Token: "ghp_x" }, /Gh_Token/],
  ]) {
    it(`refuses ${name} in the environment, and no runtime CLI runs`, async () => {
      const host = makeHost("linux", ALL_RUNTIMES);
      const res = await run(recipeRepo(VALID), [], { host, env: { PATH: "/usr/bin", ...env } });
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, /REFUSED  .*must never reach the sandbox/);
      assert.match(res.err, named);
      assert.match(res.err, /env -u GH_TOKEN -u GITHUB_TOKEN/);
      assert.doesNotMatch(res.text, /ghp_x|ghs_x/);
      assert.deepEqual(res.shims, []);
      assert.ok(res.calls.every((c) => c[0] === "git"));
    });
  }

  it("lets an empty GH_TOKEN through, as it holds no token", async () => {
    const res = await run(recipeRepo(VALID), [], {
      env: { PATH: "/usr/bin", GH_TOKEN: "", ANTHROPIC_API_KEY: REAL_KEY },
    });
    assert.equal(res.code, 0, res.text);
  });

  for (const path of [".env", "config/.env", ".env.local", "app/.env.production"]) {
    it(`refuses ${path} committed at the trusted ref, which the copy-in would carry whole`, async () => {
      const host = makeHost("linux", ALL_RUNTIMES);
      const dir = makeRepo({
        committed: { ".security/scan-recipe.yml": VALID, [path]: "SECRET=1\n" },
      });
      const res = await run(dir, [], { host });
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, /REFUSED  /);
      assert.ok(res.err.includes(`  - ${path}`), res.err);
      assert.match(res.err, /forwarded wholesale/);
      assert.doesNotMatch(res.text, /SECRET=1/);
      assert.deepEqual(res.shims, []);
    });
  }

  for (const path of [
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    "docs/.envrc.md",
  ]) {
    it(`lets ${path} through, as it is not an environment file`, async () => {
      const dir = makeRepo({ committed: { ".security/scan-recipe.yml": VALID, [path]: "X=\n" } });
      const res = await run(dir);
      assert.equal(res.code, 0, res.text);
    });
  }

  it("ignores a .env only in the working tree, which is never copied in", async () => {
    const dir = makeRepo({
      committed: { ".security/scan-recipe.yml": VALID },
      working: { ".env": "SECRET=1\n" },
    });
    const res = await run(dir);
    assert.equal(res.code, 0, res.text);
  });
});

describe("the process allowlist widens for deep-scan alone", () => {
  const recordingSpawn = (seen) => (cmd, args) => {
    seen.push([cmd, ...args]);
    return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
  };

  it("lets deep-scan run git, every runtime CLI and the 1Password CLI, and nothing else", () => {
    const allowed = ["git", ...RUNTIME_CLIS, "op"];
    assert.deepEqual([...allowedCommands("deep-scan")].sort(), [...allowed].sort());
    const seen = [];
    const runner = runnerFor("deep-scan", { spawn: recordingSpawn(seen) });
    for (const cli of allowed) runner(cli, ["--version"]);
    assert.deepEqual(
      seen.map((c) => c[0]),
      allowed,
    );
    for (const cli of ["gh", "sh", "bash", "node", "cmd.exe", "powershell", "podman", "claude"]) {
      assert.throws(() => runner(cli, []), /refusing to run .*: deep-scan may run only/);
    }
    assert.equal(seen.length, allowed.length);
  });

  for (const command of ["init", "upgrade", "doctor"]) {
    it(`keeps ${command} to git and gh`, () => {
      assert.deepEqual([...allowedCommands(command)], ["git", "gh"]);
      const seen = [];
      const runner = runnerFor(command, { spawn: recordingSpawn(seen) });
      for (const cli of [...RUNTIME_CLIS, "op"]) {
        assert.throws(() => runner(cli, []), new RegExp(`refusing to run ${cli}`));
      }
      assert.deepEqual(seen, []);
    });
  }
});

describe("the runtime docs", () => {
  it("list the accepted and the refused runtimes and the pre-flight refusals", () => {
    const page = readFileSync(join(import.meta.dirname, "..", "docs", "security-audit.md"), "utf8");
    const at = page.indexOf("## Sandbox runtimes");
    assert.ok(at >= 0, "docs/security-audit.md has a Sandbox runtimes section");
    const end = page.indexOf("\n## ", at + 1);
    const section = page.slice(at, end < 0 ? undefined : end);
    for (const name of [
      "Docker Sandboxes",
      "Kata",
      "Firecracker",
      "gVisor",
      "Docker Desktop on macOS",
      "Plain Docker on Linux",
      "WSL 2",
      "no override",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      ".env",
    ]) {
      assert.ok(section.includes(name), `the section names ${name}`);
    }
  });
});
