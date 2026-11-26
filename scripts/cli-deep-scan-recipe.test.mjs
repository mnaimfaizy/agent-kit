// Contract for `agent-kit deep-scan` (cli/): finding the Scan recipe at the trusted ref, validating it, and its refusals.
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { main } from "../cli/src/cli.mjs";
import {
  git,
  writeTree,
  DOCS,
  VALID,
  tmp,
  n,
  nextId,
  makeRepo,
  NO_REGISTRIES,
  run,
  recipeRepo,
  recipe,
  CLI_ONLY,
  without,
  gvisorWith,
} from "./cli-deep-scan-fixtures.mjs";

describe("no recipe", () => {
  it("refuses with a pointer to the docs and exit 1, and never falls back to full", async () => {
    const res = await run(makeRepo());
    assert.equal(res.code, 1);
    assert.match(res.text, /No Scan recipe at \.security\/scan-recipe\.yml on main/);
    assert.match(res.text, DOCS);
    assert.doesNotMatch(res.text, /\bfull\b.*instead|falling back/i);
  });
});

describe("a valid recipe", () => {
  it("passes, chooses a runtime, runs the sandbox and exits 0", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    assert.match(
      res.out,
      /Scan recipe \.security\/scan-recipe\.yml on main \([0-9a-f]{12}\) is valid\./,
    );
    assert.match(res.out, /Report: .*report\.md/);
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
    const res = await run(recipeRepo(text), [], { host: gvisorWith(NO_REGISTRIES) });
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
      assert.ok(
        ["rev-parse", "symbolic-ref", "ls-tree", "cat-file", "archive"].includes(v),
        `ran git ${v}`,
      );
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
    const dir = join(tmp, `plain-${nextId()}`);
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
      "a line in a list that is not a `- ` item, which would cut the list short",
      recipe({
        drop: ["setup"],
        add: "setup:\n  - npm ci\n  -npm run build\n  - npm run seed:db",
      }),
      /line \d+: sits in a list but is not a `- ` item/,
    ],
    [
      "a list item indented less than the list's first item",
      recipe({
        drop: ["setup"],
        add: "setup:\n    - npm ci\n  - npm run build",
      }),
      /line \d+: is indented less than the list above it/,
    ],
    [
      "a deeper line after a blank line under a list item",
      recipe({
        drop: ["setup"],
        add: "setup:\n  - npm ci\n\n      --flag",
      }),
      /line \d+: sits deeper than the list item above it, after a blank line/,
    ],
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
