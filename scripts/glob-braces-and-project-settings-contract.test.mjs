// Contract for two gaps in agent confinement.
//
// Glob expands brace groups itself, so the read-confinement hook judges every
// expansion of a pattern, not the raw string: a brace group can hide an
// absolute, climbing, or .git alternative from a segment-by-segment check.
//
// Claude Code reads permission rules from the checkout's project settings, and
// an agent that holds Write could change them mid-session. So no agent that
// holds Write may edit them: plan and audit are denied .claude/ and .mcp.json
// outright, and the implementer (which may edit .claude/skills) is denied the
// settings files and .mcp.json, by rule and by its write hook on the resolved
// path.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "../.github/agent-runtime/confine-reads-to-workspace.mjs";
import { decideWrite } from "../.github/agent-runtime/confine-writes-to-worktree.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const glob = (pattern, path) => ({
  tool_name: "Glob",
  tool_input: path === undefined ? { pattern } : { pattern, path },
});
const write = (file_path) => ({ tool_name: "Write", tool_input: { file_path } });

function deniedTools(workflowFile, stepName) {
  const yml = readRepo(".github/workflows", workflowFile);
  const start = yml.indexOf(`- name: ${stepName}\n`);
  assert.ok(start >= 0, `${workflowFile}: step "${stepName}" not found`);
  return yml.slice(start).split('--disallowedTools "')[1].split('"')[0].split(",");
}

describe("Glob brace patterns", () => {
  let ws;
  before(() => {
    ws = mkdtempSync(join(tmpdir(), "glob-braces-"));
    mkdirSync(join(ws, "src"));
  });
  after(() => rmSync(ws, { recursive: true, force: true }));

  it("refuses a brace alternative that is absolute, climbs, or enters .git", () => {
    for (const pattern of [
      "{..,..}/x",
      "{/,/}etc/*",
      "{/proc/self/*,x}",
      "{.git/*,x}",
      "{x,.git}/config",
      "src/{..,x}/../y",
      "{a,{b,/etc}}/*",
      "{~,x}/.ssh/*",
      "{C:,x}/Windows/*",
    ]) {
      for (const path of [undefined, "src"]) {
        assert.match(
          decide(glob(pattern, path), ws) ?? "",
          /outside GITHUB_WORKSPACE|inside \.git|braces/,
          `${pattern} (path ${path})`,
        );
      }
    }
  });

  it("refuses braces it cannot judge: a sequence, unbalanced, or too many expansions", () => {
    for (const pattern of [
      "{-..0}etc/*",
      "{a..z}",
      "{a,b",
      "a,b}",
      "}{",
      "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}",
    ]) {
      assert.match(decide(glob(pattern), ws) ?? "", /braces/, pattern);
    }
  });

  it("allows ordinary brace patterns inside the tree", () => {
    for (const pattern of [
      "*.{js,ts}",
      "src/**/*.{mjs,cjs,json}",
      "{src,docs}/*.md",
      "{a,{b,c}}/*",
      "{x}",
      "{a,}b",
    ]) {
      assert.equal(decide(glob(pattern), ws), null, pattern);
    }
  });
});

describe("project settings", () => {
  it("denies plan and audit any edit to .claude/ or .mcp.json", () => {
    for (const [file, step] of [
      ["agent-plan-reusable.yml", "Run planner (Claude Code)"],
      ["security-audit-reusable.yml", "Run security audit (Claude Code)"],
    ]) {
      const denied = deniedTools(file, step);
      for (const rule of ["Edit(./.claude/**)", "Edit(./.mcp.json)"]) {
        assert.ok(denied.includes(rule), `${file}: ${rule} not denied`);
      }
    }
  });

  it("denies the implementer edits to the project settings files and .mcp.json", () => {
    const denied = deniedTools("agent-implement-reusable.yml", "Run implementer (Claude Code)");
    for (const rule of [
      "Edit(./.claude/settings.json)",
      "Edit(./.claude/settings.local.json)",
      "Edit(./.mcp.json)",
    ]) {
      assert.ok(denied.includes(rule), `implementer: ${rule} not denied`);
    }
    // The implementer may be asked to change skills, so .claude/ stays editable.
    assert.ok(!denied.includes("Edit(./.claude/**)"));
  });

  describe("the implementer's write hook", () => {
    let ws;
    let linked = true;
    before(() => {
      ws = mkdtempSync(join(tmpdir(), "settings-write-"));
      mkdirSync(join(ws, ".claude", "skills"), { recursive: true });
      try {
        symlinkSync(join(ws, ".claude"), join(ws, "claude-link"), "dir");
      } catch {
        linked = false;
      }
    });
    after(() => rmSync(ws, { recursive: true, force: true }));

    it("refuses the settings files and .mcp.json", () => {
      for (const target of [
        ".claude/settings.json",
        ".claude/settings.local.json",
        "./.claude/../.claude/settings.json",
        ".mcp.json",
      ]) {
        assert.match(decideWrite(write(target), ws) ?? "", /project settings/, target);
      }
    });

    it("refuses a link that resolves to a settings file", (t) => {
      if (!linked) return t.skip("symlinks unavailable on this machine");
      assert.match(decideWrite(write("claude-link/settings.json"), ws) ?? "", /project settings/);
    });

    it("still allows other files under .claude/", () => {
      for (const target of [
        ".claude/skills/x/SKILL.md",
        ".claude/agents/a.md",
        "src/settings.json",
      ]) {
        assert.equal(decideWrite(write(target), ws), null, target);
      }
    });
  });
});
