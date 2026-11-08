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
import {
  findKitPins,
  parseCaller,
  parseKitUses,
  readWorkflows,
  variableRefs,
} from "../cli/src/callers.mjs";
import { checkLabels, triggerLabels } from "../cli/src/checks/labels.mjs";
import { command, sanitizeLine, shellQuote } from "../cli/src/checks/result.mjs";
import { checkPins } from "../cli/src/checks/pins.mjs";
import {
  checkCreationRule,
  checkTagRuleset,
  checkUpdateRule,
  coversRef,
  fnmatchToRegExp,
  riskyBypassActors,
  workflowsPushingTagsWithToken,
} from "../cli/src/checks/rulesets.mjs";
import {
  checkSecrets,
  checkVariables,
  deriveRequirements,
} from "../cli/src/checks/secrets-and-variables.mjs";
import { main } from "../cli/src/cli.mjs";
import { formatReport, guarded, LOCAL_ONLY_CHECKS, runDoctor } from "../cli/src/doctor.mjs";
import { firstLine, systemRunner } from "../cli/src/exec.mjs";
import { parseKitOwnedPaths } from "../cli/src/kit-owned-paths.mjs";
import { openKitTag, PreManifestTagError } from "../cli/src/kit-tag.mjs";
import { filterDrivers, localTreeHashes } from "../cli/src/local-tree.mjs";
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
    if (args[1] === "--hostname") args = [args[0], ...args.slice(3)];
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
    bypass_actors: [],
  }),
  "repos/acme/app/rulesets/2": JSON.stringify({
    enforcement: "active",
    target: "branch",
    conditions: { ref_name: { include: ["refs/heads/release/**/*"], exclude: [] } },
    rules: [{ type: "creation" }],
    bypass_actors: [],
  }),
  "repos/acme/app/rulesets/3": JSON.stringify({
    enforcement: "active",
    target: "tag",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
    bypass_actors: [],
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
      conditions: {
        ref_name: { include: ["~DEFAULT_BRANCH", "refs/heads/release/**/*"], exclude: [] },
      },
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

  it("trees: skip-worktree paths are compared against HEAD, not reported missing", () => {
    const dir = makeConsumer("sparse");
    git(dir, "sparse-checkout", "set", "--cone", ".github/workflows");
    assert.equal(existsSync(join(dir, ".github/agent-runtime")), false, "fixture should be sparse");
    const report = runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag });
    const trees = report.results.find((r) => r.id === "kit-owned-trees");
    assert.equal(trees.status, "pass", JSON.stringify(trees));
    assert.ok(trees.details.some((d) => /agent-runtime\/: .*copy committed at HEAD/.test(d)));
    assert.doesNotMatch(trees.details.join("\n"), /missing/);
  });

  it("trees: a skip-worktree path HEAD does not have is skipped, never passed", () => {
    const dir = makeConsumer("skip-worktree");
    // A new Kit-owned path, staged but not committed, then marked skip-worktree.
    mkdirSync(join(dir, ".github/agent-runtime/new"), { recursive: true });
    writeFileSync(join(dir, ".github/agent-runtime/new/x.md"), "x\n");
    rmSync(join(dir, ".github/agent-runtime"), { recursive: true });
    git(dir, "rm", "-rq", "--cached", ".github/agent-runtime");
    git(dir, "commit", "-qm", "drop runtime");
    mkdirSync(join(dir, ".github/agent-runtime"), { recursive: true });
    writeFileSync(join(dir, ".github/agent-runtime/hook.mjs"), "export const x = 1;\n");
    git(dir, "add", ".github/agent-runtime/hook.mjs");
    git(dir, "update-index", "--skip-worktree", ".github/agent-runtime/hook.mjs");
    rmSync(join(dir, ".github/agent-runtime"), { recursive: true });
    const report = runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag });
    const trees = report.results.find((r) => r.id === "kit-owned-trees");
    assert.equal(trees.status, "skip", JSON.stringify(trees));
    assert.ok(trees.details.some((d) => /agent-runtime\/: not checked, .*skip-worktree/.test(d)));
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
    const { labels, unknown } = triggerLabels([{ path: "c.yml", ...caller }], reusable);
    assert.deepEqual(unknown, []);
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
    assert.match(labels.details.join("\n"), /"agent:plan" \(.*\(default\)\)/);
  });
});

