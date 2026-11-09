// Contract for `agent-kit init` (cli/): Kit-owned paths copied from the tag,
// a Caller per flow from the tag's examples/ with every placeholder filled
// in, the Threat pack skeleton, .github/dependabot.yml only when there is
// none, refusals before anything is written, and the GitHub-side steps
// printed as commands. git runs for real against local fixture repositories
// (no network); no test reaches GitHub.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findKitPins, parseCaller } from "../cli/src/callers.mjs";
import { main } from "../cli/src/cli.mjs";
import { systemRunner } from "../cli/src/exec.mjs";
import { DEPENDABOT_BLOCK, manualSteps, parseAnswer } from "../cli/src/init.mjs";
import { openKitTag } from "../cli/src/kit-tag.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (p) => readFileSync(join(repoRoot, p), "utf8");
const KIT = "mnaimfaizy/agent-kit";
const PRE = "v1.0.0-alpha.10";
const NO_PACK = "v1.0.0-alpha.12";
const TAG = "v1.0.0-alpha.13";
const BROKEN = "v1.0.0-alpha.20";
const GIT_ID = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@example.com",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
  "-c",
  "core.autocrlf=false",
];

function git(cwd, ...args) {
  const r = systemRunner("git", ["-C", cwd, ...GIT_ID, ...args]);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function writeTree(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function snapshot(dir) {
  const out = {};
  const walk = (sub) => {
    for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (rel === ".git") continue;
      if (e.isDirectory()) walk(rel);
      else out[rel] = e.isFile() ? readFileSync(join(dir, rel)).toString("hex") : "(link)";
    }
  };
  walk("");
  return out;
}

const examples = Object.fromEntries(
  [
    "examples/plan-implement-review-caller.yml",
    "examples/security-audit-caller.yml",
    ...readdirSync(join(repoRoot, "examples/setup-presets")).map(
      (f) => `examples/setup-presets/${f}`,
    ),
  ].map((p) => [p, readRepo(p)]),
);
const threatPack = {
  "examples/threat-pack/threat-model.md": readRepo("examples/threat-pack/threat-model.md"),
  "examples/threat-pack/findings-ledger.md": readRepo("examples/threat-pack/findings-ledger.md"),
};
const KIT_FILES = {
  "kit-owned-paths.txt": "# manifest\n.claude/skills/code-review/\n.github/agent-runtime/\n",
  ".claude/skills/code-review/SKILL.md": "# code review\n",
  ".github/agent-runtime/hook.mjs": "export const x = 1;\n",
};

let tmp;
let kitUrl;
const openTag = (opts) => openKitTag({ ...opts, remoteUrl: kitUrl });

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-kit-init-test-"));
  const kit = join(tmp, "kit");
  mkdirSync(kit);
  git(kit, "init", "-q");
  writeTree(kit, { "README.md": "pre\n", ...examples });
  git(kit, "add", "-A");
  git(kit, "commit", "-qm", "pre");
  git(kit, "tag", "-a", PRE, "-m", PRE);
  writeTree(kit, KIT_FILES);
  git(kit, "add", "-A");
  git(kit, "commit", "-qm", "no threat pack");
  git(kit, "tag", "-a", NO_PACK, "-m", NO_PACK);
  writeTree(kit, threatPack);
  git(kit, "add", "-A");
  git(kit, "commit", "-qm", "threat pack");
  git(kit, "tag", "-a", TAG, "-m", TAG);
  writeTree(kit, {
    "examples/security-audit-caller.yml": examples["examples/security-audit-caller.yml"].replace(
      "your-github-login",
      "someone",
    ),
  });
  git(kit, "add", "-A");
  git(kit, "commit", "-qm", "broken example");
  git(kit, "tag", "-a", BROKEN, "-m", BROKEN);
  kitUrl = pathToFileURL(kit).href;
});
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function makeConsumer(files = {}) {
  const dir = join(tmp, `consumer-${++n}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "trunk");
  writeTree(dir, { "README.md": "app\n", ...files });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "app");
  return dir;
}

const FULL_VERIFY = "set -e\nnpm test";
const FULL = [
  "--tag",
  TAG,
  "--flows",
  "pipeline,audit",
  "--actors",
  "alice,bob",
  "--verify",
  FULL_VERIFY,
  "--preset",
  "node",
  "--yes",
];

async function init(dir, args = FULL, extra = {}) {
  const out = [];
  const code = await main(["init", ...args], {
    cwd: dir,
    stdout: (s) => out.push(s),
    stderr: (s) => out.push(s),
    runner: systemRunner,
    openTag,
    ...extra,
  });
  return { code, text: out.join("\n") };
}

const read = (dir, p) => readFileSync(join(dir, p), "utf8");

describe("init: both flows from flags", () => {
  let dir;
  let res;
  before(async () => {
    dir = makeConsumer();
    res = await init(dir, [...FULL, "--default-branch", "trunk"]);
  });

  it("exits 0 and doctor's file and pin checks pass", () => {
    assert.equal(res.code, 0, res.text);
    assert.match(
      res.text,
      /PASS {2}uses: pins agree: 4 pins use mnaimfaizy\/agent-kit@v1\.0\.0-alpha\.13/,
    );
    assert.match(res.text, /PASS {2}Kit-owned paths match the pinned tag/);
  });

  it("copies the Kit-owned paths from the tag", () => {
    assert.equal(read(dir, ".claude/skills/code-review/SKILL.md"), "# code review\n");
    assert.equal(read(dir, ".github/agent-runtime/hook.mjs"), "export const x = 1;\n");
  });

  it("writes the pipeline Caller with every placeholder filled in", () => {
    const text = read(dir, ".github/workflows/agent-pipeline.yml");
    assert.match(text, /^name: agent-pipeline$/m);
    assert.doesNotMatch(text, /your-github-login|Provide Consumer verify|"main"/);
    // Three allowlists, plus the commented trusted_spec_authors example.
    assert.equal((text.match(/'\["alice","bob"\]'/g) ?? []).length, 4);
    assert.match(text, /# trusted_spec_authors: '\["alice","bob"\]'/);
    assert.ok(findKitPins(text).every((p) => p.ref === TAG));
    assert.match(text, /default: "trunk"/);
    assert.match(text, /base_branch: "trunk"/);
    assert.match(text, /\n {8}set -e\n {8}set -e\n {8}npm test\n/);
    assert.match(text, /\n {6}setup_commands: \|\n {8}#!\/usr\/bin\/env bash\n/);
    assert.ok(text.includes(examples["examples/setup-presets/node.sh"].split("\n")[1]));
    assert.equal(parseCaller(text).jobs.length, 3);
  });

  it("writes the audit Caller pointing at the Threat pack", () => {
    const text = read(dir, ".github/workflows/security-audit.yml");
    assert.match(text, /^name: security-audit$/m);
    assert.match(text, /allowlist_actors: '\["alice","bob"\]'/);
    assert.match(text, /threat_model_path: "\.security\/threat-model\.md"/);
    assert.ok(findKitPins(text).every((p) => p.ref === TAG));
  });

  it("writes the Threat pack skeleton and dependabot.yml", () => {
    assert.equal(
      read(dir, ".security/threat-model.md"),
      threatPack["examples/threat-pack/threat-model.md"],
    );
    assert.equal(
      read(dir, ".security/findings-ledger.md"),
      threatPack["examples/threat-pack/findings-ledger.md"],
    );
    assert.equal(read(dir, ".github/dependabot.yml"), DEPENDABOT_BLOCK);
  });

  it("prints the GitHub-side steps as commands, and runs none of them", () => {
    for (const line of [
      "$ gh secret set CLAUDE_CODE_OAUTH_TOKEN",
      "$ gh secret set AGENT_KIT_ADVISORIES_TOKEN",
      "$ gh label create agent:plan --color 1D76DB --description 'Agent-kit: plan this issue'",
      "$ gh api 'repos/{owner}/{repo}/rulesets'",
      "$ gh variable set CLAUDE_PIPELINE_ENABLED --body true",
      "$ gh variable set CLAUDE_SECURITY_AUDIT_ENABLED --body true",
    ]) {
      assert.ok(res.text.includes(line), line);
    }
    assert.match(res.text, /blob\/v1\.0\.0-alpha\.13\/docs\/repository-hardening\.md/);
  });

  it("commits nothing", () => {
    assert.equal(git(dir, "rev-list", "--count", "HEAD"), "1");
  });
});

describe("init: choices", () => {
  it("fills placeholders from the original text: an actor called main stays main", async () => {
    const dir = makeConsumer();
    const res = await init(dir, [
      "--tag",
      TAG,
      "--flows",
      "pipeline",
      "--actors",
      "main",
      "--verify",
      "make test",
      "--default-branch",
      "develop",
      "--yes",
    ]);
    assert.equal(res.code, 0, res.text);
    const text = read(dir, ".github/workflows/agent-pipeline.yml");
    assert.equal((text.match(/'\["main"\]'/g) ?? []).length, 4);
    assert.match(text, /base_branch: "develop"/);
  });

  it("notes a bot login in the Allowlist", async () => {
    const res = await init(
      makeConsumer(),
      FULL.map((a) => (a === "alice,bob" ? "alice,renovate[bot]" : a)),
    );
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /Allowlist includes renovate\[bot\]/);
  });

  it("--threat-pack-dir moves the Threat pack and both audit Caller inputs", async () => {
    const dir = makeConsumer();
    const res = await init(dir, [
      "--tag",
      TAG,
      "--flows",
      "audit",
      "--actors",
      "alice",
      "--threat-pack-dir",
      "docs/security/",
      "--yes",
    ]);
    assert.equal(res.code, 0, res.text);
    const text = read(dir, ".github/workflows/security-audit.yml");
    assert.match(text, /threat_model_path: "docs\/security\/threat-model\.md"/);
    assert.match(text, /findings_ledger_path: "docs\/security\/findings-ledger\.md"/);
    assert.ok(existsSync(join(dir, "docs/security/findings-ledger.md")));
    assert.equal(existsSync(join(dir, ".security")), false);
    assert.equal(existsSync(join(dir, ".github/workflows/agent-pipeline.yml")), false);
    assert.doesNotMatch(res.text, /gh label create|CLAUDE_PIPELINE_ENABLED/);
  });

  it("--preset none leaves the commented setup_commands block", async () => {
    const dir = makeConsumer();
    const res = await init(dir, [
      "--tag",
      TAG,
      "--flows",
      "pipeline",
      "--actors",
      "alice",
      "--verify",
      "make test",
      "--preset",
      "none",
      "--yes",
    ]);
    assert.equal(res.code, 0, res.text);
    const text = read(dir, ".github/workflows/agent-pipeline.yml");
    assert.match(text, /# setup_commands: \|/);
    assert.match(text, /\n {8}make test\n/);
    assert.equal(existsSync(join(dir, ".security")), false);
  });

  it("leaves an existing dependabot.yml alone and prints the block to merge", async () => {
    for (const name of ["dependabot.yml", "dependabot.yaml"]) {
      const dir = makeConsumer({ [`.github/${name}`]: "version: 2\nupdates: []\n" });
      const res = await init(dir);
      assert.equal(res.code, 0, res.text);
      assert.equal(read(dir, `.github/${name}`), "version: 2\nupdates: []\n");
      assert.match(res.text, /already exists, so init left it alone/);
      assert.match(res.text, /package-ecosystem: github-actions/);
    }
  });

  it("notes a tag with no Threat pack skeleton and writes the rest", async () => {
    const dir = makeConsumer();
    const res = await init(dir, ["--tag", NO_PACK, ...FULL.slice(2)]);
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /has no examples\/threat-pack\//);
    assert.equal(existsSync(join(dir, ".security")), false);
    assert.ok(existsSync(join(dir, ".github/workflows/security-audit.yml")));
  });

  it("asks for what is missing on a terminal, then for confirmation", async () => {
    const dir = makeConsumer();
    const asked = [];
    const answers = [TAG, "pipeline", "carol", "", "npm test", "python", "y"];
    const prompt = async (q) => (asked.push(q), answers.shift());
    const res = await init(dir, [], { prompt });
    assert.equal(res.code, 0, res.text);
    assert.equal(asked.length, 7);
    // No origin/HEAD here: main, never the current branch (trunk).
    assert.match(asked[3], /Default branch \[main\]/);
    assert.match(read(dir, ".github/workflows/agent-pipeline.yml"), /base_branch: "main"/);
    assert.match(read(dir, ".github/workflows/agent-pipeline.yml"), /PYTHON_VERSION=/);
  });

  it("takes the default branch from origin's HEAD, and says which it used", async () => {
    const dir = makeConsumer();
    git(dir, "update-ref", "refs/remotes/origin/develop", "HEAD");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    const res = await init(dir);
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /Default branch in the Callers: develop/);
    assert.match(read(dir, ".github/workflows/agent-pipeline.yml"), /base_branch: "develop"/);
  });

  it("an empty answer to a required question stops with that question", async () => {
    const dir = makeConsumer();
    const before = snapshot(dir);
    const answers = [TAG, ""];
    const asked = [];
    const res = await init(dir, [], { prompt: async (q) => (asked.push(q), answers.shift()) });
    assert.equal(res.code, 2, res.text);
    assert.match(res.text, /Flows to set up .* is required \(--flows/);
    assert.doesNotMatch(res.text, /no terminal/);
    assert.equal(asked.length, 2);
    assert.deepEqual(snapshot(dir), before);
  });

  it("--force lists the uncommitted changes it discards in Kit-owned paths", async () => {
    const dir = makeConsumer({ ".github/agent-runtime/hook.mjs": "old\n" });
    writeFileSync(join(dir, ".github/agent-runtime/hook.mjs"), "local edit\n");
    const res = await init(dir, [...FULL, "--force"]);
    assert.equal(res.code, 0, res.text);
    assert.match(
      res.text,
      /--force: discarding uncommitted changes in 1 file[^\n]*\n {2}M \.github\/agent-runtime\/hook\.mjs/,
    );
  });

  it("a Threat pack folder may be a parent of a Kit-owned path", async () => {
    const dir = makeConsumer();
    const res = await init(dir, [...FULL, "--threat-pack-dir", ".github"]);
    assert.equal(res.code, 0, res.text);
    assert.ok(existsSync(join(dir, ".github/threat-model.md")));
  });

  it("a no at the confirmation writes nothing", async () => {
    const dir = makeConsumer();
    const before = snapshot(dir);
    const res = await init(
      dir,
      FULL.filter((a) => a !== "--yes"),
      { prompt: async () => "n" },
    );
    assert.equal(res.code, 1, res.text);
    assert.deepEqual(snapshot(dir), before);
  });
});

describe("init: refusals change nothing", () => {
  const refused = async (dir, args, pattern) => {
    const before = snapshot(dir);
    const res = await init(dir, args);
    assert.equal(res.code, 1, res.text);
    assert.match(res.text, /REFUSED/);
    assert.match(res.text, pattern);
    assert.deepEqual(snapshot(dir), before);
    return res;
  };

  for (const [what, files] of [
    ["a Caller", { ".github/workflows/agent-pipeline.yml": "name: mine\n" }],
    ["a Threat pack file", { ".security/threat-model.md": "# mine\n" }],
    ["a Kit-owned path", { ".github/agent-runtime/hook.mjs": "old\n" }],
  ]) {
    it(`refuses to overwrite ${what} and points to upgrade; --force overwrites`, async () => {
      const dir = makeConsumer(files);
      const res = await refused(
        dir,
        FULL,
        /already exist.*upgrade --tag v1\.0\.0-alpha\.13.*--force/s,
      );
      // A Kit-owned path is named as its folder; the other paths as files.
      const shown = Object.keys(files)[0].replace(/^(\.github\/agent-runtime\/).*/, "$1");
      assert.ok(res.text.includes(`      ${shown} (`), shown);
      const forced = await init(dir, [...FULL, "--force"]);
      assert.equal(forced.code, 0, forced.text);
      assert.notEqual(read(dir, Object.keys(files)[0]), Object.values(files)[0]);
    });
  }

  it("refuses a tag without kit-owned-paths.txt", async () => {
    await refused(makeConsumer(), ["--tag", PRE, ...FULL.slice(2)], /has no kit-owned-paths\.txt/);
  });

  it("fails loudly when the tag's example does not have the expected placeholders", async () => {
    await refused(
      makeConsumer(),
      ["--tag", BROKEN, ...FULL.slice(2)],
      /security-audit-caller\.yml does not have the placeholders.*your-github-login: expected 1, found 0/,
    );
  });

  it("refuses an unknown preset and names the ones the tag has", async () => {
    const args = FULL.map((a) => (a === "node" ? "ruby" : a));
    await refused(makeConsumer(), args, /no setup preset "ruby"; it has: .*node.*python/);
  });

  it("refuses to write through a linked .github folder", async (t) => {
    const outside = join(tmp, `outside-${n}`);
    mkdirSync(outside);
    const dir = makeConsumer();
    try {
      symlinkSync(outside, join(dir, ".github"), "junction");
    } catch {
      return t.skip("no links");
    }
    await refused(dir, [...FULL, "--force"], /\.github is a symbolic link or junction/);
    assert.deepEqual(readdirSync(outside), []);
  });

  it("refuses a folder where a Caller or Threat pack file goes, even with --force", async () => {
    for (const path of [".github/workflows/agent-pipeline.yml", ".security/findings-ledger.md"]) {
      const dir = makeConsumer({ [`${path}/keep.txt`]: "mine\n" });
      await refused(dir, [...FULL, "--force"], /exists and is not a file/);
    }
  });

  it("refuses a Threat pack folder that would clash with a planned file, before writing", async () => {
    await refused(
      makeConsumer(),
      [...FULL, "--threat-pack-dir", ".github/dependabot.yml"],
      /\.github\/dependabot\.yml would be both a file and a folder/,
    );
  });

  it("compares the Threat pack folder with Kit-owned paths ignoring case", async () => {
    await refused(
      makeConsumer(),
      [...FULL, "--threat-pack-dir", ".GitHub/Agent-Runtime/sec"],
      /overlaps the Kit-owned path/,
    );
  });

  it("refuses a Threat pack folder inside a Kit-owned path", async () => {
    await refused(
      makeConsumer(),
      [...FULL, "--threat-pack-dir", ".github/agent-runtime/sec"],
      /overlaps the Kit-owned path/,
    );
  });
});

describe("init: answers and flags", () => {
  it("with no terminal, names every missing flag and --yes, and writes nothing", async () => {
    const dir = makeConsumer();
    const before = snapshot(dir);
    const res = await init(dir, ["--flows", "pipeline"]);
    assert.equal(res.code, 2, res.text);
    assert.match(
      res.text,
      /pass --tag <vX> and --actors <login,...> and --verify <commands> and --yes/,
    );
    assert.deepEqual(snapshot(dir), before);
  });

  it("--yes on a terminal still asks nothing", async () => {
    const res = await init(makeConsumer(), ["--yes"], {
      prompt: async () => assert.fail("asked a question under --yes"),
    });
    assert.equal(res.code, 2, res.text);
    assert.match(res.text, /--yes asks nothing/);
  });

  it("rejects answers that would not be safe in a Caller", async () => {
    for (const [flag, value] of [
      ["--actors", 'alice","evil'],
      ["--actors", "-alice"],
      ["--flows", "pipeline,nope"],
      ["--default-branch", "../x"],
      ["--default-branch", "-x"],
      ["--verify", "npm test\u0007"],
      ["--preset", "../node"],
      ["--threat-pack-dir", "../out"],
      ["--threat-pack-dir", ".git/x"],
      ["--threat-pack-dir", ".github/workflows"],
      ["--threat-pack-dir", ".GitHub/Workflows/x"],
      ["--verify", "echo ${{ github.event.issue.title }}"],
      ["--tag", "main"],
    ]) {
      const args = [...FULL];
      const i = args.indexOf(flag);
      if (i >= 0) args[i + 1] = value;
      else args.push(flag, value);
      const res = await init(makeConsumer(), args);
      assert.equal(res.code, 2, `${flag} ${value}: ${res.text}`);
    }
  });

  it("parseAnswer accepts bot logins and multi-line verify text", () => {
    assert.deepEqual(parseAnswer("actors", "alice dependabot[bot]").value, [
      "alice",
      "dependabot[bot]",
    ]);
    // \n separates commands only in a prompted answer; a flag keeps it.
    assert.equal(parseAnswer("verify", "a\r\nb\\nc\n", { prompted: true }).value, "a\nb\nc");
    assert.equal(parseAnswer("verify", "printf 'a\\nb'").value, "printf 'a\\nb'");
    assert.equal(parseAnswer("preset", "none").value, null);
    assert.equal(parseAnswer("defaultBranch", "release/v1").value, "release/v1");
  });

  it("manualSteps quotes every argument it prints", () => {
    const lines = manualSteps({
      flows: ["pipeline"],
      tag: TAG,
      kitRepo: KIT,
      serverUrl: "https://github.com",
    });
    assert.ok(lines.some((l) => l.includes("--description 'Agent-kit: review this PR'")));
    assert.ok(!lines.some((l) => /AGENT_KIT_ADVISORIES_TOKEN|SECURITY_AUDIT/.test(l)));
  });
});
