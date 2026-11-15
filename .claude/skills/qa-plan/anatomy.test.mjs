/**
 * Contract suite for the plan format. ANATOMY.md is the only thing `qa-plan`
 * and `manual-qa` share, so it must name every part of a QA Plan the spec
 * lists: the nine sections in order, the Run brief's fields, each scenario's
 * fields, and the no-credentials rule. SKILL.md must point at it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const anatomy = readFileSync(join(HERE, "ANATOMY.md"), "utf8");
const skill = readFileSync(join(HERE, "SKILL.md"), "utf8");

/** The plan's sections, in the order a plan carries them. */
const SECTIONS = [
  "Anchors",
  "What automation already proves",
  "Expected red herrings",
  "Run brief",
  "Setup",
  "Scenarios",
  "Sign-off checklist",
  "Stop and do not merge if",
  "Execution record",
];

/** The text under one `## ` heading of ANATOMY.md. */
function section(title) {
  const parts = `\n${anatomy}`.split(/\n## /);
  const body = parts.find((part) => part.split("\n")[0].trim() === title);
  assert.ok(body, `ANATOMY.md has no \`## ${title}\` section`);
  return body;
}

test("the shape lists the nine sections, in order, as exact headings", () => {
  const shape = section("Shape");
  const listed = [...shape.matchAll(/^\d+\. `## (.+)`$/gm)].map((m) => m[1]);
  assert.deepEqual(listed, SECTIONS);
});

test("each section has its own heading, in the same order", () => {
  const headings = [...anatomy.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(
    headings.filter((h) => SECTIONS.includes(h)),
    SECTIONS,
  );
});

test("the anchors are subject issue, pull request, merge-base and head", () => {
  const anchors = section("Anchors");
  for (const label of ["Subject issue:", "Pull request:", "Merge-base:", "Head:"])
    assert.ok(anchors.includes(`**${label}**`), `Anchors lacks **${label}**`);
});

test("coverage claims are tagged observed or reconstructed", () => {
  const proves = section("What automation already proves");
  assert.ok(proves.includes("`[observed]`") && proves.includes("`[reconstructed]`"));
});

test("the Run brief names target, surface, build, roles, credentials and capture rules", () => {
  const brief = section("Run brief");
  for (const label of ["Target:", "Surface:", "Build:", "Roles:", "Credentials:", "Capture rules:"])
    assert.ok(brief.includes(`**${label}**`), `Run brief lacks **${label}**`);
  for (const value of ["`stack`", "`url`", "`web`", "`desktop`", "`mobile`", "`api`"])
    assert.ok(brief.includes(value), `Run brief lacks ${value}`);
  assert.match(brief, /head SHA/);
  assert.match(brief, /version endpoint/);
  assert.match(brief, /test-environment label/);
  assert.match(brief, /accounts\.print/);
});

test("ANATOMY.md states how the checker reads Target, Surface and Signs in as", () => {
  const shape = section("Shape");
  assert.match(shape, /### First-word values/);
  for (const label of ["Target:", "Surface:", "Signs in as:"])
    assert.ok(shape.includes(`**${label}**`), `First-word values does not name **${label}**`);
  assert.match(shape, /Backticks are dropped/);
  assert.match(shape, /`\*` and `_` at either end of the word are dropped/);
  assert.match(shape, /`team_admin` is read as `team_admin`/);
  assert.match(shape, /space, comma, semicolon, colon or parenthesis/);
  assert.match(shape, /Nothing else is stripped/);
  assert.match(shape, /reads as `web\.` and fails/);
  const brief = section("Run brief");
  assert.match(
    brief,
    /\*\*Surface:\*\* exactly one of .*\[first-word value\]\(#first-word-values\)/,
  );
  const scenarios = section("Scenarios");
  assert.match(
    scenarios,
    /\*\*Signs in as:\*\* a \[first-word value\]\(#first-word-values\): a role id the Run brief's \*\*Roles:\*\* names, or `nobody`/,
  );
  assert.match(scenarios, /first word `the`/);
  assert.match(scenarios, /first word `manager\.`/);
});

test("a Scenario account is defined, with how a later scenario names it", () => {
  const scenarios = section("Scenarios");
  assert.match(scenarios, /### Scenario accounts/);
  assert.match(
    scenarios,
    /or the id of a \[Scenario account\]\(#scenario-accounts\) an earlier scenario creates/,
  );
  assert.match(
    scenarios,
    /Each id is created by one scenario only, and is neither a Run brief role nor `nobody`/,
  );
  assert.match(scenarios, /`` `temp-user` \(created in S1\) ``/);
  assert.match(scenarios, /Only a scenario after its creator may/);
  assert.match(scenarios, /never the values/);
  assert.match(scenarios, /`manual-qa` leaves S2 for a person when S1 does not pass/);
  assert.match(
    section("Shape"),
    /each \[Scenario account\]\(#scenario-accounts\) an earlier scenario creates/,
  );
});

test("Sessions are defined, with an example, as the alternative to Signs in as", () => {
  const scenarios = section("Scenarios");
  assert.match(scenarios, /### Sessions/);
  assert.match(
    scenarios,
    /A \*\*Session\*\* is one signed-in identity, with cookies and storage no other session shares/,
  );
  assert.match(
    scenarios,
    /A scenario carries \*\*Signs in as:\*\* or \*\*Sessions:\*\*, never both and never neither/,
  );
  assert.match(scenarios, /The name is a single capital letter/);
  assert.match(scenarios, /Every numbered step starts `In session <name>,` \(or `In <name>,`\)/);
  assert.match(scenarios, /Tabs in one browser profile share cookies/);
  assert.match(scenarios, /- \*\*Sessions:\*\* A = `user`, B = `admin`/);
  assert.match(section("Shape"), /and each id in \*\*Sessions:\*\*/);
});

test("no credentials travel with a plan", () => {
  const brief = section("Run brief");
  assert.match(brief, /### No credentials travel with a plan/);
  assert.match(brief, /Not even a public QA Account's values/);
  assert.match(brief, /refuses a plan that carries one/);
});

test("each scenario carries its fields, in order, numbered from S1", () => {
  const scenarios = section("Scenarios");
  assert.match(scenarios, /`### S1: <what is verified>`/);
  const labels = [
    "Why only a human can prove it:",
    "Signs in as:",
    "Creates:",
    "Surface:",
    "Steps:",
    "Expected result:",
    "A failure means:",
    "If this fails, first rule out:",
  ];
  const positions = labels.map((label) => scenarios.indexOf(`**${label}**`));
  for (const [n, at] of positions.entries())
    assert.ok(at !== -1, `Scenarios lacks **${labels[n]}**`);
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    "scenario fields out of order",
  );
  assert.match(scenarios, /Hazard pack/);
  assert.match(scenarios, /Residue/);
});

test("the execution record is empty after compose", () => {
  assert.match(section("Execution record"), /exactly the line `_Not run yet\._`/);
});

test("the marker line names the format, the subject and the pull request", () => {
  assert.match(anatomy, /<!-- qa-plan format=2 subject=#\d+ pr=#\d+ -->/);
  assert.doesNotMatch(anatomy, /<!-- qa-plan format=1 subject=/);
});

test("ANATOMY.md says which formats a copy reads, and that format=1 has no per-scenario field", () => {
  const shape = section("Shape");
  assert.match(shape, /The composer writes `format=2`/);
  assert.match(shape, /reads `format=1` and `format=2`/);
  assert.match(shape, /A `format=1` plan carries no per-scenario field/);
  assert.match(shape, /refuses any other `format`/);
});

test("a scenario may carry its own Surface, after its sign-in fields and before Steps", () => {
  const scenarios = section("Scenarios");
  const labels = [...scenarios.matchAll(/^- \*\*([^*]+):\*\*/gm)].map((m) => m[1]);
  const at = (label) => labels.indexOf(label);
  assert.ok(at("Surface") > at("Creates") && at("Surface") < at("Steps"), labels.join(" · "));
  assert.match(
    scenarios,
    /\*\*Surface:\*\* only when this scenario drives another surface than the Run brief's \*\*Surface:\*\*/,
  );
  assert.match(scenarios, /\[first-word value\]\(#first-word-values\)/);
  assert.match(scenarios, /`format=2` only/);
  const brief = section("Run brief");
  assert.match(brief, /the plan's default/);
  assert.match(brief, /a scenario's own \*\*Surface:\*\* overrides it/);
  assert.match(section("Shape"), /\*\*Surface:\*\* \(the Run brief's, and a scenario's\)/);
});

test("SKILL.md writes plans in this format and delivers by the same marker", () => {
  assert.match(skill, /\[ANATOMY\.md\]\(ANATOMY\.md\)/);
  assert.match(skill, /`_Not run yet\._`/);
  assert.match(skill, /qa-plan format=2 subject=#<n>/);
  // A revision still finds the plan it replaces when that plan was written as format=1.
  assert.match(
    skill,
    /`<!-- qa-plan format=1 subject=#<n> ` or `<!-- qa-plan format=2 subject=#<n> `/,
  );
});

test("SKILL.md step 6 picks each scenario's surface from what its expected result observes", () => {
  const flat = skill.replace(/\s+/g, " ");
  assert.match(
    flat,
    /Pick each scenario's surface from what its \*\*Expected result:\*\* must observe/,
  );
  assert.match(
    flat,
    /Response headers, cookies \(including `HttpOnly`\), status codes and response bodies are seen on `api`/,
  );
  assert.match(flat, /Rendered copy, flows and layout are seen on `web`/);
  assert.match(flat, /The app itself is seen on `desktop` or `mobile`/);
  assert.match(flat, /The Run brief's \*\*Surface:\*\* is the one most scenarios use/);
  assert.match(flat, /`run\.surface` in the config is only the starting default/);
  assert.match(flat, /\[ANATOMY\.md\]\(ANATOMY\.md#scenarios\)/);
});

test("SKILL.md composes a multi-session scenario when a promise needs two people at once", () => {
  assert.match(
    skill,
    /When a promise needs two people signed in at once, compose a multi-session scenario/,
  );
  assert.match(skill, /\[ANATOMY\.md\]\(ANATOMY\.md#sessions\)/);
  assert.match(skill, /Never fold the second person into a step's prose/);
});

test("Setup and Steps carry product actions only, and say what to do with a command-only promise (#199)", () => {
  const promise =
    /A promise that only a command can observe \(a setting, a cache entry, internal state\) is either observable through the product surface, or it is not Residue/;
  const setup = section("Setup");
  assert.match(setup, /Each line is a product action, never a shell command/);
  assert.match(setup, /`manual-qa` runs no command from a plan/);
  assert.match(setup, /fenced code block/);
  assert.match(setup, promise);
  const scenarios = section("Scenarios");
  assert.match(
    scenarios,
    /A step is a product action, never a shell command, and the plan check reports one as it does in \[Setup\]\(#setup\)/,
  );
  assert.match(
    scenarios,
    /a promise that only a command can observe is either observable through the product surface, or it is not Residue/,
  );
  const compose = skill.split(/^### /m).find((part) => part.startsWith("6. Compose the Residue"));
  assert.ok(compose, "SKILL.md has no step 6, Compose the Residue");
  assert.match(compose, promise);
  assert.match(compose, /the plan check reports one that reads as a shell command/);
});

test("step 4 asks whether a configured suite's test could prove each promise left for the Residue (#206)", () => {
  const parts = skill.split(/^### /m);
  const establish = parts.find((part) =>
    part.startsWith("4. Establish what automation already proves"),
  );
  assert.ok(establish, "SKILL.md has no step 4, Establish what automation already proves");
  assert.match(establish, /\*\*Could a test prove it\?\*\*/);
  assert.match(
    establish,
    /for each promise left for the Residue, check whether a test in a configured suite could prove it; this check is yours, and the person is asked only where the answer is yes/,
  );
  assert.match(
    establish,
    /A suite whose `services` names the real services counts as real infrastructure/,
  );
  assert.match(
    establish,
    /a real deployment, real infrastructure no configured suite starts, or a real browser/,
  );
  assert.match(
    establish,
    /For a promise left for the Residue because only doubles covered it, only a suite whose `services` names each service its path reaches could prove it; with none, it stays for the Residue/,
  );
  assert.match(establish, /stop before step 6/);
  assert.match(establish, /which suite, and what the test would assert/);
  assert.match(establish, /\*\*Add the test\.\*\*/);
  assert.match(establish, /\*\*Keep it as a scenario\.\*\*/);
  assert.match(establish, /The head moves/);
  assert.match(establish, /run step 4 again on the new head/);
  assert.match(establish, /compute step 3's merge-base again/);
  assert.match(establish, /Never write the test for them/);
  assert.match(
    establish,
    /A promise the person already chose to keep as a scenario is not asked about again on the new head; their choice stands, unless the new run covers it, in which case it is a claim/,
  );
  const done = establish.split("**Done when:**")[1];
  assert.ok(done, "step 4 has no **Done when:**");
  assert.match(
    done,
    /every promise left for the Residue has been checked once for a test that could prove it/,
  );
  assert.match(done, /the person's choice/);
  const compose = parts.find((part) => part.startsWith("6. Compose the Residue"));
  assert.ok(compose, "SKILL.md has no step 6, Compose the Residue");
  assert.match(
    compose,
    /Each promise step 4 left for the Residue, including each one the person chose to keep as a scenario, becomes a scenario/,
  );
  assert.match(compose, /The plan carries no test recommendations/);
  assert.match(
    compose,
    /\*\*Done when:\*\* every promise step 4 left for the Residue is a scenario/,
  );
});

test("Why only a human can prove it says why no configured suite could reach the promise (#206)", () => {
  assert.match(
    section("Scenarios"),
    /- \*\*Why only a human can prove it:\*\* why no configured suite could reach the promise, not only that none covers it/,
  );
});

test("DESIGN.md says why a test is asked for before a scenario (#206)", () => {
  const design = readFileSync(join(HERE, "DESIGN.md"), "utf8");
  assert.match(design, /a manual scenario costs a run every time; a test costs once/);
});

test("Expected result compares product outputs, never a default read from source (#200)", () => {
  const scenarios = section("Scenarios");
  const bullet = scenarios.split("\n").find((line) => line.startsWith("- **Expected result:**"));
  assert.ok(bullet, "Scenarios has no **Expected result:** bullet");
  assert.match(bullet, /what the tester sees when it works, in the product's own words/);
  assert.match(
    bullet,
    /a comparison between product outputs, or a value the product itself shows during the run/,
  );
  assert.match(
    bullet,
    /never a number or default read from source or a config file, since the stack the plan runs on may set it differently/,
  );
  assert.match(
    bullet,
    /For example: the session lifetime on \*\*Settings\*\* equals the one on \*\*Profile\*\*, not: the session lifetime is `144000` minutes/,
  );
  const compose = skill.split(/^### /m).find((part) => part.startsWith("6. Compose the Residue"));
  assert.ok(compose, "SKILL.md has no step 6, Compose the Residue");
  assert.match(compose, /\[ANATOMY\.md\]\(ANATOMY\.md#scenarios\)/);
  assert.match(
    compose,
    /Write each expected result as \[ANATOMY\.md\]\(ANATOMY\.md#scenarios\) says/,
  );
  assert.doesNotMatch(
    compose,
    /read from source|config file/,
    "step 6 repeats the rule instead of pointing to it",
  );
});
