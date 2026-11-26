/**
 * Contract test: `orchestrate --dashboard` builds the past-runs dashboard from
 * local Run Records (issue #427, spec #414). The skill is prose, so these
 * tests pin the sentences a run relies on: the invocation and its argument
 * rules, what the command writes and never does, where prose may go, and what
 * colour means. What a sentence means is for review, and these only keep it
 * from being dropped. The script and the pages are tested in
 * `.claude/skills/orchestrate/records.test.mjs`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const SKILL_DIR = ".claude/skills/orchestrate";
const SKILL = read(`${SKILL_DIR}/SKILL.md`);
const RUN = read(`${SKILL_DIR}/RUN.md`);
const DESIGN = read(`${SKILL_DIR}/DESIGN.md`);
const DOCS = read("docs/orchestrate.md");

/** The text of a heading's section, up to the next heading of the same depth or higher. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const depth = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${depth}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

const flat = (text) => text.replace(/\s+/g, " ");

describe("SKILL.md: the --dashboard invocation", () => {
  it("is in the argument hint and the list of invocations", () => {
    const hint = SKILL.match(/^argument-hint: "(.*)"$/m)[1];
    assert.match(hint, /\| --dashboard \[--repo <host\/owner\/repo>\] \[--local-logs\] \|/);
    assert.match(
      flat(SKILL),
      /- `\/orchestrate --dashboard \[--repo <host\/owner\/repo>\] \[--local-logs\]`: build the past-runs dashboard from the Run Records in `<run_dir>\/records\/` and from the config's `records\.sink`, when it sets one, into `<run_dir>\/dashboard\.html`, and print its `file:\/\/` link \(\[RUN\.md\]\(RUN\.md#the-past-runs-dashboard\)\)\. It only reads the sink, never writes it; it reads no tracker and never opens a browser; and it writes nothing but the page and the cache of the records it fetched\. It covers every repository the sink holds, and opens on the current repository, or on the one `--repo` names\./,
    );
  });

  it("says --local-logs also writes dashboard.local.html, with the prose of runs whose folder is still here", () => {
    assert.match(
      flat(SKILL),
      /With `--local-logs` it also writes `dashboard\.local\.html`, which holds the prose Activity Log of runs whose folder is still here\./,
    );
  });

  it("takes nothing but --repo <host/owner/repo> and --local-logs, each once, and comes first", () => {
    assert.match(
      flat(SKILL),
      /`--dashboard` takes nothing but `--repo <host\/owner\/repo>` and `--local-logs`, each once, and `--dashboard` comes first\./,
    );
  });
});

describe("RUN.md: the past-runs dashboard", () => {
  const text = flat(section(RUN, "### The past-runs dashboard"));

  it("runs the records script and never launches a browser or hosts the page", () => {
    assert.match(text, /node "<skill>\/records\.mjs" dashboard\b/);
    assert.match(text, /node "<skill>\/records\.mjs" dashboard --local-logs/);
    assert.match(text, /node "<skill>\/records\.mjs" dashboard --repo <host\/owner\/repo>/);
    assert.match(text, /It never launches a browser/);
    assert.match(text, /the skill never hosts the page/);
    assert.match(
      text,
      /A team may host `dashboard\.html` itself \(never `dashboard\.local\.html`\), behind its own access control: it holds every record it was built from/,
    );
  });

  it("reads the sink through the upload's operations, caches forever, and treats an unreadable sink as a warning", () => {
    assert.match(text, /through the same [Ss]ink operations the upload uses/);
    assert.match(
      text,
      /checks the [Ss]ink is private first \(`visibility`\), lists `records\/` \(`list`\), and reads only the paths the cache does not hold/,
    );
    assert.match(
      text,
      /cached forever, in `<run_dir>\/records-cache\/`, in a folder that mirrors the [Ss]ink's paths/,
    );
    assert.match(
      text,
      /a `404` or a `403`\) is one warning, and the page is built from the local records/,
    );
    assert.match(
      text,
      /A [Ss]ink that has turned public is a warning too, but the read goes ahead/,
    );
    assert.match(text, /The reader needs read access only/);
  });

  it("says which records it shows: local plus the sink, identical bytes once, not uploaded, the sink's copy winning", () => {
    assert.match(text, /`local` and the configured `records\.sink`, nothing else/);
    assert.match(text, /A record that is identical in both counts once/);
    assert.match(text, /tagged "not uploaded" with its `--upload <run>` command/);
    assert.match(text, /When the bytes differ, the [Ss]ink's copy is shown, with a warning/);
  });

  it("parses namespaces from paths only, lists a path that does not parse, and opens on the current repository or --repo", () => {
    assert.match(text, /parsed from the [Ss]ink's paths alone/);
    assert.match(text, /A path that does not parse is skipped and listed/);
    assert.match(
      text,
      /offers _All repositories_ and every namespace found, and the page opens on the current repository/,
    );
    assert.match(text, /or on `--repo`/);
  });

  it("is built on this machine, offline, with no credential, and says when and how to rebuild", () => {
    assert.match(text, /works offline: it holds no credential and makes no request/);
    assert.match(text, /shows when it was built and the command that rebuilds it/);
  });

  it("names the Run page's tabs, the drill-down pages and the Key", () => {
    for (const tab of [
      "Summary",
      "Timeline",
      "Delegations",
      "Human steps",
      "Reviews and CI",
      "Log",
      "Record (JSON)",
    ])
      assert.ok(text.includes(tab), tab);
    assert.match(text, /a Human lane, a Chief of Staff lane with writes by `actor`/);
    assert.match(text, /A Delegation and each human step have a page of their own/);
    assert.match(text, /the Key page says what each cause, kind and mark means/);
  });

  it("says colour means cause, every chip says avoidable or by design, and states are grey", () => {
    assert.match(text, /Colour means `cause`, and nothing else/);
    assert.match(text, /Every chip names its cause and says avoidable or by design/);
    assert.match(text, /States, such as an outcome or a CI result, are grey/);
  });

  it("keeps prose out of dashboard.html, and puts it, with the banner, only in the separate local file", () => {
    assert.match(text, /Prose is never in `dashboard\.html`/);
    assert.match(
      text,
      /`dashboard\.local\.html` also inlines the prose `activity\.md` of each run whose folder is still in `<run_dir>`, under the banner "contains private prose from this machine, don't share this file"/,
    );
    assert.match(text, /Tell the human the `\.local` file is not for sharing/);
  });

  it("gives the Run Events as text and the report in the Log tab", () => {
    assert.match(
      text,
      /\*\*The Log tab\*\* gives the Run Events as text, derived from the record alone, and a report of the run, each to copy or download/,
    );
  });

  it("keeps the page shell and the one stylesheet in pages/", () => {
    assert.match(text, /The page shell and its one stylesheet are in \[`pages\/`\]\(pages\/\)/);
  });
});

describe("DESIGN.md and docs/orchestrate.md say what it does and why", () => {
  it("DESIGN.md gives the reason for a file, for keeping prose out, and for one shell", () => {
    const text = flat(
      section(DESIGN, "### The past-runs dashboard is a file on the reader's machine"),
    );
    assert.match(
      text,
      /needs no server, no port and no hosting, works offline, and holds no credential/,
    );
    assert.match(
      text,
      /never into `dashboard\.html`, so the file a person shares by habit is the safe one/,
    );
    assert.match(text, /Colour means `cause` and nothing else/);
    assert.match(text, /The page shell and the stylesheet are one module of their own/);
  });

  it("DESIGN.md says why the sink is read through the upload's adapter, cached forever, and an unreadable one is a warning", () => {
    const text = flat(
      section(DESIGN, "### The past-runs dashboard is a file on the reader's machine"),
    );
    assert.match(text, /through the same adapter the upload writes with/);
    assert.match(text, /a fetched record is cached forever/);
    assert.match(text, /there is no index file to trust or to keep in step/);
    assert.match(text, /An unreadable sink is a warning and not a failure/);
    assert.match(text, /a sink turned public is read anyway, with a warning/);
    assert.match(text, /the sink's wins/);
  });

  it("sinks/github.md gives the reader's access: Contents read, and no write", () => {
    const github = flat(read(`${SKILL_DIR}/sinks/github.md`));
    assert.match(github, /\*\*The reader\*\* \(the dashboard\) needs \*\*Contents: read\*\*/);
    assert.match(github, /it never writes/);
  });

  it("sinks/gitlab.md gives the reader's access: Reporter, and no write", () => {
    const gitlab = flat(read(`${SKILL_DIR}/sinks/gitlab.md`));
    assert.match(gitlab, /\*\*The reader\*\* \(the dashboard\) needs the \*\*Reporter\*\* role/);
    assert.match(gitlab, /it never writes/);
    assert.match(gitlab, /recursive and paginated/);
  });

  it("sinks/s3.md gives the reader's access: ListBucket and GetObject on records/, and no write", () => {
    const s3 = flat(read(`${SKILL_DIR}/sinks/s3.md`));
    assert.match(
      s3,
      /\*\*The reader\*\* \(the dashboard\) needs `s3:ListBucket` and `s3:GetObject` on `records\/`/,
    );
    assert.match(s3, /it never writes/);
    assert.match(s3, /`ListObjectsV2`, paginated/);
    assert.match(s3, /nothing about other repositories/);
  });

  it("the docs table has the --dashboard row, and the docs have the section", () => {
    assert.match(
      flat(DOCS),
      /\| `\/orchestrate --dashboard \[--repo <host\/owner\/repo>\] \[--local-logs\]` \| Builds the past-runs dashboard from your local Run Records and the config's `records\.sink` into `<run_dir>\/dashboard\.html` and prints its `file:\/\/` link, without opening a browser/,
    );
    assert.match(
      flat(DOCS),
      /`--dashboard` takes nothing but `--repo <host\/owner\/repo>` and `--local-logs`, each once\./,
    );
    const text = flat(section(DOCS, "#### The past-runs dashboard"));
    assert.match(text, /the skill never launches a browser, and never hosts the page/);
    assert.match(
      text,
      /your team may host `dashboard\.html` \(never `dashboard\.local\.html`\) itself, behind its own access control\. It holds every record it was built from/,
    );
    assert.match(
      text,
      /Without `--local-logs` the page holds no prose, because a Run Record holds none/,
    );
    assert.match(text, /Share `dashboard\.html`, never the `\.local` file/);
    assert.match(text, /It does not update itself/);
    assert.match(text, /You need only read access to the [Ss]ink \(for `github`, Contents: read\)/);
    assert.match(text, /a sink that has turned public shows a warning, and the read goes ahead/i);
    assert.match(text, /A record only on your machine is tagged "not uploaded"/);
    assert.match(text, /If the bytes differ, the [Ss]ink's copy is shown, with a warning/);
  });
});

