// Contract for `agent-kit upgrade` (cli/): Kit-owned paths replaced whole
// from the new tag, paths only the old tag listed deleted, `uses:` pins
// rewritten byte for byte, the examples/ diff printed, doctor's file and pin
// checks run afterwards, and every refusal checked before anything on disk
// changes. git runs for real against local fixture repositories (no
// network); no test reaches GitHub.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { findKitPins, rewriteKitPins } from "../cli/src/callers.mjs";
import { sanitizeLine } from "../cli/src/checks/result.mjs";
import { main } from "../cli/src/cli.mjs";
import { systemRunner } from "../cli/src/exec.mjs";
import { openKitRepo, openKitTag } from "../cli/src/kit-tag.mjs";
import { caseCollisions, checkSafePath, fileDirConflicts } from "../cli/src/safe-paths.mjs";

const KIT = "mnaimfaizy/agent-kit";
const PRE = "v1.0.0-alpha.10"; // no kit-owned-paths.txt
const FROM = "v1.0.0-alpha.11";
const TO = "v1.0.0-alpha.12";
const BAD = {
  symlink: "v1.0.0-alpha.20",
  submodule: "v1.0.0-alpha.21",
  caseCollision: "v1.0.0-alpha.22",
  ghost: "v1.0.0-alpha.23",
  badManifest: "v1.0.0-alpha.24",
  fileDir: "v1.0.0-alpha.25",
};
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

/** Every file under `dir` except .git, as path → bytes (hex), to prove nothing changed. */
function snapshot(dir) {
  const out = {};
  const walk = (sub) => {
    for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (rel === ".git") continue;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile()) out[rel] = readFileSync(join(dir, rel)).toString("hex");
      else out[rel] = "(link)";
    }
  };
  walk("");
  return out;
}

const BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0d, 0x0a, 0xc3, 0x28, 0x0a]);

const FROM_FILES = {
  "kit-owned-paths.txt":
    "# manifest\n.claude/skills/code-review/\n.claude/skills/old-skill/\n.github/agent-runtime/\n",
  ".claude/skills/code-review/SKILL.md": "# code review v11\n",
  ".claude/skills/code-review/notes/a.md": "removed in v12\n",
  ".claude/skills/old-skill/SKILL.md": "# dropped in v12\n",
  ".github/agent-runtime/hook.mjs": "export const v = 11;\n",
  "examples/caller.yml": "name: caller\n# setting: old\n",
};
const TO_FILES = {
  "kit-owned-paths.txt":
    "# manifest\n.claude/skills/code-review/\n.claude/skills/new-skill/\n.github/agent-runtime/\n",
  ".claude/skills/code-review/SKILL.md": "# code review v12\n",
  ".claude/skills/new-skill/SKILL.md": "# added in v12\n",
  ".github/agent-runtime/hook.mjs": "export const v = 12;\n",
  ".github/agent-runtime/bin.dat": BINARY,
  ".github/agent-runtime/run.sh": "#!/bin/sh\necho hi\n",
  "examples/caller.yml": "name: caller\n# setting: new\n",
};
const KIT_PATHS_OF = (files) =>
  Object.fromEntries(
    Object.entries(files).filter(([p]) => p.startsWith(".claude/") || p.startsWith(".github/")),
  );

let tmp;
let kitUrl;
const openRepo = (opts) => openKitRepo({ ...opts, remoteUrl: kitUrl });

