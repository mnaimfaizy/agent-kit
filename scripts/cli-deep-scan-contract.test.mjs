// Contract for `agent-kit deep-scan` (cli/): finding the Consumer's Scan
// recipe at the trusted ref (the default branch's tip, never the working
// tree), validating it, and refusing with a pointer to the docs when it is
// missing or invalid. git runs for real against local fixture repositories
// (no network); no other command is ever run.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { main } from "../cli/src/cli.mjs";
import { systemRunner } from "../cli/src/exec.mjs";

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

/** Run the CLI and record every command it runs. */
async function run(dir, args = []) {
  const out = [];
  const err = [];
  const calls = [];
  const runner = (cmd, a, opts) => {
    calls.push([cmd, ...a]);
    assert.equal(cmd, "git", `deep-scan ran ${cmd}`);
    return systemRunner(cmd, a, opts);
  };
  const code = await main(["deep-scan", ...args], {
    cwd: dir,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    runner,
  });
  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    text: [...out, ...err].join("\n"),
    calls,
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
  it("passes, says the later stages are not built yet, and exits 0", async () => {
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

  it("runs only git, and only read-only git commands", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const verbs = res.calls.map((c) => c[c.indexOf("-C") + 2]);
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