describe("hardening (PR #78, second review)", () => {
  const reusable = (file) => readRepo(".github/workflows", file);
  const uses = (file, owner = KIT) => `${owner}/.github/workflows/${file}@${TAG}`;
  // Values a hostile tag or Caller could carry, aimed at bash and at PowerShell.
  const HOSTILE = [
    "X$(touch pwned)",
    "X`touch pwned`",
    "X'; touch pwned; '",
    "X' ; Remove-Item -Recurse . ; '",
    "X''; calc; ''",
    "X; touch pwned",
    "X | touch pwned",
    "X\\' $(id)",
    "-X",
  ];
  const assertSafeCommands = (fix) => {
    for (const f of fix) {
      // Every argument is either a plain word or single-quoted without a quote inside.
      assert.match(
        f,
        /^(?:[A-Za-z0-9_.:/@=+-]+|'[^']*')(?: (?:[A-Za-z0-9_.:/@=+-]+|'[^']*'))*$/,
        f,
      );
      assert.doesNotMatch(f, /[$`;|&<>()\\]/, f);
    }
  };

  describe("printed fix commands", () => {
    it("secret names from a tag's workflow_call block are validated before printing", () => {
      const keys = HOSTILE.map(
        (h, i) => `      "${h.replace(/"/g, "")}${i}":\n        required: true`,
      );
      const text = `on:\n  workflow_call:\n    secrets:\n${keys.join("\n")}\n      good_one:\n        required: true\njobs: {}\n`;
      const caller = parseCaller(
        `jobs:\n  plan:\n    uses: ${uses("agent-plan-reusable.yml")}\n    secrets: inherit\n`,
      );
      const req = deriveRequirements([{ path: "c.yml", ...caller }], () => text);
      assert.ok(req.secrets.length > HOSTILE.length - 1);
      const r = checkSecrets({
        github: { getLines: () => [] },
        repo: "acme/app",
        ownerType: "User",
        requirements: req,
      });
      assert.equal(r.status, "fail");
      assertSafeCommands(r.fix);
      assert.deepEqual(r.fix, ["gh secret set GOOD_ONE --repo acme/app"]);
      assert.ok(r.details.some((d) => d.startsWith("fix by hand: secret named ")));
    });

    it("label names are allowlisted; anything else becomes a by-hand note", () => {
      const callers = HOSTILE.map((h, i) => ({
        path: `c${i}.yml`,
        jobs: [
          {
            name: "plan",
            uses: parseKitUses(uses("agent-plan-reusable.yml")),
            with: { trigger_label: h },
          },
        ],
      }));
      callers.push({
        path: "ok.yml",
        jobs: [
          {
            name: "plan",
            uses: parseKitUses(uses("agent-plan-reusable.yml")),
            with: { trigger_label: "agent: plan/v1.0_x-y" },
          },
        ],
      });
      const r = checkLabels({ github: { getLines: () => [] }, repo: "acme/app", callers });
      assert.equal(r.status, "fail");
      assertSafeCommands(r.fix);
      assert.deepEqual(r.fix, ["gh label create 'agent: plan/v1.0_x-y' --repo acme/app"]);
      assert.equal(
        r.details.filter((d) => d.startsWith("fix by hand: create the label ")).length,
        HOSTILE.length,
      );
    });

    it("command() refuses a value with a quote, and quoting never needs escapes", () => {
      assert.throws(() => command("gh", "label", "create", "a'b"));
      assert.equal(command("gh", "label", "create", "a b"), "gh label create 'a b'");
      assert.equal(shellQuote("agent:plan"), "agent:plan");
    });

    it("the report says once that printed commands are POSIX shell", () => {
      const report = {
        mode: "local",
        modeReason: null,
        repo: "acme/app",
        tag: TAG,
        refusal: null,
        exitCode: 1,
        results: [
          {
            id: "a",
            title: "A",
            status: "fail",
            summary: "s",
            details: [],
            fix: ["gh label create x"],
          },
          {
            id: "b",
            title: "B",
            status: "fail",
            summary: "s",
            details: [],
            fix: ["gh label create y"],
          },
        ],
      };
      const text = formatReport(report);
      assert.equal(text.match(/POSIX shell/g).length, 1);
    });
  });

  describe("output sanitizing", () => {
    it("escapes control characters and blocks CI log commands in every printed line", () => {
      const evil = "a\u001b[31mred\u0007\rb\nc::set-env name=X::y\u0085d\u2028e";
      const report = {
        mode: "local",
        modeReason: `reason ${evil}`,
        repo: "acme/app",
        tag: TAG,
        refusal: null,
        exitCode: 1,
        results: [
          {
            id: "x",
            title: `T ${evil}`,
            status: "fail",
            summary: evil,
            details: [evil, "::error::boom", "  ##[warning]w"],
            fix: [],
          },
        ],
      };
      const text = formatReport(report);
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(text.replace(/\n/g, ""), /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      for (const line of text.split("\n")) {
        assert.doesNotMatch(line.trimStart(), /^(?:::|##\[)/, line);
      }
      assert.match(text, /\\u001b\[31mred/);
      assert.equal(sanitizeLine("::error::x"), "\\::error::x");
    });

    it("main() sanitizes usage errors that echo an argument", () => {
      const out = [];
      main(["doctor", "--repo", "a/b\u001b]0;x\u0007"], {
        cwd: ".",
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        runner: () => ({ status: 1, stdout: "", stderr: "" }),
      });
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(out.join(""), /[\u0000-\u0009\u000b-\u001f]/);
    });
  });

  describe("git runs nothing the checkout configures", () => {
    it("a configured clean filter is not run while hashing", () => {
      const dir = makeConsumer("filter");
      writeFileSync(join(dir, ".gitattributes"), "*.mjs filter=probe\n");
      git(dir, "add", ".gitattributes");
      git(dir, "commit", "-qm", "attributes");
      git(dir, "config", "filter.probe.clean", "echo ran > probe-ran.txt; cat");
      git(dir, "config", "filter.probe.required", "true");
      // A fresh write, so git has to read the file again.
      writeFileSync(join(dir, ".github/agent-runtime/hook.mjs"), "export const x = 1;\n");
      const report = runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag });
      assert.equal(existsSync(join(dir, "probe-ran.txt")), false, "the filter ran");
      assert.equal(report.results.find((r) => r.id === "kit-owned-trees").status, "pass");
    });

    it("filterDrivers reads driver names from git config keys", () => {
      assert.deepEqual(
        filterDrivers(["filter.lfs.clean", "filter.lfs.smudge", "filter.a.b.process", "core.x"]),
        ["lfs", "a.b"],
      );
    });
  });

  describe("edge cases", () => {
    it("1: a UTF-8 BOM does not hide a Caller's jobs", () => {
      const text = `\ufeff${callerFor(TAG)}`;
      const c = parseCaller(text);
      assert.equal(c.jobs.length, 1);
      assert.equal(c.parseIncomplete, null);
      const dir = makeConsumer("bom", { files: { ".github/workflows/caller.yml": text } });
      const files = readWorkflows(dir);
      assert.equal(files.callers[0].jobs.length, 1);
    });

    it("1: pins the parser cannot match to jobs make secrets and labels skip, not pass", () => {
      const text = `jobs:
  plan: &shared
    uses: ${uses("agent-plan-reusable.yml")}
`;
      const c = parseCaller(text);
      assert.ok(c.parseIncomplete, JSON.stringify(c));
      const callers = [{ path: "c.yml", ...c }];
      const req = deriveRequirements(callers, reusable);
      const s = checkSecrets({
        github: { getLines: () => ["CLAUDE_CODE_OAUTH_TOKEN"] },
        repo: "acme/app",
        ownerType: "User",
        requirements: req,
      });
      assert.notEqual(s.status, "pass");
      const l = checkLabels({
        github: { getLines: () => ["agent:plan"] },
        repo: "acme/app",
        callers,
        readReusable: reusable,
      });
      assert.notEqual(l.status, "pass");
    });

    it("2: Kit-owned files force-added under an ignored folder still compare", () => {
      const dir = makeConsumer("ignored-dir");
      writeFileSync(join(dir, ".gitignore"), ".github/agent-runtime/\n");
      git(dir, "add", ".gitignore");
      git(dir, "commit", "-qm", "ignore");
      let report = runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag });
      assert.equal(report.results.find((r) => r.id === "kit-owned-trees").status, "pass");
      writeFileSync(join(dir, ".github/agent-runtime/hook.mjs"), "edited\n");
      report = runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag });
      const trees = report.results.find((r) => r.id === "kit-owned-trees");
      assert.equal(trees.status, "fail");
      assert.match(trees.details[0], /agent-runtime\/: differs/);
    });

    it("3: firstLine prefers the real error over warning and hint lines", () => {
      const stderr =
        "warning: in the working copy of 'a', LF will be replaced by CRLF\r\nhint: x\r\nfatal: the real problem\r\n";
      assert.equal(firstLine(stderr), "fatal: the real problem");
      assert.equal(firstLine("warning: w\r\nsomething else\n"), "something else");
      assert.equal(firstLine("warning: only\n"), "warning: only");
    });

    it("4: owner and repository names match case-insensitively", () => {
      const pin = parseKitUses(
        "MnaimFaizy/Agent-Kit/.github/workflows/agent-plan-reusable.yml@v1.0.0",
      );
      assert.equal(pin.repo, "MnaimFaizy/Agent-Kit");
      const r = checkPins([
        {
          path: "a.yml",
          pins: [
            { ...pin, line: 1 },
            { ...parseKitUses(uses("agent-plan-reusable.yml").replace(TAG, "v1.0.0")), line: 2 },
          ],
        },
      ]);
      assert.equal(r.result.status, "pass");
    });

    it("5: a default Trigger label that cannot be read is skipped, not passed", () => {
      const caller = parseCaller(`jobs:\n  plan:\n    uses: ${uses("agent-plan-reusable.yml")}\n`);
      const r = checkLabels({
        github: { getLines: () => [] },
        repo: "acme/app",
        callers: [{ path: "c.yml", ...caller }],
        readReusable: null,
      });
      assert.equal(r.status, "skip");
      const r2 = checkLabels({
        github: { getLines: () => [] },
        repo: "acme/app",
        callers: [{ path: "c.yml", ...caller }],
        readReusable: () => null,
      });
      assert.equal(r2.status, "skip");
    });

    it("6: GITHUB_* secrets are always set", () => {
      const caller = parseCaller(
        `jobs:\n  plan:\n    uses: ${uses("security-audit-reusable.yml")}\n    secrets:\n      advisories_token: \${{ secrets.GITHUB_TOKEN }}\n      claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n      dependabot_alerts_token: \${{ secrets.X || secrets.github_token }}\n`,
      );
      const req = deriveRequirements([{ path: "c.yml", ...caller }], reusable);
      assert.deepEqual(
        req.secrets.map((s) => s.names),
        [["CLAUDE_CODE_OAUTH_TOKEN"]],
      );
    });

    it("7: ruleset patterns use fnmatch with FNM_PATHNAME", () => {
      const cases = [
        ["refs/tags/**/*", "refs/tags/v1.0.0", true],
        ["refs/heads/**/*", "refs/heads/main", true],
        ["refs/heads/release/**/*", "refs/heads/release/1.0", true],
        ["refs/heads/release/**/*", "refs/heads/release/a/b", true],
        ["refs/tags/v[0-9]*", "refs/tags/v1.0.0", true],
        ["refs/tags/v[0-9]*", "refs/tags/vx", false],
        ["refs/tags/v[!0-9]*", "refs/tags/vx", true],
        ["refs/heads/release/*", "refs/heads/release/a/b", false],
        ["refs/heads/a.b", "refs/heads/axb", false],
        ["refs/heads/?ain", "refs/heads/main", true],
      ];
      for (const [pattern, ref, expected] of cases) {
        assert.equal(fnmatchToRegExp(pattern).test(ref), expected, `${pattern} vs ${ref}`);
      }
    });

    it("8: doctor reads a manifest with a path shape the CLI does not know; deletion code does not", () => {
      const text = "docs/extra/\n.github/agent-runtime/\n";
      assert.deepEqual(parseKitOwnedPaths(text, { forDeletion: false }), [
        "docs/extra/",
        ".github/agent-runtime/",
      ]);
      assert.throws(() => parseKitOwnedPaths(text));
      for (const bad of ["../x/\n", "./x/\n", "a/../b/\n", "/abs/\n", "a b/\n"]) {
        assert.throws(() => parseKitOwnedPaths(bad, { forDeletion: false }), bad);
      }
    });

    it("9: quoted and spaced uses keys are pins", () => {
      const text = [
        "jobs:",
        "  a:",
        `    "uses": ${uses("agent-plan-reusable.yml")}`,
        "  b:",
        `    uses : ${uses("agent-plan-reusable.yml")}`,
      ].join("\n");
      assert.equal(findKitPins(text).length, 2);
      assert.equal(parseCaller(text).jobs.length, 2);
    });

    it("11: a parenthesised read before || is optional", () => {
      const refs = variableRefs(
        "a: ${{ (vars.X) || 'x' }}\nb: ${{ ( vars.Y ) || 'y' }}\nc: ${{ (vars.Z) }}\n",
      );
      assert.deepEqual(Object.fromEntries(refs.map((v) => [v.name, v.optional])), {
        X: true,
        Y: true,
        Z: false,
      });
    });
  });

  describe("plausible cases degrade honestly", () => {
    it("a ruleset whose bypass list is not visible is not treated as clean", () => {
      const rs = {
        name: "org rule",
        enforcement: "active",
        target: "branch",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [{ type: "update" }],
      };
      const r = checkUpdateRule([rs], { defaultBranch: "main" });
      assert.equal(r.status, "warn");
      assert.match(r.details.join("\n"), /bypass list not visible to this login/);
    });

    it("GitHub Enterprise Server: gh api targets the repository's host", () => {
      const dir = makeConsumer("ghe");
      const seen = [];
      const runner = (cmd, args, opts) => {
        if (cmd === "git") return systemRunner(cmd, args, opts);
        seen.push(args);
        if (args[0] === "repo") {
          return ok(
            JSON.stringify({
              nameWithOwner: "acme/app",
              isInOrganization: true,
              viewerPermission: "ADMIN",
              defaultBranchRef: { name: "main" },
              url: "https://ghe.example.com/acme/app",
            }),
          );
        }
        return { status: 1, stdout: "", stderr: "HTTP 404" };
      };
      let server = null;
      const tagOpener = (o) => {
        server = o.serverUrl;
        return openTag(o);
      };
      runDoctor({ cwd: dir, runner, openTag: tagOpener });
      assert.equal(server, "https://ghe.example.com");
      const api = seen.filter((a) => a[0] === "api");
      assert.ok(api.length > 0);
      for (const a of api) assert.deepEqual(a.slice(1, 3), ["--hostname", "ghe.example.com"]);
    });

    it("CI mode on GitHub Enterprise Server fetches from GITHUB_SERVER_URL", () => {
      const dir = makeConsumer("ghe-ci");
      let server = null;
      runDoctor({
        cwd: dir,
        runner: systemRunner,
        ci: true,
        env: { GITHUB_SERVER_URL: "https://ghe.example.com" },
        openTag: (o) => ((server = o.serverUrl), openTag(o)),
      });
      assert.equal(server, "https://ghe.example.com");
      runDoctor({
        cwd: dir,
        runner: systemRunner,
        ci: true,
        env: { GITHUB_SERVER_URL: "https://evil.example.com/../x" },
        openTag: (o) => ((server = o.serverUrl), openTag(o)),
      });
      assert.equal(server, "https://github.com");
    });

    it("the creation rule must cover a release branch, and the tag ruleset a pre-release tag", () => {
      const branchOnly = {
        name: "main only",
        enforcement: "active",
        target: "branch",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [{ type: "creation" }],
        bypass_actors: [],
      };
      const c = checkCreationRule([branchOnly]);
      assert.equal(c.status, "warn");
      assert.match(c.summary, /none covers a release/);
      const stableOnly = {
        name: "stable tags",
        enforcement: "active",
        target: "tag",
        conditions: { ref_name: { include: ["refs/tags/v*"], exclude: ["refs/tags/v*-*"] } },
        rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
        bypass_actors: [],
      };
      const t = checkTagRuleset([stableOnly]);
      assert.equal(t.status, "warn");
      assert.match(t.summary, /v1\.0\.0-alpha\.1/);
    });

    it("the variables check runs without the tag", () => {
      const dir = makeConsumer("vars-no-tag", {
        files: { ".github/workflows/other.yml": callerFor("v1.0.0-alpha.11") },
      });
      const { runner } = fakeGh({ ...ALL_GOOD, "repos/acme/app/actions/variables": [] });
      const report = runDoctor({ cwd: dir, runner, openTag });
      assert.equal(report.results.find((r) => r.id === "pins").status, "fail");
      const vars = report.results.find((r) => r.id === "variables");
      assert.equal(vars.status, "fail", JSON.stringify(vars));
      assert.equal(report.results.find((r) => r.id === "secrets").status, "skip");
    });

    it("the local tree hash works from a linked worktree (objects in the common dir)", () => {
      const dir = makeConsumer("worktree-main");
      const wt = join(tmp, "worktree-linked");
      git(dir, "worktree", "add", "-q", wt);
      const report = runDoctor({ cwd: wt, runner: systemRunner, ci: true, openTag });
      assert.equal(report.results.find((r) => r.id === "kit-owned-trees").status, "pass");
    });
  });
});

