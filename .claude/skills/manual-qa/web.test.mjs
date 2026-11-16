/**
 * Contract suite for `web.mjs`, the `web` surface's driver (SKILL.md steps 4
 * and 6, ADAPTER.md "The web driver", ADR 0008): it carries out a step
 * sequence the runner wrote, in one browser context per Session, and records a
 * still, the element the step is about, its visible text, the Session and the
 * time at each step, plus a video per Session with `--video`. It asserts
 * nothing: its exit status says only whether every action completed.
 *
 * The sequence checks, the record shape and the missing-Playwright exit run
 * everywhere. The tests that drive a browser need Playwright with Chromium in
 * this repository; they skip without it, and fail instead when
 * `AGENT_KIT_REQUIRE_CHROMIUM=1` says it must be there.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { WEB_NOTES, findPlaywright } from "./adapter.mjs";
import { STEP_KEYS, checkSequence, main } from "./web.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const adapterDoc = readFileSync(join(HERE, "ADAPTER.md"), "utf8");
const skill = readFileSync(join(HERE, "SKILL.md"), "utf8");
const design = readFileSync(join(HERE, "DESIGN.md"), "utf8");

const PLAYWRIGHT = findPlaywright(ROOT);
const REQUIRED = process.env.AGENT_KIT_REQUIRE_CHROMIUM === "1";
/** Skip a browser test when Chromium is absent, unless the environment says it must be there. */
const NEEDS_CHROMIUM =
  PLAYWRIGHT.chromium || REQUIRED
    ? false
    : "Playwright with Chromium is not installed in this repository";

const PASSWORD = "Corr3ct-Horse-Battery";
const EMAIL = "admin@example.test";
const ENV = { QA_A_EMAIL: EMAIL, QA_A_PASSWORD: PASSWORD };

/** Each request the server saw: its path and Cookie header. */
const seen = [];
let server;
let base;
let port;
let sid = 0;
let dir;

