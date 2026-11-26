// Contract for `agent-kit deep-scan` (cli/): the Verification run (--verify).
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../cli/src/cli.mjs";
import {
  git,
  VALID,
  tmp,
  REAL_KEY,
  run,
  fakeTimers,
  recipeRepo,
  recipe,
  lifecycle,
  stdinOf,
  tarEntries,
  isAgentStep,
  isSetupStep,
  isCopyIn,
  removed,
  sbxCalls,
  sbxHost,
  agentCall,
  claudeLine,
  briefOf,
  MINUTE,
  reportOf,
  FINDINGS,
  VERIFY_REPORT,
  findingFile,
  verifyRepo,
  verifyHost,
  verifyArgs,
  copiedIn,
  copyInIndexOf,
  flagValues,
} from "./cli-deep-scan-fixtures.mjs";

describe("--verify: a Verification run re-attempts known findings on a ref you name", () => {
  it("exports the named ref, never the default branch or the working tree, and exits 0", async () => {
    const res = await run(verifyRepo(), verifyArgs(), { host: verifyHost() });
    assert.equal(res.code, 0, res.text);
    const tree = tarEntries(stdinOf(res, isCopyIn));
    const upload = tree.find((e) => e.name === "workspace/src/upload.js");
    assert.equal(upload.data.toString("utf8"), "fixed\n");
    assert.match(
      res.out,
      /Copied in: fix\/upload at [0-9a-f]{12} \(a git archive, not your working tree\)/,
    );
    assert.match(res.out, /Verification run: 2 finding\(s\) from .*findings\.md, on fix\/upload/);
    assert.match(res.out, /Teardown: removed/);
  });

  it("takes any local commit-ish: a tag or a commit id", async () => {
    const dir = verifyRepo();
    git(dir, "tag", "fix-tag", "fix/upload");
    const sha = git(dir, "rev-parse", "fix/upload");
    for (const ref of ["fix-tag", sha]) {
      const res = await run(dir, verifyArgs(findingFile(), ref), { host: verifyHost() });
      assert.equal(res.code, 0, `${ref}: ${res.text}`);
      const tree = tarEntries(stdinOf(res, isCopyIn));
      assert.equal(
        tree.find((e) => e.name === "workspace/src/upload.js").data.toString("utf8"),
        "fixed\n",
      );
    }
  });

  it("reads the Scan recipe, the skill and the Threat pack from the default branch, not the ref", async () => {
    const dir = verifyRepo({
      fix: {
        ".security/scan-recipe.yml": "not: a recipe\n",
        ".security/threat-model.md": "# fix branch's threat model\n",
      },
    });
    const res = await run(dir, verifyArgs(), { host: verifyHost() });
    assert.equal(res.code, 0, res.text);
    assert.match(
      res.out,
      /Scan recipe \.security\/scan-recipe\.yml on main \([0-9a-f]{12}\) is valid/,
    );
    const brief = briefOf(res);
    assert.ok(brief.includes("# Threat model marker"));
    assert.ok(!brief.includes("fix branch's threat model"));
  });

  it("copies the finding file in with the brief, after the network is cut and the model route opens", async () => {
    const res = await run(verifyRepo(), verifyArgs(), { host: verifyHost() });
    assert.equal(res.code, 0, res.text);
    const findings = copiedIn(res).filter((e) => e.name === "agent-kit/in/findings.md");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.toString("utf8"), FINDINGS);
    const calls = lifecycle(res);
    const connect = calls.findIndex((x) => flagValues(x, "--name")[0]?.endsWith("-probe-model"));
    const at = copyInIndexOf(res, "agent-kit/in/findings.md");
    assert.equal(at, copyInIndexOf(res, "agent-kit/in/brief.md"));
    assert.ok(connect >= 0 && at > connect, `copied in at ${at}, the model route at ${connect}`);
    assert.ok(at < calls.findIndex(isAgentStep));
    assert.ok(calls.findIndex(isSetupStep) < connect);
  });

  it("hands the agent the Verification-run procedure, not the full deep procedure", async () => {
    const res = await run(verifyRepo(), verifyArgs(), { host: verifyHost() });
    assert.equal(res.code, 0, res.text);
    const brief = briefOf(res);
    for (const needed of [
      "Verification run",
      "## Hard rules",
      "**Never deliver.**",
      "1. Confirm you are inside the launcher's sandbox.",
      "2. Read the Threat pack and the Scan recipe.",
      "6. Write the report early",
      "## Verification-run variant",
      "`/agent-kit/in/findings.md`",
      "`upload-path-traversal` at `src/upload.js:42`",
      "`admin-missing-role-check` at `src/admin.js:7`",
      "`fix/upload`",
      "`/agent-kit/out/report.md`",
      "# Threat model marker",
      "entry_points:",
    ]) {
      assert.ok(brief.includes(needed), `the brief has ${needed}`);
    }
    for (const absent of [
      "3. Run the `full` walk",
      "5. Probe further",
      "# security-audit SKILL marker",
      "run the security-audit skill in `deep` mode",
    ]) {
      assert.ok(!brief.includes(absent), `the brief leaves out ${absent}`);
    }
    assert.match(res.out, /handed the Verification-run procedure/);
  });

  it("runs with the Verification-run limits: scan 15 min, 50 turns, the same token cap", async () => {
    const timers = fakeTimers();
    const res = await run(verifyRepo(), verifyArgs(), { host: verifyHost(), timers });
    assert.equal(res.code, 0, res.text);
    assert.match(claudeLine(agentCall(lifecycle(res))), / --max-turns 50 /);
    assert.deepEqual(
      timers.set.map((t) => t.ms),
      [20 * MINUTE, 15 * MINUTE],
    );
    assert.match(res.out, /Limits: setup 20 min, scan 15 min, 50 turns, 5000000 tokens/);
    assert.match(res.out, /counted 0 of the 5000000-token cap/);
  });

  it("still takes each limit from its flag", async () => {
    const timers = fakeTimers();
    const res = await run(
      verifyRepo(),
      [...verifyArgs(), "--scan-minutes", "30", "--max-turns", "80"],
      { host: verifyHost(), timers },
    );
    assert.equal(res.code, 0, res.text);
    assert.match(claudeLine(agentCall(lifecycle(res))), / --max-turns 80 /);
    assert.deepEqual(
      timers.set.map((t) => t.ms),
      [20 * MINUTE, 30 * MINUTE],
    );
  });

  it("writes the report only to the local private path, and files or posts nothing", async () => {
    const res = await run(verifyRepo(), verifyArgs(), { host: verifyHost() });
    assert.equal(res.code, 0, res.text);
    assert.equal(reportOf(res), VERIFY_REPORT);
    assert.match(res.out, /Report: .*report\.md/);
    assert.match(res.out, /Nothing was filed or posted/);
    assert.match(res.out, /stays on your machine: file no advisory, comment or ledger note/);
    assert.doesNotMatch(res.out, /by-hand rule/);
    assert.ok(
      res.calls.every((c) => c[0] !== "gh"),
      "no gh call",
    );
    assert.match(res.out, /upload-path-traversal: Reproduced: no \(the fix holds\)/);
    assert.match(res.out, /admin-missing-role-check: Reproduced: yes \(the fix does not hold\)/);
  });

  it("runs on Docker Sandboxes too: the finding file goes in with the brief, and the sandbox is removed", async () => {
    const host = sbxHost({
      "--no-input cp agent-kit-deep-": {
        status: 0,
        writes: [{ name: "report.md", text: VERIFY_REPORT }],
      },
    });
    const res = await run(verifyRepo(), verifyArgs(), { host });
    assert.equal(res.code, 0, res.text);
    const findings = copiedIn(res).filter((e) => e.name === "agent-kit/in/findings.md");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.toString("utf8"), FINDINGS);
    assert.ok(briefOf(res).includes("## Verification run"));
    assert.equal(reportOf(res), VERIFY_REPORT);
    assert.ok(sbxCalls(res).some((a) => a[0] === "rm"));
  });

  it("exits 1 when the report misses a given finding or the Verification-run Mode line, still writing it", async () => {
    const partial = VERIFY_REPORT.split("### admin-missing-role-check")[0].replace(
      "deep (Verification run)",
      "deep",
    );
    const res = await run(verifyRepo(), verifyArgs(), { host: verifyHost(partial) });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /admin-missing-role-check/);
    assert.match(res.err, /Mode:\*\* deep \(Verification run\)/);
    assert.equal(reportOf(res), partial);
    assert.match(res.out, /Teardown: removed/);
  });
});

