// Contract for `agent-kit doctor` (cli/): the pre-manifest refusal, the
// Kit-owned tree comparison, pin agreement, secret and variable derivation,
// and the fail / warn / skip exit codes. git runs for real against local
// fixture repositories (no network); gh is always a fake, so no test reaches
// GitHub.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findKitPins, parseCaller, variableRefs } from "../cli/src/callers.mjs";
import { triggerLabels } from "../cli/src/checks/labels.mjs";
import { checkPins } from "../cli/src/checks/pins.mjs";
import {
  checkCreationRule,
  checkTagRuleset,
  checkUpdateRule,
  coversRef,
  riskyBypassActors,
  workflowsPushingTagsWithToken,
} from "../cli/src/checks/rulesets.mjs";
import {
  checkSecrets,
  checkVariables,
  deriveRequirements,
} from "../cli/src/checks/secrets-and-variables.mjs";
import { main } from "../cli/src/cli.mjs";
import { LOCAL_ONLY_CHECKS, runDoctor } from "../cli/src/doctor.mjs";
import { systemRunner } from "../cli/src/exec.mjs";
import { parseKitOwnedPaths } from "../cli/src/kit-owned-paths.mjs";
import { openKitTag, PreManifestTagError } from "../cli/src/kit-tag.mjs";
import { localTreeHashes } from "../cli/src/local-tree.mjs";
import { upgradeCommand } from "../cli/src/tags.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (...p) => readFileSync(join(root, ...p), "utf8");
const KIT = "mnaimfaizy/agent-kit";
const TAG = "v1.0.0-alpha.12";
const OLD_TAG = "v1.0.0-alpha.10";
const GIT_ID = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@example.com",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
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

const KIT_OWNED = "# test manifest\n.claude/skills/code-review/\n.github/agent-runtime/\n";
const KIT_FILES = {
  ".claude/skills/code-review/SKILL.md": "# code review\n",
  ".claude/skills/code-review/notes/a.md": "nested\n",
  ".github/agent-runtime/hook.mjs": "export const x = 1;\n",
  ".github/workflows/agent-plan-reusable.yml": readRepo(
    ".github/workflows/agent-plan-reusable.yml",
  ),
  ".github/workflows/security-audit-reusable.yml": readRepo(
    ".github/workflows/security-audit-reusable.yml",
  ),
};

function callerFor(tag) {
  return `name: caller
on:
  issues:
    types: [labeled]
permissions:
  contents: read
jobs:
  plan:
    uses: ${KIT}/.github/workflows/agent-plan-reusable.yml@${tag} # pinned
    with:
      kill_switch: \${{ vars.CLAUDE_PIPELINE_ENABLED != 'true' }}
      model: \${{ vars.CLAUDE_MODEL_PLAN || vars.CLAUDE_MODEL || 'claude-opus-5' }}
      trigger_label: "agent:plan"
    secrets:
      claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
`;
}

let tmp;
let kitUrl;
const openTag = (opts) => openKitTag({ ...opts, remoteUrl: kitUrl });

function makeConsumer(name, { tag = TAG, files = {} } = {}) {
  const dir = join(tmp, name);
  mkdirSync(dir);
  git(dir, "init", "-q");
  const copied = Object.fromEntries(
    Object.entries(KIT_FILES).filter(([p]) => !p.startsWith(".github/workflows/")),
  );
  writeTree(dir, { ...copied, ".github/workflows/caller.yml": callerFor(tag), ...files });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "adopt");
  return dir;
}

/** A fake gh: answers read-only API calls from `routes`, records every call. */
function fakeGh(routes = {}) {
  const calls = [];
  const runner = (cmd, args, opts) => {
    if (cmd === "git") return systemRunner(cmd, args, opts);
    assert.equal(cmd, "gh");
    assert.ok(Array.isArray(args) && args.every((a) => typeof a === "string"));
    calls.push(args);
    if (args[0] === "repo" && args[1] === "view") {
      return ok(
        JSON.stringify(
          routes.repo ?? {
            nameWithOwner: "acme/app",
            isInOrganization: true,
            viewerPermission: "ADMIN",
            defaultBranchRef: { name: "main" },
          },
        ),
      );
    }
    assert.equal(args[0], "api");
    assert.deepEqual(args.slice(1, 3), ["--method", "GET"], "gh api calls must be GETs");
    const endpoint = args[3] === "--paginate" ? args[4] : args[3];
    const route = Object.keys(routes).find((k) => endpoint === k);
    if (!route) return { status: 1, stdout: "", stderr: `gh: Not Found (HTTP 404) ${endpoint}` };
    const value = routes[route];
    if (value instanceof Error) return { status: 1, stdout: "", stderr: `gh: ${value.message}` };
    return ok(typeof value === "string" ? value : value.join("\n"));
  };
  return { runner, calls };
}
const ok = (stdout) => ({ status: 0, stdout, stderr: "" });