const page = (body, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>t</title>${head}</head><body>${body}</body></html>`;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      seen.push({ path: url.pathname, cookie: req.headers.cookie ?? null });
      const html = (text, headers = {}) => {
        res.writeHead(200, { "content-type": "text/html", ...headers });
        res.end(page(text));
      };
      if (url.pathname === "/set") {
        sid += 1;
        return html("<h1>Cookie set</h1>", {
          "set-cookie": `sid=session-${sid}-abcdef; Path=/; HttpOnly`,
        });
      }
      if (url.pathname === "/who") {
        const has = /(?:^|; )sid=/.test(req.headers.cookie ?? "");
        return html(`<h1>Who</h1><p id="who">${has ? "signed in" : "nobody"}</p>`);
      }
      if (url.pathname === "/sign-in")
        return html(
          '<form method="post" action="/login">' +
            '<label>Email <input name="email"></label>' +
            '<label>Password <input name="password" type="password"></label>' +
            '<label>Note <input name="note"></label>' +
            '<label>Hidden <input name="hidden" type="password"></label>' +
            "<button>Sign in</button></form>",
        );
      if (url.pathname === "/login") {
        res.writeHead(303, { location: "/welcome" });
        return res.end();
      }
      if (url.pathname === "/welcome") return html('<h1>Welcome</h1><p role="status">Hello</p>');
      if (url.pathname === "/toast")
        return html(
          "<button onclick=\"setTimeout(() => { const d = document.createElement('p'); " +
            "d.setAttribute('role', 'status'); d.textContent = 'Saved the profile'; " +
            'document.body.append(d); }, 400)">Save</button>',
        );
      if (url.pathname === "/away") return html(`<a href="http://localhost:${port}/who">Leave</a>`);
      html("<h1>Home</h1>");
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  dir = mkdtempSync(join(tmpdir(), "web-driver-"));
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

let runs = 0;
/** Writes a sequence and runs the driver on it, in-process, loading Playwright from this repository. */
async function drive(actions, { env = ENV, video = false, cwd = ROOT, extra = [] } = {}) {
  runs += 1;
  const file = join(dir, `seq-${runs}.json`);
  const out = join(dir, `out-${runs}`);
  writeFileSync(file, JSON.stringify(Array.isArray(actions) ? { actions } : actions));
  const argv = ["run", file, "--base", base, "--out", out, ...(video ? ["--video"] : []), ...extra];
  const { code, out: stdout } = await main(argv, { env, cwd });
  let summary = null;
  try {
    summary = JSON.parse(stdout);
  } catch {
    // usage text
  }
  const stepsFile = join(out, "steps.json");
  const steps = existsSync(stepsFile) ? JSON.parse(readFileSync(stepsFile, "utf8")) : null;
  return { code, stdout, summary, out, steps };
}

/** Every file the driver wrote, as text, for a search. */
const allText = (out) =>
  existsSync(out)
    ? readdirSync(out, { recursive: true })
        .map((f) => join(out, String(f)))
        .filter((f) => !f.endsWith(".png") && !f.endsWith(".webm") && existsSync(f))
        .map((f) => {
          try {
            return readFileSync(f, "utf8");
          } catch {
            return "";
          }
        })
        .join("\n")
    : "";

// ── The sequence is checked before anything runs ───────────────────────────

const ok = (actions, env = ENV) => checkSequence({ actions }, env);

test("a well-formed sequence of every action reads with no problems", () => {
  assert.deepEqual(
    ok([
      { session: "A", goto: "/sign-in" },
      { session: "A", fill: { label: "Email" }, value: "{{env:QA_A_EMAIL}}" },
      { session: "A", fill: { label: "Password" }, value: "{{env:QA_A_PASSWORD}}" },
      { session: "A", fill: { label: "Note", exact: true }, value: "a plain note" },
      { session: "A", click: { role: "button", name: "Sign in" } },
      { session: "A", press: "Enter" },
      { session: "A", wait: { text: "Welcome" }, timeoutMs: 2000 },
      { session: "A", step: "Signed in", subject: { role: "status" }, timeoutMs: 3000 },
      { session: "B", step: "B sees the home page" },
    ]),
    [],
  );
});

test("an unknown key in the file or an action is refused, as http.mjs refuses one", () => {
  assert.match(
    checkSequence({ actions: [{ goto: "/" }], extra: 1 }, {}).join("\n"),
    /unknown key "extra"/,
  );
  assert.match(ok([{ goto: "/", wait: { text: "x" } }]).join("\n"), /exactly one action/);
  assert.match(ok([{ goto: "/", selector: "#x" }]).join("\n"), /unknown key "selector"/);
  assert.match(ok([{ click: { css: "#x" } }]).join("\n"), /click: unknown key "css"/);
  assert.match(ok([{ step: "x", timeoutMs: 100 }]).join("\n"), /timeoutMs.*subject/);
});

test("a path to another host, or one that is not a path, is refused", () => {
  for (const path of [
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example",
    "evil",
    "/a b",
  ])
    assert.match(ok([{ goto: path }]).join("\n"), /action 1: goto/, path);
  assert.deepEqual(ok([{ goto: "/users?page=2#top" }]), []);
});

test("a sign-in value written inline is refused, and the problem never names the value", () => {
  const problems = [
    ...ok([{ fill: { label: "Password" }, value: PASSWORD }]),
    ...ok([{ fill: { label: "Email" }, value: EMAIL }]),
    ...ok([{ step: `typed ${PASSWORD}` }]),
    ...ok([{ fill: { label: "Note" }, value: encodeURIComponent(PASSWORD) }]),
  ];
  assert.equal(problems.length >= 4, true, problems.join("\n"));
  assert.ok(!problems.join("\n").includes(PASSWORD));
  assert.ok(!problems.join("\n").includes(EMAIL));
  // A field named like a secret needs a placeholder, whatever the literal.
  assert.match(
    ok([{ fill: { label: "One-time code" }, value: "123456" }]).join("\n"),
    /names a secret; give it as \{\{env:QA_…\}\}/,
  );
  // A token shape anywhere.
  assert.match(
    ok([{ fill: { label: "Note" }, value: `eyJhbGciOi.${"x".repeat(10)}.sig` }]).join("\n"),
    /looks like a JWT/,
  );
  // A secret-named query parameter in a path.
  assert.match(ok([{ goto: "/reset?token=abc123" }]).join("\n"), /names a secret/);
});

test("a placeholder must name a set QA_ variable, and goes only in a fill's value", () => {
  assert.match(
    ok([{ fill: { label: "x" }, value: "{{env:HOME}}" }]).join("\n"),
    /only QA_ variables/,
  );
  assert.match(ok([{ fill: { label: "x" }, value: "{{env:QA_NOPE}}" }]).join("\n"), /not set/);
  assert.match(ok([{ goto: "/{{env:QA_A_EMAIL}}" }]).join("\n"), /only in a fill's value/);
  assert.match(ok([{ step: "{{env:QA_A_EMAIL}}" }]).join("\n"), /only in a fill's value/);
});

test("sessions, keys, targets and bounds are checked", () => {
  assert.match(ok([{ session: "a", goto: "/" }]).join("\n"), /single capital letter/);
  assert.match(ok([{ press: "Enter\n" }]).join("\n"), /press/);
  assert.match(ok([{ wait: { text: "x" }, timeoutMs: 999_999 }]).join("\n"), /timeoutMs/);
  assert.match(ok([{ click: { role: "button", label: "x" } }]).join("\n"), /one of/);
  assert.match(ok([{ click: { label: "x", name: "y" } }]).join("\n"), /name.*role/);
  assert.match(ok([{ step: "" }]).join("\n"), /caption/);
  assert.match(checkSequence({ actions: [] }, {}).join("\n"), /one or more/);
});

test("a refused sequence exits 1 with its problems, and nothing runs or is written", async () => {
  const { code, summary, out } = await drive([
    { goto: "https://evil.example/" },
    { fill: { label: "Password" }, value: PASSWORD },
  ]);
  assert.equal(code, 1);
  assert.equal(summary.completed, false);
  assert.ok(summary.problems.length >= 2);
  assert.ok(!JSON.stringify(summary).includes(PASSWORD));
  assert.equal(existsSync(out), false);
});

test("usage errors exit 2", async () => {
  for (const argv of [
    [],
    ["run"],
    ["run", "x.json", "--base", "http://127.0.0.1:1"],
    ["run", "x.json", "--out", "o"],
    ["run", "x.json", "--base", "http://127.0.0.1:1/app", "--out", "o"],
    ["run", "x.json", "--base", "ftp://127.0.0.1", "--out", "o"],
    ["run", "x.json", "--base", "http://u:p@127.0.0.1", "--out", "o"],
    ["run", "x.json", "--base", "http://127.0.0.1", "--out", "o", "--log", "x"],
  ])
    assert.equal((await main(argv, { env: {}, cwd: ROOT })).code, 2, argv.join(" "));
});

test("with Playwright missing, the driver exits 2 naming what to install, and runs nothing", async () => {
  const empty = mkdtempSync(join(tmpdir(), "no-playwright-"));
  try {
    const { code, stdout, out } = await drive([{ goto: "/" }], { cwd: empty });
    assert.equal(code, 2);
    assert.match(stdout, /npm install --save-dev playwright/);
    assert.match(stdout, /npx playwright install chromium/);
    assert.match(stdout, /harness's browser/);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the step record's keys are the documented ones", () => {
  assert.deepEqual(STEP_KEYS, [
    "session",
    "index",
    "caption",
    "still",
    "subject",
    "text",
    "atMs",
    "withheld",
  ]);
  for (const key of STEP_KEYS) assert.ok(adapterDoc.includes(`| \`${key}\``), key);
});