describe("--verify is local only, and its flags go together", () => {
  it("is refused in GitHub Actions before anything is read or run, naming no path", async () => {
    const missing = join(tmp, "upload-path-traversal-findings.md");
    const res = await run(verifyRepo(), verifyArgs(missing), {
      host: verifyHost(),
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: REAL_KEY, GITHUB_ACTIONS: "true" },
    });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /REFUSED {2}--verify has no CI form/);
    assert.match(res.err, /docs\/security-audit\.md#verification-run/);
    assert.doesNotMatch(res.text, /upload-path-traversal/);
    assert.deepEqual(res.calls, []);
  });

  it("is a usage error to pass --ref without --verify, --verify without --ref, or --report with --verify", async () => {
    const report = join(mkdtempSync(join(tmp, "out-")), "report.md");
    for (const [args, why] of [
      [["--ref", "fix/upload"], /--ref names the ref a Verification run exports: pass --verify/],
      [["--verify", findingFile()], /--verify needs --ref <ref>/],
      [[...verifyArgs(), "--report", report], /--report is not taken with --verify/],
    ]) {
      const res = await run(verifyRepo(), args, { host: verifyHost() });
      assert.equal(res.code, 2, `${args.join(" ")}: ${res.text}`);
      assert.match(res.err, why);
      assert.deepEqual(res.calls, []);
    }
  });

  it("refuses a ref that is not a local commit, or reads as an option, starting nothing", async () => {
    for (const [ref, code, why] of [
      ["no-such-branch", 1, /No local ref no-such-branch/],
      ["--all", 2, /--ref must be a ref name or commit id/],
      ["a b", 2, /--ref must be a ref name or commit id/],
    ]) {
      const res = await run(
        verifyRepo(),
        [...verifyArgs(findingFile(), "x").slice(0, 2), `--ref=${ref}`],
        {
          host: verifyHost(),
        },
      );
      assert.equal(res.code, code, `${ref}: ${res.text}`);
      assert.match(res.err, why);
      assert.deepEqual(res.shims, []);
    }
  });

  it("runs the .env pre-flight on the ref it exports", async () => {
    const res = await run(verifyRepo({ fix: { ".env": "SECRET=1\n" } }), verifyArgs(), {
      host: verifyHost(),
    });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /fix\/upload \([0-9a-f]{12}\) has environment files/);
    assert.match(res.err, /forwarded wholesale/);
    assert.deepEqual(res.shims, []);
  });

  it("refuses a skill whose DEEP.md has no Verification run section, before any runtime", async () => {
    const dir = verifyRepo({
      committed: { ".claude/skills/security-audit/DEEP.md": "# Deep scan procedure marker\n" },
    });
    const res = await run(dir, verifyArgs(), { host: verifyHost() });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /REFUSED {2}.*DEEP\.md on main has no .*Verification run/);
    assert.deepEqual(res.shims, []);
  });
});

