// Contract for `agent-kit deep-scan` (cli/): finding the Consumer's Scan
// recipe at the trusted ref (the default branch's tip, never the working
// tree), validating it, and refusing with a pointer to the docs when it is
// missing or invalid; then the pre-flight refusals (a GitHub token in the
// environment, a .env the copy-in would carry wholesale) and the choice of a
// sandbox runtime from the host, or its refusal. git runs for real against
// local fixture repositories (no network). The sandbox runtimes' CLIs (`sbx`,
// `docker`, `runsc`, `kata-runtime`, `firecracker`) are fake: shim scripts
// run as real child processes behind the CLI's real process allowlist, each
// recording its arguments. Nothing else is ever run.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { main } from "../cli/src/cli.mjs";
import { allowedCommands, RUNTIME_CLIS, runnerFor, systemRunner } from "../cli/src/exec.mjs";

const GIT_ID = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@example.com",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
];

function git(cwd, ...args) {
  const r = systemRunner("git", ["-C", cwd, ...GIT_ID, ...args]);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function writeTree(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const DOCS = /docs\/security-audit\.md#scan-recipe/;

/** A recipe every check accepts: a web app with services and a CLI entry point. */
const VALID = `# Scan recipe
image: node:22-bookworm
setup:
  - npm ci
registries:
  - registry.npmjs.org
start:
  - npm run start &
ready:
  - curl --fail http://localhost:3000/health
seed:
  - npm run seed
entry_points:
  - url: http://localhost:3000/
    note: The web app, signed in or not.
  - port: 5432
    note: Postgres, reachable only from inside the sandbox.
  - command: node bin/cli.js
    note: The CLI, run with any arguments.
fixtures:
  - user: alice
    password: fake-password-1
    role: admin
grounding:
  - https://example.com/framework-security.md
notes:
  - The GitHub workflows stay static-only.
`;

let tmp;
let n = 0;

/**
 * A fixture repository on branch `main` with `committed` committed, then
 * `working` written over it uncommitted.
 */
function makeRepo({ committed = {}, working = {}, branch = "main" } = {}) {
  const dir = join(tmp, `repo-${n++}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", branch);
  writeTree(dir, { "README.md": "app\n", ...committed });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  writeTree(dir, working);
  return dir;
}

// The fake runtime CLIs. Each host is a folder of `<cli>.json` files, one per
// installed CLI, giving that CLI's answer; a CLI with no file is not
// installed. The shim records every call to calls.jsonl in the host folder.
// (Windows cannot run a script shim through spawn without a shell, so the
// shims are reached through an injected spawn, behind the real allowlist.)
const SHIM = `import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [name, ...args] = process.argv.slice(2);
const dir = process.env.DEEP_SCAN_SHIM_DIR;
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify([name, ...args]) + "\\n");
const answer = JSON.parse(readFileSync(join(dir, name + ".json"), "utf8"));
const reply = answer[args.join(" ")] ?? answer["*"] ?? { status: 0, stdout: "" };
process.stdout.write(reply.stdout ?? "");
process.stderr.write(reply.stderr ?? "");
process.exit(reply.status ?? 0);
`;

const ok = (stdout = "") => ({ "*": { status: 0, stdout } });
const failing = (stderr = "boom") => ({ "*": { status: 1, stderr } });

/** `docker info --format {{json .}}` as a Docker Engine on `os` answers it. */
function docker({
  os = "Ubuntu 24.04 LTS",
  kernel = "6.8.0-45-generic",
  runtimes = { runc: { path: "runc" } },
} = {}) {
  const info = { OperatingSystem: os, KernelVersion: kernel, Runtimes: runtimes };
  return { "info --format {{json .}}": { status: 0, stdout: `${JSON.stringify(info)}\n` } };
}
const RUNC = { "io.containerd.runc.v2": { path: "runc" }, runc: { path: "runc" } };
const KATA = { kata: { path: "/opt/kata/bin/containerd-shim-kata-v2" } };
const FC = { "kata-fc": { path: "/opt/kata/bin/kata-fc" } };
const RUNSC = { runsc: { path: "/usr/local/bin/runsc" } };

/** A host: its platform and the fake CLIs installed on it. */
function makeHost(platform, clis = {}) {
  const dir = join(tmp, `host-${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "shim.mjs"), SHIM);
  writeFileSync(join(dir, "calls.jsonl"), "");
  for (const [name, answer] of Object.entries(clis)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(answer));
  }
  return { platform, dir };
}