// ── Driving Chromium ────────────────────────────────────────────────────────

test(
  "Chromium is here when AGENT_KIT_REQUIRE_CHROMIUM says it must be",
  { skip: !REQUIRED },
  () => {
    assert.ok(PLAYWRIGHT.chromium, "AGENT_KIT_REQUIRE_CHROMIUM=1, but no Playwright with Chromium");
  },
);

test("two Sessions keep their cookies apart", { skip: NEEDS_CHROMIUM }, async () => {
  seen.length = 0;
  const { code, steps } = await drive([
    { session: "A", goto: "/set" },
    { session: "B", goto: "/who" },
    { session: "A", goto: "/who" },
    { session: "A", step: "A is signed in", subject: { text: "signed in" } },
    { session: "B", goto: "/who" },
    { session: "B", step: "B is nobody", subject: { text: "nobody" } },
  ]);
  assert.equal(code, 0);
  const who = seen.filter((s) => s.path === "/who");
  assert.equal(who.length, 3);
  assert.equal(who[0].cookie, null, "B before A signed in");
  assert.match(who[1].cookie ?? "", /sid=session-/, "A sends its cookie");
  assert.equal(who[2].cookie, null, "B never sends A's cookie");
  assert.deepEqual(
    steps.steps.map((s) => [s.session, s.text]),
    [
      ["A", "signed in"],
      ["B", "nobody"],
    ],
  );
});