describe("a finding file that is missing, unreadable or out of shape is refused before any runtime", () => {
  const finding = (fields) =>
    ["### F1 — a finding", "", ...fields.map((f) => `- ${f}`), ""].join("\n");
  const LOC = "**Location:** `src/a.js:1`";
  const CID = "**Concept id:** `a-finding`";
  const OBS = "**Observation:** a fixture user saw another user's record.";
  const cases = [
    ["a missing file", () => join(tmp, "no-such-findings.md"), /it does not exist/],
    ["a folder", () => mkdtempSync(join(tmp, "a-folder-")), /is not a regular file/],
    ["an empty file", () => findingFile(""), /has no findings/],
    [
      "a file with no finding",
      () => findingFile("## Security audit report\n\n### Findings\n\nNone.\n"),
      /has no findings/,
    ],
    [
      "a finding with no Location",
      () => findingFile(finding([CID, OBS])),
      /a-finding.*has no Location/,
    ],
    [
      "a finding with no Observation",
      () => findingFile(finding([LOC, CID])),
      /a-finding.*has no Observation/,
    ],
    [
      "a concept id that is not kebab-case",
      () => findingFile(finding([LOC, "**Concept id:** `Not Kebab`", OBS])),
      /concept id .*kebab-case/,
    ],
    [
      "a concept id given twice",
      () => findingFile(finding([LOC, CID, OBS]) + finding([LOC, CID, OBS])),
      /a-finding.* more than once/,
    ],
    ["a binary file", () => findingFile("### F1\0\n"), /is not text/],
    [
      "a file over 512 KiB",
      () => findingFile(finding([LOC, CID, OBS]) + "x".repeat(512 * 1024)),
      /larger than 512 KiB/,
    ],
  ];
  for (const [name, make, why] of cases) {
    it(`refuses ${name}, exit 1, with nothing run`, async () => {
      const res = await run(verifyRepo(), verifyArgs(make()), { host: verifyHost() });
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, /REFUSED {2}/);
      assert.match(res.err, why);
      assert.match(res.err, /docs\/security-audit\.md#verification-run/);
      assert.deepEqual(res.calls, []);
    });
  }

  it("ignores a heading or field inside a code fence", async () => {
    const fenced = `${FINDINGS}\n\`\`\`markdown\n### not-a-finding\n\n- **Concept id:** \`fenced-id\`\n\`\`\`\n`;
    const res = await run(verifyRepo(), verifyArgs(findingFile(fenced)), { host: verifyHost() });
    assert.equal(res.code, 0, res.text);
    assert.match(res.out, /Verification run: 2 finding\(s\)/);
  });
});

describe("the Verification run docs", () => {
  const docs = readFileSync(join(import.meta.dirname, "..", "docs", "security-audit.md"), "utf8");
  const readme = readFileSync(join(import.meta.dirname, "..", "cli", "README.md"), "utf8");

  it("say how to run one, on which ref, with what limits, and that it stays local", () => {
    const section = docs.split(/^## /m).find((s) => s.startsWith("Verification run\n"));
    assert.ok(section, "docs/security-audit.md has a ## Verification run section");
    for (const needed of [
      "--verify",
      "--ref",
      "15 min",
      "50",
      "GITHUB_ACTIONS",
      "Reproduced: yes",
      "no advisory",
      "Concept id",
      "Observation",
      "Location",
    ]) {
      assert.ok(section.includes(needed), `the section has ${needed}`);
    }
  });

  it("are named by the CLI README and --help", async () => {
    for (const flag of ["--verify <file>", "--ref <ref>"]) {
      assert.ok(readme.includes(flag), `the README names ${flag}`);
    }
    const res = await run(recipeRepo(VALID), ["--help"]);
    assert.ok(res.out.includes("--verify <file>") && res.out.includes("--ref <ref>"), res.out);
  });
});