const RULESETS = {
  "repos/acme/app/rulesets?includes_parents=true": ["1", "2", "3"],
  "repos/acme/app/rulesets/1": JSON.stringify({
    enforcement: "active",
    target: "branch",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "update" }, { type: "pull_request" }],
  }),
  "repos/acme/app/rulesets/2": JSON.stringify({
    enforcement: "active",
    target: "branch",
    conditions: { ref_name: { include: ["refs/heads/release/**/*"], exclude: [] } },
    rules: [{ type: "creation" }],
  }),
  "repos/acme/app/rulesets/3": JSON.stringify({
    enforcement: "active",
    target: "tag",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
  }),
};
const ALL_GOOD = {
  "repos/acme/app/actions/secrets": ["CLAUDE_CODE_OAUTH_TOKEN"],
  "repos/acme/app/actions/organization-secrets": [],
  "repos/acme/app/actions/variables": ["CLAUDE_PIPELINE_ENABLED"],
  "repos/acme/app/actions/organization-variables": [],
  "repos/acme/app/labels": ["agent:plan", "bug"],
  "orgs/acme/installations": ["claude all"],
  ...RULESETS,
};

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-kit-doctor-test-"));
  const kit = join(tmp, "kit");
  mkdirSync(kit);
  git(kit, "init", "-q");
  writeTree(kit, KIT_FILES);
  git(kit, "add", "-A");
  git(kit, "commit", "-qm", "pre-manifest");
  git(kit, "tag", "-a", OLD_TAG, "-m", OLD_TAG);
  writeTree(kit, { "kit-owned-paths.txt": KIT_OWNED });
  git(kit, "add", "-A");
  git(kit, "commit", "-qm", "manifest");
  git(kit, "tag", "-a", TAG, "-m", TAG);
  kitUrl = pathToFileURL(kit).href;
});
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("pre-manifest refusal", () => {
  it("openKitTag refuses a tag with no kit-owned-paths.txt and points at that tag's adopt.md", () => {
    assert.throws(
      () => openTag({ runner: systemRunner, repo: KIT, tag: OLD_TAG }),
      (err) =>
        err instanceof PreManifestTagError &&
        err.message.includes(`https://github.com/${KIT}/blob/${OLD_TAG}/docs/adopt.md`),
    );
  });

  it("doctor refuses with exit 1 and runs nothing against the old tag", () => {
    const dir = makeConsumer("old-pins", { tag: OLD_TAG });
    const out = [];
    const code = main(["doctor", "--ci"], {
      cwd: dir,
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
      runner: systemRunner,
      openTag,
    });
    assert.equal(code, 1);
    assert.match(out.join("\n"), /REFUSED .*has no kit-owned-paths\.txt.*docs\/adopt\.md/);
    assert.doesNotMatch(out.join("\n"), /PASS {2}Kit-owned paths/);
  });

  it("openKitTag rejects anything that is not a Release-line tag before running git", () => {
    const calls = [];
    const runner = (...a) => (calls.push(a), ok(""));
    for (const tag of ["main", "--upload-pack=evil", "v1.0", "v1.0.0;rm -rf /"]) {
      assert.throws(() => openKitTag({ runner, repo: KIT, tag }));
    }
    assert.throws(() => openKitTag({ runner, repo: "a/b c", tag: TAG }));
    assert.equal(calls.length, 0);
  });

  it("parseKitOwnedPaths refuses any path upgrade could not safely delete", () => {
    assert.deepEqual(parseKitOwnedPaths(KIT_OWNED), [
      ".claude/skills/code-review/",
      ".github/agent-runtime/",
    ]);
    for (const bad of [
      ".claude/skills/\n",
      ".github/workflows/\n",
      "docs/\n",
      ".claude/skills/../x/\n",
      "a b/\n",
      "\n",
    ]) {
      assert.throws(() => parseKitOwnedPaths(bad), bad);
    }
  });
});