test(
  "each step writes a still and one record, and the times rise",
  { skip: NEEDS_CHROMIUM },
  async () => {
    const { code, summary, out, steps } = await drive([
      { goto: "/welcome" },
      { step: "The welcome page" },
      { step: "The status line", subject: { role: "status" } },
      { session: "B", goto: "/" },
      { session: "B", step: "B's home", subject: { role: "heading", name: "Home" } },
    ]);
    assert.equal(code, 0);
    assert.equal(summary.completed, true);
    const records = steps.steps;
    assert.equal(records.length, 3);
    for (const [i, record] of records.entries()) {
      assert.deepEqual(Object.keys(record), STEP_KEYS);
      assert.equal(record.index, i + 1);
      assert.equal(record.withheld, null);
      assert.ok(existsSync(join(out, record.still)), record.still);
      assert.equal(typeof record.atMs, "number");
      if (i) assert.ok(record.atMs > records[i - 1].atMs, "times rise");
    }
    assert.equal(records[0].subject, null);
    assert.equal(records[0].text, null);
    assert.equal(records[1].text, "Hello");
    for (const key of ["x", "y", "width", "height"])
      assert.equal(typeof records[1].subject[key], "number");
    assert.equal(records[2].session, "B");
    assert.equal(records[2].caption, "B's home");
    assert.equal(records[2].still, "step-03-b.png");
  },
);

test(
  "a wait-then-step waits for its subject up to the bound, then takes the still",
  { skip: NEEDS_CHROMIUM },
  async () => {
    const { code, steps } = await drive([
      { goto: "/toast" },
      { click: { role: "button", name: "Save" } },
      { step: "The toast", subject: { role: "status" }, timeoutMs: 5000 },
    ]);
    assert.equal(code, 0);
    assert.equal(steps.steps[0].text, "Saved the profile");
    assert.ok(steps.steps[0].still);
  },
);

test(
  "a subject that never appears exits 1, and the step file keeps the earlier steps",
  { skip: NEEDS_CHROMIUM },
  async () => {
    const { code, summary, steps } = await drive([
      { goto: "/" },
      { step: "Home" },
      { step: "A toast that never comes", subject: { role: "status" }, timeoutMs: 300 },
      { step: "Never reached" },
    ]);
    assert.equal(code, 1);
    assert.equal(summary.completed, false);
    assert.equal(summary.error.action, 3);
    assert.deepEqual(
      steps.steps.map((s) => s.caption),
      ["Home"],
    );
  },
);