/** Every call a host's fake CLIs recorded, as [cli, ...args]. */
function shimCalls(host) {
  return readFileSync(join(host.dir, "calls.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The spawn for a host: git for real, a fake CLI through its shim, else not found. */
function spawnFor(host, spawned) {
  return (cmd, args, opts) => {
    spawned.push([cmd, ...args]);
    if (cmd === "git") return spawnSync(cmd, args, opts);
    if (!existsSync(join(host.dir, `${cmd}.json`))) {
      return { error: Object.assign(new Error(`spawnSync ${cmd} ENOENT`), { code: "ENOENT" }) };
    }
    return spawnSync(process.execPath, [join(host.dir, "shim.mjs"), cmd, ...args], {
      ...opts,
      env: { ...opts.env, DEEP_SCAN_SHIM_DIR: host.dir },
    });
  };
}

/** A Linux host where gVisor is the only accepted runtime. */
const gvisorHost = () =>
  makeHost("linux", {
    docker: docker({ runtimes: { ...RUNC, ...RUNSC } }),
    runsc: ok("runsc version release-20251110.0\n"),
  });

/**
 * Run the CLI on a host (default: Linux with gVisor) with an environment
 * (default: none of the GitHub tokens), and record every command it runs.
 */
async function run(dir, args = [], { host = gvisorHost(), env = { PATH: "/usr/bin" } } = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const code = await main(["deep-scan", ...args], {
    cwd: dir,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    spawn: spawnFor(host, calls),
    platform: host.platform,
    env,
  });
  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    text: [...out, ...err].join("\n"),
    calls,
    gitCalls: calls.filter((c) => c[0] === "git"),
    shims: shimCalls(host),
  };
}

const recipeRepo = (text, path = ".security/scan-recipe.yml") =>
  makeRepo({ committed: { [path]: text } });

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-kit-deep-scan-test-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("no recipe", () => {
  it("refuses with a pointer to the docs and exit 1, and never falls back to full", async () => {
    const res = await run(makeRepo());
    assert.equal(res.code, 1);
    assert.match(res.text, /No Scan recipe at \.security\/scan-recipe\.yml on main/);
    assert.match(res.text, DOCS);
    assert.doesNotMatch(res.text, /\bfull\b.*instead|falling back/i);
  });
});

// A recipe built from VALID's blocks: `drop` names top-level keys to leave
// out, `add` is YAML appended at the end.
const BLOCKS = VALID.split(/\n(?=[a-z_]+:)/)
  .slice(1)
  .map((b) => [b.slice(0, b.indexOf(":")), b.trimEnd()]);
function recipe({ drop = [], add = "" } = {}) {
  const kept = BLOCKS.filter(([k]) => !drop.includes(k)).map(([, b]) => b);
  return `${[...kept, add].filter(Boolean).join("\n")}\n`;
}
const CLI_ONLY = `entry_points:
  - command: node bin/cli.js
    note: The CLI.
  - command: node bin/other.js
    note: A second command.`;

describe("a valid recipe", () => {
  it("passes, chooses a runtime, says the later stages are not built yet, and exits 0", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    assert.match(
      res.out,
      /Scan recipe \.security\/scan-recipe\.yml on main \([0-9a-f]{12}\) is valid\./,
    );
    assert.match(res.out, /not built yet/);
  });

  it("may leave out start and ready when every entry point is a command", async () => {
    const text = recipe({ drop: ["start", "ready", "entry_points"], add: CLI_ONLY });
    const res = await run(recipeRepo(text));
    assert.equal(res.code, 0, res.text);
  });

  it("may leave out seed and grounding, and write empty lists inline", async () => {
    const text = recipe({
      drop: ["seed", "grounding", "registries", "fixtures"],
      add: "registries: []\nfixtures: []",
    });
    const res = await run(recipeRepo(text));
    assert.equal(res.code, 0, res.text);
  });

  it("takes a dockerfile instead of an image", async () => {
    const text = recipe({ drop: ["image"], add: "dockerfile: docker/scan.Dockerfile" });
    const res = await run(recipeRepo(text));
    assert.equal(res.code, 0, res.text);
  });

  it("runs only read-only git commands, besides the runtime probes", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const verbs = res.gitCalls.map((c) => c[c.indexOf("-C") + 2]);
    for (const v of verbs) {
      assert.ok(["rev-parse", "symbolic-ref", "ls-tree", "cat-file"].includes(v), `ran git ${v}`);
    }
  });
});