describe("Kit-owned tree comparison", () => {
  it("matches an unmodified copy, without writing to the Consumer's .git", () => {
    const dir = makeConsumer("clean");
    const objects = join(dir, ".git", "objects");
    const before = readdirSync(objects).sort();
    const indexBefore = statSync(join(dir, ".git", "index")).mtimeMs;
    const report = runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag });
    const trees = report.results.find((r) => r.id === "kit-owned-trees");
    assert.equal(trees.status, "pass", JSON.stringify(trees));
    assert.equal(report.exitCode, 0);
    assert.deepEqual(
      readdirSync(objects).sort(),
      before,
      "doctor wrote objects into the Consumer repository",
    );
    assert.equal(
      statSync(join(dir, ".git", "index")).mtimeMs,
      indexBefore,
      "doctor touched the Consumer index",
    );
  });

  it("hashes match git's own tree hashes for the committed paths", () => {
    const dir = makeConsumer("hash");
    const { hashes } = localTreeHashes({
      runner: systemRunner,
      cwd: dir,
      paths: [".github/agent-runtime/"],
    });
    assert.equal(
      hashes.get(".github/agent-runtime/"),
      git(dir, "rev-parse", "HEAD:.github/agent-runtime"),
    );
  });

  for (const [name, change] of [
    [
      "an edited file",
      (d) => writeFileSync(join(d, ".github/agent-runtime/hook.mjs"), "export const x = 2;\n"),
    ],
    [
      "an extra untracked file",
      (d) => writeFileSync(join(d, ".claude/skills/code-review/stale.md"), "old\n"),
    ],
    ["a missing path", (d) => rmSync(join(d, ".github/agent-runtime"), { recursive: true })],
  ]) {
    it(`fails on ${name} and names the upgrade command for the pinned tag`, () => {
      const dir = makeConsumer(`changed-${name.replace(/\W+/g, "-")}`);
      change(dir);
      const report = runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag });
      const trees = report.results.find((r) => r.id === "kit-owned-trees");
      assert.equal(trees.status, "fail");
      assert.deepEqual(trees.fix, [
        `npx @mnaimfaizy/agent-kit@1.0.0-alpha.12 upgrade --tag ${TAG}`,
      ]);
      assert.equal(report.exitCode, 1);
    });
  }

  it("ignores gitignored files inside a Kit-owned path", () => {
    const dir = makeConsumer("ignored", { files: { ".gitignore": "*.log\n" } });
    writeFileSync(join(dir, ".github/agent-runtime/debug.log"), "noise\n");
    const report = runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag });
    assert.equal(report.results.find((r) => r.id === "kit-owned-trees").status, "pass");
  });

  it("upgradeCommand pins the npm version that matches the tag, from the first published one", () => {
    assert.equal(
      upgradeCommand("v1.0.0-beta.1"),
      "npx @mnaimfaizy/agent-kit@1.0.0-beta.1 upgrade --tag v1.0.0-beta.1",
    );
    assert.equal(
      upgradeCommand("v1.0.0-alpha.11"),
      "npx @mnaimfaizy/agent-kit upgrade --tag v1.0.0-alpha.11",
    );
  });
});

describe("pin agreement", () => {
  const file = (path, refs) => ({
    path,
    pins: refs.map((ref, i) => ({ repo: KIT, file: "agent-plan-reusable.yml", ref, line: i + 1 })),
  });

  it("passes when every pin names the same repository and tag", () => {
    const r = checkPins([file("a.yml", [TAG, TAG]), file("b.yml", [TAG])]);
    assert.equal(r.result.status, "pass");
    assert.equal(r.tag, TAG);
    assert.equal(r.repo, KIT);
  });

  it("fails when pins disagree, name a branch or SHA, or are absent", () => {
    for (const files of [
      [file("a.yml", [TAG]), file("b.yml", ["v1.0.0-alpha.11"])],
      [file("a.yml", ["main"])],
      [file("a.yml", ["0123456789abcdef0123456789abcdef01234567"])],
      [],
    ]) {
      const r = checkPins(files);
      assert.equal(r.result.status, "fail", JSON.stringify(files));
      assert.equal(r.tag, null);
    }
  });

  it("reads pins from the shipped Callers, ignoring comments", () => {
    for (const example of ["plan-implement-review-caller.yml", "security-audit-caller.yml"]) {
      const { pins } = parseCaller(readRepo("examples", example));
      assert.ok(pins.length > 0, example);
      assert.equal(new Set(pins.map((p) => p.ref)).size, 1, example);
    }
    assert.equal(
      parseCaller(`jobs:\n  a:\n    # uses: ${KIT}/.github/workflows/x.yml@main\n    runs-on: x\n`)
        .pins.length,
      0,
    );
  });

  it("a disagreement fails doctor and skips the tree check rather than passing it", () => {
    const dir = makeConsumer("disagree", {
      files: { ".github/workflows/other.yml": callerFor("v1.0.0-alpha.11") },
    });
    const report = runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag });
    assert.equal(report.results.find((r) => r.id === "pins").status, "fail");
    assert.equal(report.results.find((r) => r.id === "kit-owned-trees").status, "skip");
    assert.equal(report.exitCode, 1);
  });
});

