/**
 * Contract suite for BUILD.md and SKILL.md step 7: a brief that source
 * contradicts is a finding the builder reports, the briefer acts on it, and
 * the builder looks at screenshots when it can and says so when it cannot.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (file) => readFileSync(join(HERE, file), "utf8").replace(/\r\n/g, "\n");
// Line wraps carry no meaning in Markdown prose, so match on single-spaced text.
const flat = (text) => text.replace(/\s+/g, " ");
const buildRaw = raw("BUILD.md");
const skill = flat(raw("SKILL.md"));

/** The `## <title>` section of BUILD.md, up to the next `## ` heading outside a code fence. */
function section(title) {
  const lines = buildRaw.split("\n");
  const start = lines.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `no "## ${title}" section`);
  let fenced = false;
  let end = start + 1;
  for (; end < lines.length; end++) {
    if (lines[end].startsWith("```")) fenced = !fenced;
    else if (!fenced && lines[end].startsWith("## ")) break;
  }
  return flat(lines.slice(start, end).join("\n"));
}

test("a brief that source contradicts is rendered as source and reported as a brief error", () => {
  const contradictions = section("Contradictions are findings");
  assert.match(contradictions, /Source wins/);
  assert.match(contradictions, /\*\*Doc versus source\.\*\*/);
  assert.match(
    contradictions,
    /\*\*Brief versus source\.\*\* .*Render the source behaviour, and report the brief's claim against the source `file:line`, marked as a brief error\./,
  );
  assert.match(contradictions, /Do not edit the brief/);
  assert.match(
    contradictions,
    /Silently copying the doc or the brief, or silently rendering the source/,
  );
  assert.match(contradictions, /building the page yourself .* stop, fix the brief, and say so/);
});

test("the report's Contradictions found line shows both kinds", () => {
  const report = section("Report format");
  const found = report.slice(report.indexOf("### Contradictions found"));
  assert.match(found, /<doc: source file:line vs doc file:line/);
  assert.match(found, /<brief error: the brief's claim vs source file:line/);
});

test("with a real-origin headless browser the builder screenshots and names what it looked at", () => {
  const cannot = section("What you cannot verify — say so");
  assert.match(cannot, /headless browser that renders the page as a real origin/);
  assert.match(cannot, /not a static `file:\/\/` snapshot/);
  assert.match(
    cannot,
    /screenshot the first screen and each state the brief names as important .* at desktop and phone width, in light and dark/,
  );
  assert.match(cannot, /fix what reads poorly/);
  assert.match(
    cannot,
    /name in _Verified how_ exactly which states, widths and themes you looked at/,
  );
  assert.match(
    cannot,
    /Without such a browser, .* say the visual review was not possible, and why/,
  );
  assert.match(
    section("Report format"),
    /Visual review: <NOT POSSIBLE \(why\) \| done: each state, width and theme/,
  );
});

test("the constraints keep the visual-review rule word for word and forbid editing the brief", () => {
  const constraints = section("Constraints");
  assert.ok(constraints.includes("- Do NOT claim a visual review you did not perform."));
  assert.match(
    constraints,
    /Do NOT skip the screenshots when a headless browser renders the page as a real origin/,
  );
  assert.match(constraints, /Do NOT edit the brief\./);
});

test("step 7 says what the briefer does with a brief error", () => {
  const step7 = skill.slice(skill.indexOf("### 7. Read the builder's report"));
  assert.match(step7, /marked as a brief error/);
  assert.match(step7, /Either fix the brief and rebuild, or accept the source rendering/);
  assert.match(step7, /tell the user which fact was wrong, what source says, and which you chose/);
});