test(
  "a navigation off the checked address does not complete",
  { skip: NEEDS_CHROMIUM },
  async () => {
    seen.length = 0;
    const { code, summary } = await drive([{ goto: "/away" }, { click: { text: "Leave" } }]);
    assert.equal(code, 1);
    assert.match(summary.error.why, /left the checked address/);
    assert.equal(
      seen.filter((s) => s.path === "/who").length,
      0,
      "the other host was never reached",
    );
  },
);

test(
  "no still while a password field holds a value, and no sign-in value in any file",
  { skip: NEEDS_CHROMIUM },
  async () => {
    const { code, out, steps, stdout } = await drive(
      [
        { goto: "/sign-in" },
        { step: "The empty form" },
        { fill: { label: "Password" }, value: "{{env:QA_A_PASSWORD}}" },
        { step: "Password typed" },
        { fill: { label: "Password" }, value: "" },
        { fill: { label: "Email" }, value: "{{env:QA_A_EMAIL}}" },
        { step: "Email typed", subject: { label: "Email" } },
        { fill: { label: "Password" }, value: "{{env:QA_A_PASSWORD}}" },
        { click: { role: "button", name: "Sign in" } },
        { wait: { role: "heading", name: "Welcome" } },
        { step: "Signed in" },
      ],
      { video: true },
    );
    assert.equal(code, 0, stdout);
    const [empty, typed, email, signedIn] = steps.steps;
    assert.ok(empty.still);
    assert.equal(typed.still, null);
    assert.match(typed.withheld, /password field holds a value/);
    assert.equal(email.still, null);
    assert.match(email.withheld, /sign-in value/);
    assert.ok(signedIn.still);
    assert.equal(signedIn.withheld, null);
    assert.equal(existsSync(join(out, "step-02-a.png")), false);
    const text = allText(out) + stdout;
    assert.ok(!text.includes(PASSWORD));
    assert.ok(!text.includes(EMAIL));
    // Literal text into a password field is refused at run time.
    const literal = await drive([
      { goto: "/sign-in" },
      { fill: { label: "Note" }, value: "fine" },
      { fill: { role: "textbox", name: "Note" }, value: "still fine" },
      { fill: { label: "Hidden" }, value: "letmein-but-literal" },
    ]);
    assert.equal(literal.code, 1);
    assert.match(literal.summary.error.why, /password field/);
  },
);

test(
  "each Session's video is kept with --video, and none without it",
  { skip: NEEDS_CHROMIUM },
  async () => {
    const actions = [
      { session: "A", goto: "/" },
      { session: "A", step: "A" },
      { session: "B", goto: "/who" },
      { session: "B", step: "B" },
    ];
    const recorded = await drive(actions, { video: true });
    assert.equal(recorded.code, 0);
    assert.deepEqual(recorded.summary.videos.sort(), ["video-a.webm", "video-b.webm"]);
    for (const file of ["video-a.webm", "video-b.webm"])
      assert.ok(existsSync(join(recorded.out, file)), file);
    assert.equal(recorded.steps.sessions.A.video, "video-a.webm");
    const plain = await drive(actions);
    assert.equal(plain.code, 0);
    assert.deepEqual(plain.summary.videos, []);
    assert.deepEqual(
      readdirSync(plain.out).filter((f) => f.endsWith(".webm")),
      [],
    );
    assert.equal(plain.steps.sessions.B.video, null);
  },
);

// ── The docs ────────────────────────────────────────────────────────────────

test("ADAPTER.md documents the CLI, and words the readiness notes as readiness does", () => {
  const flat = adapterDoc.replace(/\s+/g, " ");
  assert.match(
    flat,
    /node "<skill>\/web\.mjs" run <sequence\.json> --base <address> --out <dir> \[--video\]/,
  );
  for (const note of Object.values(WEB_NOTES)) assert.ok(flat.includes(note), note);
  assert.match(design, /## A driver for the web surface/);
  assert.match(skill.replace(/\s+/g, " "), /`web\.mjs`/);
});