describe("an invalid recipe is refused with a precise message", () => {
  const cases = [
    [
      "missing image and dockerfile",
      recipe({ drop: ["image"] }),
      /image or dockerfile: .*has neither/,
    ],
    [
      "both image and dockerfile",
      recipe({ add: "dockerfile: Dockerfile" }),
      /image and dockerfile: give one of them, not both/,
    ],
    ["start without ready", recipe({ drop: ["ready"] }), /start: is given without ready/],
    ["ready without start", recipe({ drop: ["start"] }), /ready: is given without start/],
    [
      "no start or ready while an entry point is a url",
      recipe({ drop: ["start", "ready"] }),
      /start and ready: are missing, and entry_points\[0\] is a url/,
    ],
    [
      "no start or ready while an entry point is a port",
      recipe({
        drop: ["start", "ready", "entry_points"],
        add: `${CLI_ONLY}\n  - port: 8080\n    note: An admin port.`,
      }),
      /start and ready: are missing, and entry_points\[2\] is a port/,
    ],
    ["a limit field", recipe({ add: "max_turns: 500" }), /max_turns: the recipe holds no limits/],
    [
      "a limits block",
      recipe({ add: "limits:\n  tokens: 9000000" }),
      /limits: the recipe holds no limits/,
    ],
    [
      "a timeout",
      recipe({ add: "setup_timeout: 90" }),
      /setup_timeout: the recipe holds no limits/,
    ],
    [
      "a compose file",
      recipe({ add: "compose: docker-compose.yml" }),
      /compose: no compose file and no sibling containers/,
    ],
    [
      "a compose file named as the dockerfile",
      recipe({ drop: ["image"], add: "dockerfile: docker-compose.yml" }),
      /dockerfile: no compose file and no sibling containers/,
    ],
    [
      "sibling containers",
      recipe({ add: "services:\n  db:\n    image: postgres:16" }),
      /services: no compose file and no sibling containers/,
    ],
    [
      "a container started by a command",
      recipe({ drop: ["start"], add: "start:\n  - docker run -d postgres:16" }),
      /start\[0\]: no compose file and no sibling containers/,
    ],
    [
      "the Docker socket",
      recipe({ drop: ["setup"], add: "setup:\n  - ln -s /var/run/docker.sock /tmp/d" }),
      /setup\[0\]: names the Docker socket/,
    ],
    [
      "a docker_socket key",
      recipe({ add: "docker_socket: true" }),
      /docker_socket: names the Docker socket/,
    ],
    [
      "an entry point without a note",
      recipe({ drop: ["entry_points"], add: "entry_points:\n  - url: http://localhost:3000/" }),
      /entry_points\[0\]: has no note/,
    ],
    [
      "an entry point with a multi-line note",
      recipe({
        drop: ["entry_points", "start", "ready"],
        add: "entry_points:\n  - command: node cli.js\n    note: |\n      one\n      two",
      }),
      /entry_points\[0\]\.note: must be one line/,
    ],
    [
      "an entry point that is no url, port or command",
      recipe({
        drop: ["entry_points"],
        add: "entry_points:\n  - host: db\n    note: The database.",
      }),
      /entry_points\[0\]: has none of url, port or command/,
    ],
    [
      "an entry point with two kinds",
      recipe({
        drop: ["entry_points"],
        add: "entry_points:\n  - url: http://localhost/\n    port: 80\n    note: Both.",
      }),
      /entry_points\[0\]: gives url and port; give exactly one/,
    ],
    [
      "a bad port",
      recipe({
        drop: ["entry_points"],
        add: "entry_points:\n  - port: 70000\n    note: Too high.",
      }),
      /entry_points\[0\]\.port: must be a port number/,
    ],
    [
      "a url that is not http",
      recipe({
        drop: ["entry_points"],
        add: "entry_points:\n  - url: file:///etc/passwd\n    note: No.",
      }),
      /entry_points\[0\]\.url: must be an http/,
    ],
    [
      "no entry points",
      recipe({ drop: ["entry_points"], add: "entry_points: []" }),
      /entry_points: is empty/,
    ],
    [
      "an unknown top-level key",
      recipe({ add: "network: host" }),
      /network: is not a Scan recipe field/,
    ],
    ["a missing setup", recipe({ drop: ["setup"] }), /setup: is missing/],
    ["a missing registries", recipe({ drop: ["registries"] }), /registries: is missing/],
    ["a missing fixtures", recipe({ drop: ["fixtures"] }), /fixtures: is missing/],
    ["a missing notes", recipe({ drop: ["notes"] }), /notes: is missing/],
    [
      "an inline list",
      recipe({ drop: ["registries"], add: "registries: [registry.npmjs.org]" }),
      /registries: write it as a block list/,
    ],
    [
      "a real credential in a fixture",
      recipe({
        drop: ["fixtures"],
        add: "fixtures:\n  - user: bot\n    token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      }),
      /fixtures\[0\]\.token: looks like a GitHub token; .*fake values only/,
    ],
    ["a key given twice", recipe({ add: "image: alpine:3" }), /image: is given more than once/],
    ["an empty file", "\n\n", /the recipe is empty/],
  ];
  for (const [name, text, message] of cases) {
    it(`refuses ${name}`, async () => {
      const res = await run(recipeRepo(text));
      assert.equal(res.code, 1, res.text);
      assert.match(
        res.err,
        /REFUSED {2}The Scan recipe \.security\/scan-recipe\.yml on main .* is invalid:/,
      );
      assert.match(res.err, message);
      assert.match(res.err, DOCS);
      assert.doesNotMatch(res.out, /is valid/);
    });
  }

  it("lists every problem at once", async () => {
    const res = await run(recipeRepo(recipe({ drop: ["image", "ready"], add: "max_turns: 9" })));
    assert.equal(res.code, 1);
    assert.match(res.err, /image or dockerfile/);
    assert.match(res.err, /start: is given without ready/);
    assert.match(res.err, /max_turns: the recipe holds no limits/);
  });
});

describe("the recipe is read at the trusted ref, never the working tree", () => {
  it("refuses a recipe that exists only in the working tree, and says to commit it", async () => {
    const dir = makeRepo({ working: { ".security/scan-recipe.yml": VALID } });
    const res = await run(dir);
    assert.equal(res.code, 1);
    assert.match(res.err, /No Scan recipe at \.security\/scan-recipe\.yml on main/);
    assert.match(res.err, /Your working tree has .*commit it there first/);
  });

  it("validates main's copy, not an edited working copy", async () => {
    const dir = makeRepo({
      committed: { ".security/scan-recipe.yml": recipe({ drop: ["image"] }) },
      working: { ".security/scan-recipe.yml": VALID },
    });
    const res = await run(dir);
    assert.equal(res.code, 1);
    assert.match(res.err, /image or dockerfile/);
    assert.match(res.err, /working copy of .* differs from main's; deep-scan used main's/);
  });

  it("reads the default branch even when another branch is checked out", async () => {
    const dir = makeRepo({ committed: { ".security/scan-recipe.yml": VALID } });
    git(dir, "switch", "-qc", "feature");
    writeTree(dir, { ".security/scan-recipe.yml": "image: x\n" });
    git(dir, "commit", "-qam", "break the recipe on a branch");
    const res = await run(dir);
    assert.equal(res.code, 0, res.text);
    assert.match(res.out, /on main/);
  });

  it("refuses when the default branch does not exist locally", async () => {
    const dir = makeRepo({ committed: { ".security/scan-recipe.yml": VALID }, branch: "trunk" });
    const res = await run(dir);
    assert.equal(res.code, 1);
    assert.match(res.err, /No local branch main \(the default branch\)/);
    assert.match(res.err, DOCS);
  });

  it("refuses outside a git repository", async () => {
    const dir = join(tmp, `plain-${n++}`);
    mkdirSync(dir);
    const res = await run(dir);
    assert.equal(res.code, 1);
    assert.match(res.err, /is not a git repository/);
  });

  it("refuses a recipe path that is a folder", async () => {
    const dir = makeRepo({ committed: { ".security/scan-recipe.yml/x": "y\n" } });
    const res = await run(dir);
    assert.equal(res.code, 1);
    assert.match(res.err, /is a folder, not a file/);
  });
});

describe("--recipe", () => {
  it("reads the recipe from another path, like the Threat pack paths", async () => {
    const dir = recipeRepo(VALID, "sec/recipe.yml");
    const res = await run(dir, ["--recipe", "sec/recipe.yml"]);
    assert.equal(res.code, 0, res.text);
    assert.match(res.out, /Scan recipe sec\/recipe\.yml on main/);
    const missing = await run(dir);
    assert.equal(missing.code, 1);
  });

  for (const bad of ["../outside.yml", "/etc/recipe.yml", ".git/config", "a b.yml"]) {
    it(`refuses the unsafe path ${JSON.stringify(bad)} as a usage error, running nothing`, async () => {
      const res = await run(makeRepo(), ["--recipe", bad]);
      assert.equal(res.code, 2);
      assert.match(res.err, /refusing --recipe/);
      assert.equal(res.calls.length, 0);
    });
  }

  it("is refused by other commands, and deep-scan takes no other option", async () => {
    const dir = makeRepo();
    const doctor = await main(["doctor", "--recipe", "x.yml"], {
      cwd: dir,
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(doctor, 2);
    const res = await run(dir, ["--tag", "v1.0.0"]);
    assert.equal(res.code, 2);
    assert.match(res.err, /deep-scan does not take --tag/);
  });
});

describe("review fixes: shapes the YAML reader would otherwise let through", () => {
  const cases = [
    [
      "a __proto__ key that hides fields from the key check",
      `__proto__:\n  image: node:22\n  max_turns: 999\n${recipe({ drop: ["image"] })}`,
      /__proto__: is not a Scan recipe field/,
    ],
    [
      "a __proto__ key inside an entry point",
      recipe({
        drop: ["entry_points", "start", "ready"],
        add: "entry_points:\n  - __proto__:\n      command: x\n    note: Sneaky.",
      }),
      /entry_points\[0\]\.__proto__: is not an entry point field/,
    ],
    [
      "a container command later in a block scalar",
      recipe({ drop: ["setup"], add: "setup: |\n  npm ci\n  docker compose up -d" }),
      /setup\[0\]: no compose file and no sibling containers/,
    ],
    [
      "a container command after &&",
      recipe({ drop: ["setup"], add: "setup:\n  - npm ci && docker run x" }),
      /setup\[0\]: no compose file and no sibling containers/,
    ],
    [
      "a container as an entry point command",
      recipe({
        drop: ["entry_points"],
        add: "entry_points:\n  - command: docker exec app sh\n    note: The app.\n  - url: http://localhost/\n    note: Web.",
      }),
      /entry_points\[0\]\.command: no compose file and no sibling containers/,
    ],
    [
      "indented lines under a single-value key",
      recipe({ drop: ["image"], add: "image: node:22\n  max_turns: 50" }),
      /line \d+: is indented under image, which holds a single value/,
    ],
    [
      "the Docker socket on a line the reader drops",
      recipe({ drop: ["image"], add: "image: node:22\n  sock: /var/run/docker.sock" }),
      /names the Docker socket/,
    ],
    [
      "a top-level line that is not a key",
      recipe({ add: "limits" }),
      /line \d+: is not a `key: value` line/,
    ],
    [
      "a quoted key with a space before its colon",
      recipe({ add: '"max_turns" : 50' }),
      /line \d+: is not a `key: value` line/,
    ],
    [
      "a key given twice, once quoted",
      recipe({ add: '"image": evil:1' }),
      /image: is given more than once/,
    ],
    ["an empty start", recipe({ drop: ["start"], add: "start: []" }), /start: is empty/],
    ["an empty ready", recipe({ drop: ["ready"], add: "ready: []" }), /ready: is empty/],
    [
      "a port with a leading zero",
      recipe({ drop: ["entry_points"], add: "entry_points:\n  - port: 08080\n    note: Zero." }),
      /entry_points\[0\]\.port: must be a port number/,
    ],
  ];
  for (const [name, text, message] of cases) {
    it(`refuses ${name}`, async () => {
      const res = await run(recipeRepo(text));
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, message);
    });
  }
});

describe("--default-branch", () => {
  it("names the trusted ref when origin's HEAD is not set and it is not main", async () => {
    const dir = makeRepo({ committed: { ".security/scan-recipe.yml": VALID }, branch: "master" });
    const refused = await run(dir);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /--default-branch/);
    const res = await run(dir, ["--default-branch", "master"]);
    assert.equal(res.code, 0, res.text);
    assert.match(res.out, /on master/);
  });

  it("refuses a branch name git would read as an option, running nothing", async () => {
    const res = await run(makeRepo(), ["--default-branch", "--output=x"]);
    assert.equal(res.code, 2);
    assert.equal(res.calls.length, 0);
  });
});

describe("the docs", () => {
  it("show an example recipe that deep-scan accepts", async () => {
    const page = readFileSync(join(import.meta.dirname, "..", "docs", "security-audit.md"), "utf8");
    const section = page.slice(page.indexOf("## Scan recipe"));
    const example = /```yaml\n([\s\S]*?)```/.exec(section);
    assert.ok(example, "docs/security-audit.md#scan-recipe has a yaml example");
    const res = await run(recipeRepo(example[1]));
    assert.equal(res.code, 0, res.text);
  });
});

// --- Sandbox runtime selection (#368) -----------------------------------

const ACCEPTED_LIST =
  /Docker Sandboxes \(sbx\).*Kata Containers or Firecracker on Linux.*gVisor \(runsc\) on Linux.*Docker Desktop on macOS/s;
const CI_PATH = /CI path: the deep-scan reusable workflow/;
const NO_OVERRIDE = /There is no override/;
const RUNTIME_DOCS = /docs\/security-audit\.md#sandbox-runtimes/;
const START_VERBS = new Set(["run", "create", "start", "exec", "rm", "kill", "pull", "build"]);

/** The fake CLIs ran only host-side probes: nothing was started. */
function assertNothingStarted(res) {
  for (const [cli, ...args] of res.shims) {
    assert.ok(!args.some((a) => START_VERBS.has(a)), `${cli} ${args.join(" ")} starts something`);
  }
}

const ALL_RUNTIMES = {
  sbx: ok("sbx version 0.7.0\n"),
  docker: docker({ runtimes: { ...RUNC, ...KATA, ...FC, ...RUNSC } }),
  "kata-runtime": ok("kata-runtime  : 3.10.1\n"),
  firecracker: ok("Firecracker v1.10.1\n"),
  runsc: ok("runsc version release-20251110.0\n"),
};
const without = (...names) =>
  Object.fromEntries(Object.entries(ALL_RUNTIMES).filter(([k]) => !names.includes(k)));

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
      "macOS with Docker Desktop only: Docker Desktop",
      "darwin",
      { docker: desktop("6.10.14-linuxkit") },
      /Docker Desktop on macOS/,
    ],
    [
      "macOS whose Docker Desktop VM has gVisor: Docker Desktop, gVisor being Linux-only",
      "darwin",
      {
        docker: docker({ os: "Docker Desktop", runtimes: { ...RUNC, ...RUNSC } }),
        runsc: ALL_RUNTIMES.runsc,
      },
      /Docker Desktop on macOS/,
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
      assert.equal(res.code, 0, res.text);
      const line = res.out.split("\n").find((l) => l.startsWith("Sandbox runtime: "));
      assert.ok(line, res.out);
      assert.match(line, chosen);
      assert.match(res.out, /not built yet/);
      assertNothingStarted(res);
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
    assert.ok(res.shims.length > 0);
    for (const [cli, ...args] of res.shims) {
      const probe =
        (cli === "docker" && args.join(" ") === "info --format {{json .}}") ||
        (cli === "sbx" && args.join(" ") === "version") ||
        args.join(" ") === "--version";
      assert.ok(probe, `${cli} ${args.join(" ")} is not a host-side probe`);
    }
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

// --- Pre-flight refusals (#368) --------------------------------------------

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
    const res = await run(recipeRepo(VALID), [], { env: { PATH: "/usr/bin", GH_TOKEN: "" } });
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

// --- The process allowlist (ADR 0019) --------------------------------------

describe("the process allowlist widens for deep-scan alone", () => {
  const recordingSpawn = (seen) => (cmd, args) => {
    seen.push([cmd, ...args]);
    return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
  };

  it("lets deep-scan run git and every runtime CLI, and nothing else", () => {
    assert.deepEqual([...allowedCommands("deep-scan")].sort(), ["git", ...RUNTIME_CLIS].sort());
    const seen = [];
    const runner = runnerFor("deep-scan", { spawn: recordingSpawn(seen) });
    for (const cli of ["git", ...RUNTIME_CLIS]) runner(cli, ["--version"]);
    assert.deepEqual(
      seen.map((c) => c[0]),
      ["git", ...RUNTIME_CLIS],
    );
    for (const cli of ["gh", "op", "sh", "bash", "node", "cmd.exe", "powershell", "podman"]) {
      assert.throws(() => runner(cli, []), /refusing to run .*: deep-scan may run only/);
    }
    assert.equal(seen.length, 1 + RUNTIME_CLIS.length);
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