describe("the dashboard shows each teammate (#432)", () => {
  const text = flat(section(RUN, "#### Teammates on the dashboard"));
  const TEAM = read(`${SKILL_DIR}/TEAM.md`);
  const SINKS = read(`${SKILL_DIR}/SINKS.md`);

  it("RUN.md says what the People table holds, per run kind, sorted by login, with no ranking or config key", () => {
    assert.match(text, /a People table with a row for each login in that repository/);
    assert.match(text, /grouped by `\(host, login\)` with a count of repositories/);
    assert.match(
      text,
      /A date range of 30 days, 90 days or all covers the table and the Person page, and defaults to 90 days/,
    );
    assert.match(
      text,
      /Run counts and run lengths are shown per run kind \(`tickets`, `spec`, `team`\) and never mixed; only the per-Delegation figures compare across kinds/,
    );
    assert.match(
      text,
      /sorted by login, with no ranking, score, total, "best" or "worst"\. No config key hides or totals people/,
    );
  });

  it("RUN.md says a Person page is per repository and login, never merged across hosts, with no alias map", () => {
    assert.match(text, /A Person page per `\(repository, login\)`/);
    assert.match(text, /logins are never merged across hosts, and there is no alias map/);
  });

  it("RUN.md says what the Spec page shows and that it never reads the tracker", () => {
    assert.match(
      text,
      /A Spec page per `\(host\/owner\/repo, run\.spec\)` where `run\.team` is true/,
    );
    assert.match(text, /marks it "superseded by <run-id>"/);
    assert.match(
      text,
      /It points at `--status --spec <n>` for live state and never reads the tracker/,
    );
    assert.match(
      text,
      /"Only runs uploaded to `<sink>` are here\. Teammates who haven't uploaded, upload elsewhere, or have runs still open aren't shown\."/,
    );
  });

  it("says that whoever can read the sink reads every record, and that uploads and sink access are the organization's controls", () => {
    for (const doc of [
      text,
      flat(SINKS),
      flat(TEAM),
      flat(section(DOCS, "#### The past-runs dashboard")),
    ])
      assert.match(doc, /[Ww]hoever can read the [Ss]ink reads every (teammate's )?record/);
    for (const doc of [
      text,
      flat(SINKS),
      flat(TEAM),
      flat(section(DOCS, "#### The past-runs dashboard")),
    ])
      assert.match(doc, /who can read the [Ss]ink are (the|your) organization's controls/);
  });
});

describe("the live run board (issue #433, spec #414)", () => {
  it("SKILL.md has the Chief of Staff write board.html each time it rewrites board.md, and give the link at go and go autonomous", () => {
    assert.match(
      flat(SKILL),
      /The Chief of Staff writes `board\.html` each time it rewrites `board\.md`, with `node <skill>\/records\.mjs board <run-folder> --heartbeat <minutes\|none>`/,
    );
    assert.match(
      flat(SKILL),
      /at `go` and `go autonomous` it gives the human the `file:\/\/` link that command prints, so they can watch the run in a browser/,
    );
  });

  it("SKILL.md says the board is a self-reloading file, never hosted, and read-only", () => {
    assert.match(
      flat(SKILL),
      /It is a file that reloads itself, never hosted, and the human answers in the chat, never on the board\./,
    );
  });

  it("RUN.md lists board.html in the layout and says what the board is", () => {
    assert.match(RUN, /^ {2}board\.html {16}the live board, written beside board\.md/m);
    const live = flat(section(RUN, "## The live board"));
    for (const claim of [
      /Planned, Needs you, Running, Checking, Landed and Merged/,
      /cause chip, its `how` .* and its age/,
      /`#open=d:<id>`/,
      /In an autonomous run only, a Rulings section/,
      /The board is read-only/,
      /older than two intervals/,
      /links to the Shared Board/,
      /links to the run's page in the dashboard/,
      /never reads a [Ss]ink or the tracker/,
      /\*\*Never hosted\.\*\*/,
    ])
      assert.match(live, claim);
  });

  it("HARNESSES.md ties the heartbeat interval to the board's staleness", () => {
    const harnesses = read(`${SKILL_DIR}/HARNESSES.md`);
    assert.match(flat(harnesses), /takes this interval to say when the run is stale/);
  });

  it("DESIGN.md says why the board is a file and is never hosted, and the docs page says what it is", () => {
    const design = flat(
      section(DESIGN, "### The live board is a file the page reloads, never hosted"),
    );
    assert.match(design, /instead of a server/);
    assert.match(design, /A hosted board would be an upload/);
    const docs = flat(section(DOCS, "#### The live run board"));
    assert.match(docs, /A hosted board would be an upload, and there is none\./);
    assert.match(docs, /Team Run's board links to the Shared Board instead of copying it/);
  });
});

describe("the optional server of the live board (issue #434, spec #414)", () => {
  it("SKILL.md says the server is optional and how to start it", () => {
    assert.match(
      flat(SKILL),
      /\*\*An optional server\.\*\* Where a process can run, the human may start `node "<skill>\/records\.mjs" serve <run-folder> --heartbeat <minutes\|none>` from the repository's root: it binds to 127\.0\.0\.1 only, pushes each new Run Event to the page it serves, and runs until it is stopped\. Nothing needs it: the run never waits on it, and `board\.html` works without it \(\[RUN\.md\]\(RUN\.md#the-optional-server\)\)\./,
    );
  });

  it("RUN.md says what the server watches, serves and never does, and what is left once it stops", () => {
    const text = flat(section(RUN, "### The optional server"));
    for (const claim of [
      /node "<skill>\/records\.mjs" serve <run-folder> --heartbeat <minutes\|none>/,
      /--port <n>/,
      /binds to 127\.0\.0\.1 only/,
      /the Chief of Staff's `events\.jsonl` and each Delegation's/,
      /between the Chief of Staff's wake-ups/,
      /`\/dashboard`/,
      /It reads no [Ss]ink and no tracker/,
      /browser notification/,
      /a browser does not let a served page open a file/,
      /`board\.html` is unaffected/,
      /Never forward the port or put the server behind a proxy/,
    ])
      assert.match(text, claim);
    assert.doesNotMatch(RUN, /is not built: the file is the whole of the live board/);
  });

  it("HARNESSES.md says what to do where a harness cannot keep a process running", () => {
    assert.match(
      flat(read(`${SKILL_DIR}/HARNESSES.md`)),
      /Where a harness cannot keep a process running, the human starts it in a terminal of their own, or goes without: `board\.html` needs no process\./,
    );
  });

  it("DESIGN.md says why the server is optional, and the docs page says how to start it", () => {
    const design = flat(
      section(DESIGN, "### The live board is a file the page reloads, never hosted"),
    );
    assert.match(design, /so nothing depends on it/);
    assert.doesNotMatch(design, /left out until it is wanted/);
    const docs = flat(section(DOCS, "#### The live run board"));
    assert.match(docs, /\*\*An optional server\.\*\*/);
    assert.match(docs, /records\.mjs serve tmp\/orchestrate\/<run>/);
    assert.match(docs, /127\.0\.0\.1/);
  });
});