/** Commit `edit(index)` on top of `base` with a temporary index, and tag it. No checkout. */
function plumbTag(kit, base, tag, edit) {
  const env = { GIT_INDEX_FILE: join(tmp, `index-${tag}`) };
  const run = (...args) => {
    const r = systemRunner("git", ["-C", kit, ...GIT_ID, ...args], { env });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  run("read-tree", base);
  const blob = (text) => {
    const file = join(tmp, `blob-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, text);
    return run("hash-object", "-w", "--", file);
  };
  edit({ run, blob });
  const tree = run("write-tree");
  const commit = run("commit-tree", tree, "-p", `${base}^{commit}`, "-m", tag);
  run("tag", "-a", tag, "-m", tag, commit);
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-kit-upgrade-test-"));
  const kit = join(tmp, "kit");
  mkdirSync(kit);
  git(kit, "init", "-q");
  writeTree(kit, { "README.md": "pre-manifest\n", "examples/caller.yml": "name: caller\n" });
  git(kit, "add", "-A");
  git(kit, "commit", "-qm", "pre");
  git(kit, "tag", "-a", PRE, "-m", PRE);

  writeTree(kit, FROM_FILES);
  git(kit, "add", "-A");
  git(kit, "commit", "-qm", "v11");
  git(kit, "tag", "-a", FROM, "-m", FROM);

  rmSync(join(kit, ".claude"), { recursive: true });
  rmSync(join(kit, ".github"), { recursive: true });
  writeTree(kit, TO_FILES);
  git(kit, "add", "-A");
  git(kit, "update-index", "--chmod=+x", ".github/agent-runtime/run.sh");
  git(kit, "commit", "-qm", "v12");
  git(kit, "tag", "-a", TO, "-m", TO);

  const add = (run, mode, sha, path) =>
    run("update-index", "--add", "--cacheinfo", `${mode},${sha},${path}`);
  plumbTag(kit, TO, BAD.symlink, ({ run, blob }) =>
    add(run, "120000", blob("../../etc/passwd"), ".github/agent-runtime/link"),
  );
  plumbTag(kit, TO, BAD.submodule, ({ run }) =>
    add(run, "160000", git(kit, "rev-parse", `${TO}^{commit}`), ".github/agent-runtime/sub"),
  );
  plumbTag(kit, TO, BAD.caseCollision, ({ run, blob }) => {
    add(run, "100644", blob("upper\n"), ".github/agent-runtime/README.md");
    add(run, "100644", blob("lower\n"), ".github/agent-runtime/readme.md");
  });
  plumbTag(kit, TO, BAD.ghost, ({ run, blob }) =>
    add(
      run,
      "100644",
      blob(`${TO_FILES["kit-owned-paths.txt"]}.claude/skills/ghost/\n`),
      "kit-owned-paths.txt",
    ),
  );
  plumbTag(kit, TO, BAD.badManifest, ({ run, blob }) =>
    add(run, "100644", blob(".github/agent-runtime/\ndocs/\n"), "kit-owned-paths.txt"),
  );
  plumbTag(kit, TO, BAD.fileDir, ({ run, blob }) => {
    // `x` is a file at the tag and `X/y` a file in a folder: the same name on Windows and macOS.
    add(run, "100644", blob("file\n"), ".github/agent-runtime/x");
    add(run, "100644", blob("nested\n"), ".github/agent-runtime/X/y");
  });
  kitUrl = pathToFileURL(kit).href;
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const callerYml = (tag) => `name: caller
on:
  issues:
    types: [labeled]
jobs:
  plan:
    uses: ${KIT}/.github/workflows/agent-plan-reusable.yml@${tag} # pinned
    with:
      trigger_label: "agent:plan"
`;

// CRLF, a byte-order mark, a quoted pin, a list-item pin, a non-kit action
// with the same ref, and the pin text inside a run: script (not a pin).
const otherYml = (tag) =>
  "\ufeff" +
  [
    "name: other",
    "on: push",
    "jobs:",
    "  audit:",
    `    "uses": "${KIT}/.github/workflows/security-audit-reusable.yml@${tag}"`,
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: actions/checkout@${tag}`,
    "      - run: |",
    `          echo ${KIT}/.github/workflows/agent-plan-reusable.yml@${tag}`,
    "",
  ].join("\r\n");

let consumers = 0;
function makeConsumer({ tag = FROM, files = {}, kitFiles = KIT_PATHS_OF(FROM_FILES) } = {}) {
  const dir = join(tmp, `consumer-${++consumers}`);
  mkdirSync(dir);
  git(dir, "init", "-q");
  writeTree(dir, {
    ...kitFiles,
    ".claude/skills/mine/SKILL.md": "# my own skill\n",
    ".github/workflows/caller.yml": callerYml(tag),
    ".github/workflows/other.yml": otherYml(tag),
    ...files,
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "adopt");
  return dir;
}

async function upgrade(dir, args = ["--tag", TO, "--yes"], extra = {}) {
  const out = [];
  const code = await main(["upgrade", ...args], {
    cwd: dir,
    stdout: (s) => out.push(s),
    stderr: (s) => out.push(s),
    runner: systemRunner,
    openRepo,
    ...extra,
  });
  return { code, text: out.join("\n") };
}

const read = (dir, p) => readFileSync(join(dir, p), "utf8");

describe("upgrade: the happy path", () => {
  let dir;
  let res;
  before(async () => {
    dir = makeConsumer();
    res = await upgrade(dir);
  });

  it("exits 0 and reports doctor's file and pin checks as passing", () => {
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /PASS {2}uses: pins agree: 2 pins use .*@v1\.0\.0-alpha\.12/);
    assert.match(res.text, /PASS {2}Kit-owned paths match the pinned tag/);
  });

  it("replaces each Kit-owned path whole, so files the new tag dropped are gone", () => {
    assert.equal(read(dir, ".claude/skills/code-review/SKILL.md"), "# code review v12\n");
    assert.equal(existsSync(join(dir, ".claude/skills/code-review/notes")), false);
    assert.equal(read(dir, ".github/agent-runtime/hook.mjs"), "export const v = 12;\n");
    assert.equal(read(dir, ".claude/skills/new-skill/SKILL.md"), "# added in v12\n");
  });

  it("deletes a path only the old tag listed, and leaves the Consumer's own skill alone", () => {
    assert.equal(existsSync(join(dir, ".claude/skills/old-skill")), false);
    assert.match(res.text, /Delete \(no longer in .*\):\n {2}\.claude\/skills\/old-skill\//);
    assert.equal(read(dir, ".claude/skills/mine/SKILL.md"), "# my own skill\n");
  });

  it("copies a file that is not UTF-8 byte for byte", () => {
    assert.deepEqual(readFileSync(join(dir, ".github/agent-runtime/bin.dat")), BINARY);
  });

  it("keeps the executable bit", { skip: process.platform === "win32" }, () => {
    assert.ok(statSync(join(dir, ".github/agent-runtime/run.sh")).mode & 0o100);
    assert.equal(statSync(join(dir, ".github/agent-runtime/hook.mjs")).mode & 0o111, 0);
  });

  it("stages the executable bit where git cannot see it (core.fileMode off)", async () => {
    const d = makeConsumer();
    git(d, "config", "core.fileMode", "false");
    const r = await upgrade(d);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /Staged 1 executable file\(s\)/);
    assert.match(git(d, "ls-files", "-s", "--", ".github/agent-runtime/run.sh"), /^100755 /);
  });

  it("rewrites only the @ref of Agent-kit uses: pins, keeping every other byte", () => {
    assert.equal(read(dir, ".github/workflows/caller.yml"), callerYml(TO));
    const expected = otherYml(FROM).replace(
      `security-audit-reusable.yml@${FROM}"`,
      `security-audit-reusable.yml@${TO}"`,
    );
    assert.equal(read(dir, ".github/workflows/other.yml"), expected);
    // The BOM, the CRLFs, the non-kit action and the run: script are untouched.
    assert.ok(
      readFileSync(join(dir, ".github/workflows/other.yml"))
        .subarray(0, 3)
        .equals(Buffer.from([0xef, 0xbb, 0xbf])),
    );
    assert.match(read(dir, ".github/workflows/other.yml"), new RegExp(`checkout@${FROM}\r\n`));
  });

  it("prints the examples/ diff between the two tags for the Consumer to apply", () => {
    assert.match(res.text, /examples\/ changed between v1\.0\.0-alpha\.11 and v1\.0\.0-alpha\.12/);
    assert.match(res.text, /^-# setting: old$/m);
    assert.match(res.text, /^\+# setting: new$/m);
  });

  it("commits nothing", () => {
    assert.notEqual(git(dir, "status", "--porcelain"), "");
    assert.equal(git(dir, "rev-list", "--count", "HEAD"), "1");
  });
});

describe("upgrade: refusals change nothing", () => {
  const refused = async (dir, args, pattern, extra) => {
    const before = snapshot(dir);
    const res = await upgrade(dir, args, extra);
    assert.equal(res.code, 1, res.text);
    assert.match(res.text, /REFUSED/);
    assert.match(res.text, pattern);
    assert.match(res.text, /Nothing was changed\./);
    assert.deepEqual(snapshot(dir), before);
    return res;
  };

  it("refuses when the pins disagree", async () => {
    const dir = makeConsumer({ files: { ".github/workflows/caller.yml": callerYml(TO) } });
    await refused(dir, undefined, /same Release-line tag.*pins disagree/s);
  });

  it("refuses an old tag with no manifest, with the message doctor uses", async () => {
    const dir = makeConsumer({ tag: PRE });
    await refused(
      dir,
      undefined,
      /v1\.0\.0-alpha\.10 has no kit-owned-paths\.txt.*blob\/v1\.0\.0-alpha\.10\/docs\/adopt\.md/,
    );
  });

  it("refuses a new tag with no manifest", async () => {
    const dir = makeConsumer();
    await refused(dir, ["--tag", PRE, "--yes"], /has no kit-owned-paths\.txt/);
  });

  it("refuses uncommitted changes in a path it would replace, before touching any other path", async () => {
    const dir = makeConsumer();
    writeFileSync(join(dir, ".github/agent-runtime/hook.mjs"), "local edit\n");
    const res = await refused(dir, undefined, /uncommitted changes.*--force/s);
    assert.match(res.text, /M \.github\/agent-runtime\/hook\.mjs/);
  });

  it("counts an untracked file in a path only the old tag lists", async () => {
    const dir = makeConsumer();
    writeFileSync(join(dir, ".claude/skills/old-skill/mine.md"), "mine\n");
    const res = await refused(dir, undefined, /uncommitted changes/);
    assert.match(res.text, /\? \.claude\/skills\/old-skill\/mine\.md/);
  });

  it("--force goes ahead and discards those changes", async () => {
    const dir = makeConsumer();
    writeFileSync(join(dir, ".github/agent-runtime/hook.mjs"), "local edit\n");
    const res = await upgrade(dir, ["--tag", TO, "--yes", "--force"]);
    assert.equal(res.code, 0, res.text);
    assert.match(res.text, /--force: discarding uncommitted changes in 1 file/);
    assert.equal(read(dir, ".github/agent-runtime/hook.mjs"), "export const v = 12;\n");
  });

  for (const [name, tag, pattern] of [
    ["a symbolic link", BAD.symlink, /"\.github\/agent-runtime\/link" as a symbolic link/],
    ["a submodule", BAD.submodule, /"\.github\/agent-runtime\/sub" as a submodule/],
    [
      "files that differ only in case",
      BAD.caseCollision,
      /differ only in case.*README\.md and .*readme\.md/,
    ],
    [
      "a file and a folder with one name on Windows",
      BAD.fileDir,
      /differ only in case|both a file and a folder/,
    ],
    [
      "a listed path with no files",
      BAD.ghost,
      /lists \.claude\/skills\/ghost\/, but the tag has no files/,
    ],
    [
      "a manifest path upgrade may not delete",
      BAD.badManifest,
      /"docs\/" is not a permitted Kit-owned path/,
    ],
  ]) {
    it(`refuses a tag with ${name}`, async () => {
      const dir = makeConsumer();
      await refused(dir, ["--tag", tag, "--yes"], pattern);
    });
  }

  const junction = (target, path) => {
    try {
      symlinkSync(target, path, "junction");
      return true;
    } catch {
      return false;
    }
  };

  it("refuses a Kit-owned path that is a link, and leaves its target alone", async (t) => {
    const outside = join(tmp, `outside-${consumers}`);
    writeTree(outside, { "keep.md": "keep\n" });
    const dir = makeConsumer();
    rmSync(join(dir, ".claude/skills/code-review"), { recursive: true });
    if (!junction(outside, join(dir, ".claude/skills/code-review"))) return t.skip("no links");
    await refused(
      dir,
      ["--tag", TO, "--yes", "--force"],
      /code-review is a symbolic link or junction/,
    );
    assert.equal(readFileSync(join(outside, "keep.md"), "utf8"), "keep\n");
  });

  it("refuses when a parent folder is a link", async (t) => {
    const outside = join(tmp, `outside-parent-${consumers}`);
    writeTree(outside, { "skills/code-review/keep.md": "keep\n" });
    const dir = makeConsumer();
    rmSync(join(dir, ".claude"), { recursive: true });
    if (!junction(outside, join(dir, ".claude"))) return t.skip("no links");
    await refused(
      dir,
      ["--tag", TO, "--yes", "--force"],
      /\.claude is a symbolic link or junction/,
    );
    assert.equal(readFileSync(join(outside, "skills/code-review/keep.md"), "utf8"), "keep\n");
  });

  it("refuses a link inside a Kit-owned path", async (t) => {
    const outside = join(tmp, `outside-inner-${consumers}`);
    writeTree(outside, { "keep.md": "keep\n" });
    const dir = makeConsumer();
    if (!junction(outside, join(dir, ".github/agent-runtime/linked"))) return t.skip("no links");
    await refused(
      dir,
      ["--tag", TO, "--yes", "--force"],
      /holds a symbolic link or junction.*linked/,
    );
    assert.equal(readFileSync(join(outside, "keep.md"), "utf8"), "keep\n");
  });

  it("refuses a workflow file that is not valid UTF-8 rather than corrupting it", async () => {
    const dir = makeConsumer({
      files: {
        ".github/workflows/bad.yml": Buffer.concat([
          Buffer.from(`jobs:\n  a:\n    uses: ${KIT}/.github/workflows/x.yml@${FROM}\n# `),
          Buffer.from([0xff, 0x0a]),
        ]),
      },
    });
    await refused(dir, undefined, /bad\.yml is not valid UTF-8/);
  });

  it("refuses outside a git repository", async () => {
    const dir = join(tmp, "not-a-repo");
    mkdirSync(dir);
    const res = await upgrade(dir);
    assert.equal(res.code, 1);
    assert.match(res.text, /is not a git repository/);
  });
});

describe("upgrade: after a Dependabot pin bump", () => {
  // The pins already name the new tag; the files are still the old tag's.
  const bumped = () => makeConsumer({ tag: TO });

  it("without --from, re-copies the new tag's paths but cannot know what to delete, and says so", async () => {
    const dir = bumped();
    const res = await upgrade(dir, ["--tag", TO, "--yes"]);
    assert.equal(res.code, 0, res.text);
    assert.equal(read(dir, ".github/agent-runtime/hook.mjs"), "export const v = 12;\n");
    assert.equal(existsSync(join(dir, ".claude/skills/old-skill")), true);
    assert.match(res.text, /run again with --from <that tag>/);
  });

  it("--from deletes paths only the old tag listed and prints the examples/ diff, leaving the pins", async () => {
    const dir = bumped();
    const res = await upgrade(dir, ["--tag", TO, "--from", FROM, "--yes"]);
    assert.equal(res.code, 0, res.text);
    assert.equal(existsSync(join(dir, ".claude/skills/old-skill")), false);
    assert.match(res.text, /The uses: pins already name v1\.0\.0-alpha\.12\./);
    assert.match(res.text, /^\+# setting: new$/m);
    assert.equal(read(dir, ".github/workflows/caller.yml"), callerYml(TO));
  });

  it("refuses --from when the pins name a third tag", async () => {
    const dir = makeConsumer({ tag: FROM });
    const before = snapshot(dir);
    const res = await upgrade(dir, ["--tag", TO, "--from", BAD.ghost, "--yes"]);
    assert.equal(res.code, 1, res.text);
    assert.match(res.text, /neither --from/);
    assert.deepEqual(snapshot(dir), before);
  });

  it("rejects a --from that is not a Release-line tag", async () => {
    const res = await upgrade(bumped(), ["--tag", TO, "--from", "main", "--yes"]);
    assert.equal(res.code, 2, res.text);
  });
});

describe("upgrade: ignored files", () => {
  it("lists ignored files it will delete with a path, without needing --force", async () => {
    const dir = makeConsumer({ files: { ".gitignore": "*.log\n" } });
    writeFileSync(join(dir, ".github/agent-runtime/debug.log"), "noise\n");
    const res = await upgrade(dir);
    assert.equal(res.code, 0, res.text);
    assert.match(
      res.text,
      /Also deleted: 1 ignored file\(s\) or folder\(s\)[^\n]*\n {2}\.github\/agent-runtime\/debug\.log/,
    );
    assert.equal(existsSync(join(dir, ".github/agent-runtime/debug.log")), false);
  });
});

describe("upgrade: hardening", () => {
  it("counts a file marked assume-unchanged or skip-worktree as changed", async () => {
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const dir = makeConsumer();
      git(dir, "update-index", flag, ".github/agent-runtime/hook.mjs");
      writeFileSync(join(dir, ".github/agent-runtime/hook.mjs"), "hidden local edit\n");
      const before = snapshot(dir);
      const res = await upgrade(dir);
      assert.equal(res.code, 1, res.text);
      assert.match(res.text, /hook\.mjs \(marked (?:assume-unchanged|skip-worktree)\)/);
      assert.deepEqual(snapshot(dir), before);
    }
  });

  it("prints the repository root it will change before asking", async () => {
    const dir = makeConsumer();
    const res = await upgrade(dir, ["--tag", TO], { prompt: async () => "n" });
    assert.match(res.text, /Upgrading .* in .+\./);
  });

  it("escapes bidirectional and invisible characters in what it prints", () => {
    for (const c of ["‮", "⁦", "​", "‏", "﻿"]) {
      assert.doesNotMatch(sanitizeLine(`a${c}b`), new RegExp(c));
    }
  });
});

describe("upgrade: questions and flags", () => {
  it("with no terminal and no --yes, stops before any git runs and names the flags", async () => {
    const calls = [];
    const runner = (...a) => (calls.push(a), systemRunner(...a));
    for (const [args, flags] of [
      [["--tag", TO], /pass --yes\./],
      [[], /pass --tag <vY> and --yes\./],
    ]) {
      const dir = makeConsumer();
      const before = snapshot(dir);
      const res = await upgrade(dir, args, { runner });
      assert.equal(res.code, 2, res.text);
      assert.match(res.text, flags);
      assert.deepEqual(snapshot(dir), before);
    }
    assert.equal(calls.length, 0);
  });

  it("asks before writing, and a no changes nothing", async () => {
    const dir = makeConsumer();
    const before = snapshot(dir);
    const asked = [];
    const prompt = async (q) => (asked.push(q), "n");
    const res = await upgrade(dir, ["--tag", TO], { prompt });
    assert.equal(res.code, 1, res.text);
    assert.match(asked.join(), /Go ahead\? \[y\/N\]/);
    assert.match(res.text, /Stopped\. Nothing was changed\./);
    assert.deepEqual(snapshot(dir), before);
  });

  it("asks for a missing tag, and a yes goes ahead", async () => {
    const dir = makeConsumer();
    const answers = [TO, "y"];
    const res = await upgrade(dir, [], { prompt: async () => answers.shift() });
    assert.equal(res.code, 0, res.text);
    assert.equal(read(dir, ".github/workflows/caller.yml"), callerYml(TO));
  });

  it("rejects a tag that is not a Release-line tag, and flags of other commands", async () => {
    for (const args of [
      ["--tag", "main", "--yes"],
      ["--tag", "--upload-pack=x", "--yes"],
      ["--tag", TO, "--yes", "--ci"],
      ["--tag", TO, "--yes", "--repo", "a/b"],
      ["--tag", TO, "--yes", "extra"],
    ]) {
      const res = await upgrade(makeConsumer(), args);
      assert.equal(res.code, 2, `${args.join(" ")}: ${res.text}`);
    }
  });

  it("re-copies from the pinned tag when --tag names it, with no pin edits or examples diff", async () => {
    const dir = makeConsumer();
    writeFileSync(join(dir, ".claude/skills/code-review/stale.md"), "stale\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "drift");
    const res = await upgrade(dir, ["--tag", FROM, "--yes"]);
    assert.equal(res.code, 0, res.text);
    assert.equal(existsSync(join(dir, ".claude/skills/code-review/stale.md")), false);
    assert.match(res.text, /The uses: pins already name v1\.0\.0-alpha\.11\./);
    assert.match(res.text, /no examples\/ diff to show/);
    assert.equal(read(dir, ".github/workflows/caller.yml"), callerYml(FROM));
  });

  it("runs no filter command the checkout configures", async () => {
    const dir = makeConsumer({ files: { ".gitattributes": "*.mjs filter=probe\n" } });
    git(dir, "config", "filter.probe.clean", "echo ran > probe-ran.txt; cat");
    git(dir, "config", "filter.probe.smudge", "cat");
    const res = await upgrade(dir, ["--tag", TO, "--yes", "--force"]);
    assert.equal(existsSync(join(dir, "probe-ran.txt")), false, res.text);
  });

  it("sanitizes what it prints from tag files", async () => {
    const dir = makeConsumer();
    const res = await upgrade(dir);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(res.text, /[\u0000-\u0009\u000b-\u001f]/);
  });
});

describe("tag reading", () => {
  it("one bare repository holds two tags and diffs them", () => {
    const kit = openRepo({ runner: systemRunner, repo: KIT });
    try {
      const a = kit.fetchTag(FROM);
      const b = kit.fetchTag(TO);
      assert.notEqual(a.commit, b.commit);
      assert.match(kit.diff(a, b, "examples/"), /^\+# setting: new$/m);
      assert.deepEqual(
        b.listFiles(".github/agent-runtime/").map((f) => [f.path, f.mode]),
        [
          [".github/agent-runtime/bin.dat", "100644"],
          [".github/agent-runtime/hook.mjs", "100644"],
          [".github/agent-runtime/run.sh", "100755"],
        ],
      );
    } finally {
      kit.cleanup();
    }
  });

  it("readBlob returns raw bytes; readFile still returns text", () => {
    const snap = openKitTag({ runner: systemRunner, repo: KIT, tag: TO, remoteUrl: kitUrl });
    try {
      const bin = snap.listFiles(".github/agent-runtime/").find((f) => f.path.endsWith("bin.dat"));
      assert.deepEqual(snap.readBlob(bin.oid), BINARY);
      assert.throws(() => snap.readBlob("HEAD"), /not a git object id/);
      assert.equal(snap.readFile("examples/caller.yml"), TO_FILES["examples/caller.yml"]);
    } finally {
      snap.cleanup();
    }
  });

  it("systemRunner's buffer mode returns stdout as a Buffer", () => {
    const r = systemRunner("git", ["--version"], { encoding: "buffer" });
    assert.ok(Buffer.isBuffer(r.stdout));
    assert.equal(typeof systemRunner("git", ["--version"]).stdout, "string");
  });
});

describe("path safety", () => {
  it("checkSafePath refuses anything unsafe to write on Linux, macOS or Windows", () => {
    for (const ok of [
      ".github/agent-runtime/hook.mjs",
      ".claude/skills/a-b_c.d/x",
      "a/.gitignore",
    ]) {
      assert.equal(checkSafePath(ok), ok);
    }
    for (const bad of [
      "",
      "/abs",
      "a/",
      "a/../b",
      "./a",
      "a/./b",
      "a/.git/config",
      "a/.GIT/config",
      "a/.Git",
      "a/git~1/config",
      "a/PROGRA~1",
      "a/.git./x",
      "a/name.",
      "a/nul",
      "a/CON.txt",
      "a/com1",
      "a/lpt9.md",
      "a b",
      "a\\b",
      "a:b",
      "a/\u0000",
      "a\nb",
    ]) {
      assert.throws(() => checkSafePath(bad), JSON.stringify(bad));
    }
  });

  it("caseCollisions and fileDirConflicts find names one file system would merge", () => {
    assert.deepEqual(caseCollisions(["a/README.md", "a/readme.md", "a/b"]), [
      ["a/README.md", "a/readme.md"],
    ]);
    assert.deepEqual(caseCollisions(["a", "b"]), []);
    assert.deepEqual(fileDirConflicts(["a/x", "a/X/y"]), [["a/X", "a/X/y"]]);
    assert.deepEqual(fileDirConflicts(["a/x", "a/y/z"]), []);
  });
});

describe("rewriteKitPins", () => {
  it("changes only the ref, on pin lines only", () => {
    const text = [
      `on: push # ${KIT}/.github/workflows/a.yml@${FROM}`,
      "jobs:",
      "  a:",
      `    uses: ${KIT}/.github/workflows/a.yml@${FROM}   # keep this comment`,
      "  b:",
      `    uses: '${KIT}/.github/workflows/b.yml@${FROM}'`,
      "  c:",
      "    steps:",
      `      - uses: other/agent-kit-ish/.github/workflows/a.yml@${FROM}`,
      "      - run: >-",
      `          ${KIT}/.github/workflows/a.yml@${FROM}`,
      "",
    ].join("\r");
    const { text: out, count } = rewriteKitPins(text, TO);
    assert.equal(count, 2);
    const lines = out.split("\r");
    assert.equal(lines[0], text.split("\r")[0]);
    assert.equal(lines[3], `    uses: ${KIT}/.github/workflows/a.yml@${TO}   # keep this comment`);
    assert.equal(lines[5], `    uses: '${KIT}/.github/workflows/b.yml@${TO}'`);
    assert.deepEqual(lines.slice(6), text.split("\r").slice(6));
    assert.equal(
      findKitPins(out).every((p) => p.ref === TO),
      true,
    );
  });

  it("leaves a file with no pins untouched", () => {
    assert.deepEqual(rewriteKitPins("name: x\n", TO), { text: "name: x\n", count: 0 });
  });
});