describe("re-audit fixes (PR #78)", () => {
  const branchRuleset = (include, extra = {}) => ({
    name: "rs",
    enforcement: "active",
    target: "branch",
    conditions: { ref_name: { include, exclude: [] } },
    rules: [{ type: "update" }],
    bypass_actors: [],
    ...extra,
  });

  it("A: a ruleset pattern that cannot be interpreted is noted, not a crash", () => {
    const bad = branchRuleset(["refs/heads/[z-a]"], { name: "broken" });
    assert.doesNotThrow(() => coversRef(bad, "refs/heads/main"));
    assert.equal(coversRef(bad, "refs/heads/main"), false);
    const alone = checkUpdateRule([bad], { defaultBranch: "main" });
    assert.equal(alone.status, "warn");
    assert.match(
      alone.details.join("\n"),
      /"broken": pattern "refs\/heads\/\[z-a\]" could not be interpreted/,
    );
    // Rulesets only add restrictions: another one that holds the rule still passes.
    const held = checkUpdateRule([bad, branchRuleset(["~DEFAULT_BRANCH"])], {
      defaultBranch: "main",
    });
    assert.equal(held.status, "pass");
    assert.match(held.details.join("\n"), /could not be interpreted/);
  });

  it("A: a check that throws becomes a FAIL and the other checks still report", () => {
    assert.equal(
      guarded("x", () => {
        throw new Error("boom\nmore");
      }).summary,
      "Check crashed: boom",
    );
    const dir = makeConsumer("crash");
    const { runner } = fakeGh({
      ...ALL_GOOD,
      "repos/acme/app/rulesets?includes_parents=true": ["1"],
      "repos/acme/app/rulesets/1": JSON.stringify(
        branchRuleset(["~DEFAULT_BRANCH"], { rules: "bogus" }),
      ),
    });
    const report = runDoctor({ cwd: dir, runner, openTag });
    const update = report.results.find((r) => r.id === "ruleset-update");
    assert.equal(update.status, "fail");
    assert.match(update.summary, /^Check crashed: /);
    assert.ok(
      report.results.find((r) => r.id === "release-tag-push"),
      "later checks still ran",
    );
    assert.equal(report.exitCode, 1);
  });

  describe("B: one skip-worktree file does not hide the rest of the path", () => {
    const prepare = (name) => {
      const dir = makeConsumer(name);
      git(dir, "update-index", "--skip-worktree", ".claude/skills/code-review/SKILL.md");
      rmSync(join(dir, ".claude/skills/code-review/SKILL.md"));
      return dir;
    };
    const trees = (dir) =>
      runDoctor({ cwd: dir, runner: systemRunner, ci: true, openTag }).results.find(
        (r) => r.id === "kit-owned-trees",
      );

    it("passes when the other files match, saying how it compared", () => {
      const t = trees(prepare("mixed-clean"));
      assert.equal(t.status, "pass", JSON.stringify(t));
      assert.match(t.details.join("\n"), /code-review\/: 1 of its files are marked skip-worktree/);
    });

    it("fails on a local edit elsewhere in the path", () => {
      const dir = prepare("mixed-edit");
      writeFileSync(join(dir, ".claude/skills/code-review/notes/a.md"), "edited\n");
      assert.equal(trees(dir).status, "fail");
    });

    it("fails on a new untracked file elsewhere in the path", () => {
      const dir = prepare("mixed-new");
      writeFileSync(join(dir, ".claude/skills/code-review/stale.md"), "old\n");
      assert.equal(trees(dir).status, "fail");
    });
  });

  it("C: fork pins pass with a detail line, so --strict can pass", () => {
    const pin = (repo) => ({ repo, file: "agent-plan-reusable.yml", ref: TAG, line: 1 });
    const r = checkPins([{ path: "a.yml", pins: [pin("acme/agent-kit")] }]);
    assert.equal(r.result.status, "pass");
    assert.equal(
      r.result.details[0],
      "The pins name acme/agent-kit, not mnaimfaizy/agent-kit; the Kit-owned path checks compare against that repository.",
    );
    assert.equal(r.repo, "acme/agent-kit");
  });

  it("read-only manifest parsing refuses a .git segment", () => {
    for (const bad of [".git/\n", ".git/hooks/\n", "a/.GIT/b/\n", "x/.Git/\n"]) {
      assert.throws(() => parseKitOwnedPaths(bad, { forDeletion: false }), bad);
    }
    assert.deepEqual(parseKitOwnedPaths(".gitx/\n", { forDeletion: false }), [".gitx/"]);
  });
});
