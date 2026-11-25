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
    assert.match(text, /the page is never hosted/);
  });

  it("reads the sink through the upload's operations, caches forever, and treats an unreadable sink as a warning", () => {
    assert.match(text, /through the same sink operations the upload uses/);
    assert.match(
      text,
      /checks the sink is private first \(`visibility`\), lists `records\/` \(`list`\), and reads only the paths the cache does not hold/,
    );
    assert.match(
      text,
      /cached forever, in `<run_dir>\/records-cache\/`, in a folder that mirrors the sink's paths/,
    );
    assert.match(
      text,
      /a `404` or a `403`\) is one warning, and the page is built from the local records/,
    );
    assert.match(text, /A sink that has turned public is a warning too, but the read goes ahead/);
    assert.match(text, /The reader needs read access only/);
  });

  it("says which records it shows: local plus the sink, identical bytes once, not uploaded, the sink's copy winning", () => {
    assert.match(text, /`local` and the configured `records\.sink`, nothing else/);
    assert.match(text, /A record that is identical in both counts once/);
    assert.match(text, /tagged "not uploaded" with its `--upload <run>` command/);
    assert.match(text, /When the bytes differ, the sink's copy is shown, with a warning/);
  });

  it("parses namespaces from paths only, lists a path that does not parse, and opens on the current repository or --repo", () => {
    assert.match(text, /parsed from the sink's paths alone/);
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
    assert.match(text, /the skill never launches a browser, and the page is never hosted/);
    assert.match(
      text,
      /Without `--local-logs` the page holds no prose, because a Run Record holds none/,
    );
    assert.match(text, /Share `dashboard\.html`, never the `\.local` file/);
    assert.match(text, /It does not update itself/);
    assert.match(text, /You need only read access to the sink \(for `github`, Contents: read\)/);
    assert.match(text, /a sink that has turned public shows a warning, and the read goes ahead/i);
    assert.match(text, /A record only on your machine is tagged "not uploaded"/);
    assert.match(text, /If the bytes differ, the sink's copy is shown, with a warning/);
  });
});