describe("secret and variable derivation", () => {
  const reusable = (file) => readRepo(".github/workflows", file);

  it("takes required versus optional from the reusable workflow's secrets block", () => {
    const caller = {
      path: "audit.yml",
      ...parseCaller(readRepo("examples/security-audit-caller.yml")),
    };
    const { secrets, variables, problems } = deriveRequirements([caller], reusable);
    assert.deepEqual(problems, []);
    const required = secrets
      .filter((s) => s.required)
      .flatMap((s) => s.names)
      .sort();
    const optional = secrets
      .filter((s) => !s.required)
      .flatMap((s) => s.names)
      .sort();
    assert.deepEqual(required, ["AGENT_KIT_ADVISORIES_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
    assert.ok(optional.includes("AGENT_KIT_NOTIFY_SMTP_PASSWORD"));
    assert.ok(!optional.includes("CLAUDE_CODE_OAUTH_TOKEN"));
    const byName = Object.fromEntries(variables.map((v) => [v.name, v.optional]));
    assert.equal(
      byName.CLAUDE_SECURITY_AUDIT_ENABLED,
      false,
      "the Kill switch variable is required",
    );
    assert.equal(byName.CLAUDE_MODEL_AUDIT, true);
    assert.equal(byName.CLAUDE_MODEL, true);
  });

  it("handles secrets: inherit, undeclared secrets and a required secret the Caller drops", () => {
    const inherit = parseCaller(
      `jobs:\n  plan:\n    uses: ${KIT}/.github/workflows/agent-plan-reusable.yml@${TAG}\n    secrets: inherit\n`,
    );
    const a = deriveRequirements([{ path: "i.yml", ...inherit }], reusable);
    assert.deepEqual(
      a.secrets.map((s) => [s.names, s.required]),
      [[["CLAUDE_CODE_OAUTH_TOKEN"], true]],
    );

    const wrong = parseCaller(
      `jobs:\n  plan:\n    uses: ${KIT}/.github/workflows/agent-plan-reusable.yml@${TAG}\n    secrets:\n      not_declared: \${{ secrets.X }}\n`,
    );
    const b = deriveRequirements([{ path: "w.yml", ...wrong }], reusable);
    assert.equal(b.problems.length, 2, b.problems.join("\n"));
  });

  it("ignores commented-out variables and treats a read without || as required", () => {
    const refs = variableRefs(
      "# x: ${{ vars.COMMENTED }}\na: ${{ vars.A || 'x' }}\nb: ${{ vars.A }} ${{ vars.B || vars.C }}\n",
    );
    const byName = Object.fromEntries(refs.map((v) => [v.name, v.optional]));
    assert.deepEqual(byName, { A: false, B: true, C: false });
  });

  it("doctor fails on a missing required secret and warns on a missing optional one", () => {
    const dir = makeConsumer("secrets", {
      files: {
        ".github/workflows/audit.yml": readRepo("examples/security-audit-caller.yml").replace(
          /@v[\w.-]+/,
          `@${TAG}`,
        ),
      },
    });
    const { runner } = fakeGh({ ...ALL_GOOD, "repos/acme/app/variables": [] });
    const report = runDoctor({ cwd: dir, runner, openTag });
    const secrets = report.results.find((r) => r.id === "secrets");
    assert.equal(secrets.status, "fail");
    assert.ok(
      secrets.details.some((d) => /^required, not set: AGENT_KIT_ADVISORIES_TOKEN/.test(d)),
    );
    assert.ok(secrets.details.some((d) => /^optional, not set: AGENT_KIT_NOTIFY_EMAIL_TO/.test(d)));
    assert.ok(secrets.fix.includes("gh secret set AGENT_KIT_ADVISORIES_TOKEN --repo acme/app"));
    const variables = report.results.find((r) => r.id === "variables");
    assert.equal(variables.status, "fail");
    assert.ok(
      variables.fix.includes(
        "gh variable set CLAUDE_SECURITY_AUDIT_ENABLED --repo acme/app --body true",
      ),
    );
  });
});

describe("fail / warn / skip exit codes", () => {
  let dir;
  before(() => {
    dir = makeConsumer("exit-codes");
  });
  const run = (routes, args = ["doctor"]) => {
    const gh = fakeGh(routes);
    const out = [];
    const code = main(args, {
      cwd: dir,
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
      runner: gh.runner,
      openTag,
    });
    return { code, text: out.join("\n"), calls: gh.calls };
  };

  it("exits 0 when every check passes", () => {
    const { code, text } = run(ALL_GOOD);
    assert.equal(code, 0, text);
    assert.match(text, /0 failed, 0 warning\(s\), 0 skipped/);
  });

  it("exits 0 on warnings, and 1 on the same warnings with --strict", () => {
    const routes = { ...ALL_GOOD, "repos/acme/app/rulesets?includes_parents=true": ["1"] };
    const loose = run(routes);
    assert.equal(loose.code, 0, loose.text);
    assert.match(loose.text, /WARN {2}Release branches have a creation rule/);
    assert.match(loose.text, /WARN {2}Release tags have a v\* tag ruleset/);
    const strict = run(routes, ["doctor", "--strict"]);
    assert.equal(strict.code, 1, strict.text);
    assert.match(strict.text, /FAIL {2}Release tags have a v\* tag ruleset: .*failed by --strict/);
  });

  it("exits 1 on a missing Trigger label or a missing Claude App", () => {
    assert.equal(run({ ...ALL_GOOD, "repos/acme/app/labels": ["bug"] }).code, 1);
    assert.equal(run({ ...ALL_GOOD, "orgs/acme/installations": ["other-app all"] }).code, 1);
  });

  it("reports a check it lacked permission for as skipped, never passed", () => {
    const routes = { ...ALL_GOOD };
    delete routes["repos/acme/app/actions/secrets"];
    routes["orgs/acme/installations"] = new Error("Resource not accessible (HTTP 403)");
    const { code, text } = run(routes);
    assert.equal(code, 0, text);
    assert.match(
      text,
      /SKIP {2}Secrets the Callers pass are set: Could not list repository secrets/,
    );
    assert.match(text, /SKIP {2}Claude GitHub App installed/);
    assert.match(text, /Skipped checks did not run and are not passes: secrets, claude-app\./);
  });

  it("the Claude App check is skipped on a personal account, where gh cannot see installations", () => {
    const repo = {
      nameWithOwner: "acme/app",
      isInOrganization: false,
      viewerPermission: "ADMIN",
      defaultBranchRef: { name: "main" },
    };
    const { text } = run({ ...ALL_GOOD, repo });
    assert.match(text, /SKIP {2}Claude GitHub App installed/);
  });

  it("--ci runs only the tree and pin checks, calls no gh, and lists every skipped check", () => {
    const { code, text, calls } = run(ALL_GOOD, ["doctor", "--ci"]);
    assert.equal(code, 0, text);
    assert.deepEqual(calls, []);
    assert.match(text, /PASS {2}uses: pins agree/);
    assert.match(text, /PASS {2}Kit-owned paths match/);
    for (const [id, title] of LOCAL_ONLY_CHECKS) {
      assert.match(text, new RegExp(`SKIP {2}${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), id);
    }
    assert.doesNotMatch(
      text
        .split("\n")
        .filter((l) => l.startsWith("PASS"))
        .join("\n"),
      /Secrets|Trigger|ruleset/i,
    );
  });

  it("falls back to CI mode when the gh login is not an admin", () => {
    const repo = {
      nameWithOwner: "acme/app",
      isInOrganization: true,
      viewerPermission: "WRITE",
      defaultBranchRef: { name: "main" },
    };
    const { code, text, calls } = run({ ...ALL_GOOD, repo });
    assert.equal(code, 0, text);
    assert.match(text, /mode: {7}ci \(your gh login is not an admin on acme\/app\)/);
    assert.equal(calls.length, 1, "only `gh repo view` runs");
  });

  it("exits 2 on usage errors and for commands that are not built yet", () => {
    for (const args of [
      [],
      ["nope"],
      ["doctor", "--bogus"],
      ["doctor", "--repo", "x"],
      ["upgrade", "--tag", TAG],
    ]) {
      assert.equal(run(ALL_GOOD, args).code, 2, args.join(" "));
    }
  });
});

describe("ruleset and tag-push helpers", () => {
  it("matches ~DEFAULT_BRANCH, ~ALL, globs and excludes", () => {
    const rs = (include, exclude = []) => ({ conditions: { ref_name: { include, exclude } } });
    assert.ok(coversRef(rs(["~DEFAULT_BRANCH"]), "refs/heads/main", { defaultBranch: "main" }));
    assert.ok(coversRef(rs(["~ALL"]), "refs/tags/v1.0.0"));
    assert.ok(coversRef(rs(["refs/tags/v*"]), "refs/tags/v1.0.0"));
    assert.ok(!coversRef(rs(["refs/tags/v*"], ["refs/tags/v1*"]), "refs/tags/v1.0.0"));
    assert.ok(!coversRef(rs(["refs/heads/release/*"]), "refs/heads/main"));
  });

  it("flags tag pushes with the job token but not deploy-key pushes", () => {
    const files = [
      {
        path: "token.yml",
        text: "steps:\n  - run: |\n      git tag v1\n      git push origin v1\n",
      },
      { path: "tags.yml", text: "steps:\n  - run: git push --tags\n" },
      {
        path: "ssh.yml",
        text: 'steps:\n  - run: |\n      git tag "$TAG"\n      GIT_SSH_COMMAND=\'ssh -i k\' git push git@github.com:o/r.git "refs/tags/$TAG"\n',
      },
      { path: "branch.yml", text: "steps:\n  - run: git push origin HEAD:main\n" },
    ];
    assert.deepEqual(workflowsPushingTagsWithToken(files), ["token.yml", "tags.yml"]);
  });
});

describe("the CLI stays dependency-free and shell-free", () => {
  const srcFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? srcFiles(join(dir, e.name))
        : e.name.endsWith(".mjs")
          ? [join(dir, e.name)]
          : [],
    );
  const files = [...srcFiles(join(root, "cli", "src")), ...srcFiles(join(root, "cli", "bin"))];

  it("imports only node: built-ins and its own files", () => {
    for (const f of files) {
      for (const [, spec] of readFileSync(f, "utf8").matchAll(/\bfrom\s+"([^"]+)"/g)) {
        assert.ok(
          spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"),
          `${f}: imports ${spec}`,
        );
      }
    }
  });

  it("never spawns through a shell and never runs gh to change settings", () => {
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const childProcess = [
        ...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:child_process"/g),
      ];
      if (f.endsWith(join("src", "exec.mjs"))) {
        assert.deepEqual(
          childProcess.map((m) => m[1].trim()),
          ["spawnSync"],
        );
        assert.match(text, /shell:\s*false/);
      } else {
        assert.equal(childProcess.length, 0, `${f}: run commands through the injected runner`);
      }
      assert.doesNotMatch(text, /shell:\s*true/, f);
      assert.doesNotMatch(text, /"--method",\s*"(?:POST|PUT|PATCH|DELETE)"|"-X"/, f);
    }
  });

  it("reads the shipped Callers' jobs and trigger labels", () => {
    const pir = parseCaller(readRepo("examples/plan-implement-review-caller.yml"));
    assert.deepEqual(
      pir.jobs.map((j) => j.with.trigger_label),
      ["agent:plan", "agent:implement", "agent:review"],
    );
  });
});

describe("review fixes (PR #78)", () => {
  const reusable = (file) => readRepo(".github/workflows", file);
  const failingGithub = {
    getLines: () => {
      throw new Error("gh api: Resource not accessible (HTTP 403)");
    },
  };

  it("secrets: Caller problems still fail when the secrets listing is refused", () => {
    const r = checkSecrets({
      github: failingGithub,
      repo: "acme/app",
      ownerType: "User",
      requirements: {
        secrets: [],
        variables: [],
        problems: ["a.yml:plan: does not pass x"],
        unsupported: [],
      },
    });
    assert.equal(r.status, "fail");
    assert.ok(r.details.includes("a.yml:plan: does not pass x"));
    const clean = checkSecrets({
      github: failingGithub,
      repo: "acme/app",
      ownerType: "User",
      requirements: { secrets: [], variables: [], problems: [], unsupported: [] },
    });
    assert.equal(clean.status, "skip");
  });

  describe("rulesets: bypass actors", () => {
    const branch = (bypass, rules = ["update", "creation"]) => ({
      name: "default branch",
      enforcement: "active",
      target: "branch",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: rules.map((type) => ({ type })),
      bypass_actors: bypass,
    });
    const tag = (bypass) => ({
      name: "release tags",
      enforcement: "active",
      target: "tag",
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
      rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
      bypass_actors: bypass,
    });
    const admin = { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" };
    const maintain = { actor_id: 2, actor_type: "RepositoryRole", bypass_mode: "always" };
    const write = { actor_id: 4, actor_type: "RepositoryRole", bypass_mode: "always" };
    const app = { actor_id: 1236702, actor_type: "Integration", bypass_mode: "always" };
    const deployKey = { actor_id: null, actor_type: "DeployKey", bypass_mode: "always" };
    const opts = { defaultBranch: "main" };

    it("passes with only Admin and Maintain on the bypass list", () => {
      assert.equal(checkUpdateRule([branch([admin, maintain])], opts).status, "pass");
      assert.equal(checkCreationRule([branch([admin, maintain])]).status, "pass");
      assert.equal(checkTagRuleset([tag([admin, maintain])]).status, "pass");
    });

    it("warns when a GitHub App, the Write role or a custom role can bypass", () => {
      for (const actor of [app, write, { actor_id: 77, actor_type: "RepositoryRole" }]) {
        const update = checkUpdateRule([branch([admin, actor])], opts);
        assert.equal(update.status, "warn", JSON.stringify(actor));
        assert.match(update.summary, /can be bypassed/);
        assert.equal(checkCreationRule([branch([actor])]).status, "warn");
        const t = checkTagRuleset([tag([actor])]);
        assert.equal(t.status, "warn");
        assert.match(t.summary, /can be bypassed: creation, update, deletion/);
      }
      assert.deepEqual(riskyBypassActors(branch([app, write])), [
        "a GitHub App (Integration 1236702)",
        "the Write role",
      ]);
    });

    it("a deploy-key bypass is the documented tag pattern, but not on a branch", () => {
      assert.equal(checkTagRuleset([tag([admin, deployKey])]).status, "pass");
      assert.equal(checkUpdateRule([branch([deployKey])], opts).status, "warn");
    });

    it("another ruleset without the bypass still holds the rule", () => {
      const strict = { ...branch([admin]), name: "strict" };
      assert.equal(checkUpdateRule([branch([app]), strict], opts).status, "pass");
    });
  });

  it("trees: a merge conflict in an unrelated file does not break the comparison", () => {
    const dir = makeConsumer("conflict", { files: { "notes.txt": "base\n" } });
    git(dir, "checkout", "-q", "-b", "other");
    writeFileSync(join(dir, "notes.txt"), "other\n");
    git(dir, "commit", "-qam", "other");
    git(dir, "checkout", "-q", "-");
    writeFileSync(join(dir, "notes.txt"), "main\n");
    git(dir, "commit", "-qam", "main");
    const merge = systemRunner("git", ["-C", dir, ...GIT_ID, "merge", "-q", "other"]);
    assert.notEqual(merge.status, 0, "the fixture merge should conflict");
    assert.match(systemRunner("git", ["-C", dir, "ls-files", "-u"]).stdout, /notes\.txt/);
    const report = runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag });
    const trees = report.results.find((r) => r.id === "kit-owned-trees");
    assert.equal(trees.status, "pass", JSON.stringify(trees));
  });

  it("trees: paths outside a sparse-checkout cone are skipped, not missing", () => {
    const dir = makeConsumer("sparse");
    git(dir, "sparse-checkout", "set", "--cone", ".github/workflows");
    assert.equal(existsSync(join(dir, ".github/agent-runtime")), false, "fixture should be sparse");
    const report = runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag });
    const trees = report.results.find((r) => r.id === "kit-owned-trees");
    assert.equal(trees.status, "skip", JSON.stringify(trees));
    assert.ok(
      trees.details.some((d) =>
        /agent-runtime\/: not checked, outside the sparse-checkout cone/.test(d),
      ),
    );
    assert.doesNotMatch(trees.details.join("\n"), /missing/);
    assert.equal(report.exitCode, 0);
  });

  it("parser: a || fallback on the next line keeps the variable optional", () => {
    const refs = variableRefs("model: ${{ vars.CLAUDE_MODEL_PLAN\n  || 'claude-opus-5' }}\n");
    assert.deepEqual(refs, [{ name: "CLAUDE_MODEL_PLAN", optional: true }]);
  });

  it("parser: flow-mapping, anchor and alias secrets are reported as unreadable, not failed", () => {
    const uses = `${KIT}/.github/workflows/agent-plan-reusable.yml@${TAG}`;
    for (const secrets of [
      "{ claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }} }",
      "*shared",
      "&shared\n      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    ]) {
      const caller = parseCaller(`jobs:\n  plan:\n    uses: ${uses}\n    secrets: ${secrets}\n`);
      assert.ok(caller.jobs[0].secretsUnsupported, secrets);
      const req = deriveRequirements([{ path: "c.yml", ...caller }], reusable);
      assert.deepEqual(req.problems, [], secrets);
      assert.equal(req.unsupported.length, 1);
      const r = checkSecrets({
        github: { getLines: () => ["CLAUDE_CODE_OAUTH_TOKEN"] },
        repo: "acme/app",
        ownerType: "User",
        requirements: req,
      });
      assert.equal(r.status, "skip", secrets);
    }
  });

  it("pins: owner names compare case-insensitively", () => {
    const pin = (repo) => ({ repo, file: "agent-plan-reusable.yml", ref: TAG, line: 1 });
    const r = checkPins([
      { path: "a.yml", pins: [pin("MnaimFaizy/agent-kit"), pin("mnaimfaizy/agent-kit")] },
    ]);
    assert.equal(r.result.status, "pass");
  });

  it("pins: a uses: line inside a run: block is not a pin", () => {
    const text = [
      "jobs:",
      "  plan:",
      `    uses: ${KIT}/.github/workflows/agent-plan-reusable.yml@${TAG}`,
      "  other:",
      "    steps:",
      "      - run: |",
      `          uses: ${KIT}/.github/workflows/agent-plan-reusable.yml@main`,
      "      - name: after",
      "        run: >-",
      `          uses: ${KIT}/.github/workflows/x.yml@main`,
      `      - uses: ${KIT}/.github/workflows/agent-plan-reusable.yml@${TAG}`,
    ].join("\n");
    assert.deepEqual(
      findKitPins(text).map((p) => [p.line, p.ref]),
      [
        [3, TAG],
        [11, TAG],
      ],
    );
  });

  it("messages: the tree failure points to adopt.md's manual copy until upgrade ships", () => {
    const dir = makeConsumer("message");
    writeFileSync(join(dir, ".github/agent-runtime/hook.mjs"), "edited\n");
    const report = runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag });
    const trees = report.results.find((r) => r.id === "kit-owned-trees");
    const url = `https://github.com/${KIT}/blob/${TAG}/docs/adopt.md#copy-kit-owned-paths-from-the-same-tag`;
    assert.ok(
      trees.details.some((d) => d.includes(url)),
      trees.details.join("\n"),
    );
  });

  it("messages: printed gh variable commands paste cleanly", () => {
    const r = checkVariables({
      github: { getLines: () => [] },
      repo: "acme/app",
      ownerType: "User",
      requirements: {
        variables: [
          { name: "CLAUDE_PIPELINE_ENABLED", optional: false, where: ["c.yml"] },
          { name: "OTHER", optional: false, where: ["c.yml"] },
        ],
      },
    });
    assert.deepEqual(r.fix, [
      "gh variable set CLAUDE_PIPELINE_ENABLED --repo acme/app --body true",
      "gh variable set OTHER --repo acme/app",
    ]);
    for (const f of r.fix) assert.doesNotMatch(f, /[<>]/);
  });

  it("labels: a Caller that leaves trigger_label out uses the reusable's default", () => {
    const uses = (file) => `${KIT}/.github/workflows/${file}@${TAG}`;
    const caller = parseCaller(
      [
        "jobs:",
        "  plan:",
        `    uses: ${uses("agent-plan-reusable.yml")}`,
        "  audit:",
        `    uses: ${uses("security-audit-reusable.yml")}`,
        "  review:",
        `    uses: ${uses("agent-review-reusable.yml")}`,
        "    with:",
        '      trigger_label: "custom:review"',
        "",
      ].join("\n"),
    );
    const labels = triggerLabels([{ path: "c.yml", ...caller }], reusable);
    assert.deepEqual(
      labels.map((l) => [l.name, l.where]),
      [
        ["agent:plan", ["c.yml:plan (default)"]],
        ["custom:review", ["c.yml:review"]],
      ],
    );
  });

  it("labels: doctor fails when a default Trigger label is missing", () => {
    const caller = callerFor(TAG).replace('      trigger_label: "agent:plan"\n', "");
    const dir = makeConsumer("default-label", {
      files: { ".github/workflows/caller.yml": caller },
    });
    const { runner } = fakeGh({ ...ALL_GOOD, "repos/acme/app/labels": ["bug"] });
    const report = runDoctor({ cwd: dir, runner, openTag });
    const labels = report.results.find((r) => r.id === "trigger-labels");
    assert.equal(labels.status, "fail", JSON.stringify(labels));
    assert.match(labels.details.join("\n"), /agent:plan \(.*\(default\)\)/);
  });
});
