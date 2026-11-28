/**
 * Contract test: `examples/orchestrate.config.yml`, the config a repository
 * copies to start using `orchestrate`, passes the skill's own check
 * (`config.mjs check`) with nothing left to ask, shows every key the reader
 * accepts, and carries a comment on every key. A key added to `config.mjs`
 * fails here until the example shows it. What docs/orchestrate.md's config
 * table says is prose, and is not checked here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as config from "../.claude/skills/orchestrate/config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const EXAMPLE = read("examples/orchestrate.config.yml");
const FILE = "orchestrate.config.yml";

/**
 * A repository holding the example as its config. The documents it names
 * (`read_first`, the `triage_labels` document) are there, as they must be in
 * a repository that copies it.
 */
function check() {
  const { config: parsed } = config.parseConfig(FILE, EXAMPLE);
  const present = new Set([...(parsed.read_first ?? []), parsed.triage_labels]);
  const { code, out } = config.main(["check"], {
    read: (path) => (path === FILE ? EXAMPLE : null),
    exists: (path) => present.has(path),
  });
  return { code, result: JSON.parse(out) };
}

/** Every key path in a parsed config, list indexes dropped: `routes.commit`. */
function keyPaths(value, prefix = "") {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, prefix));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...keyPaths(child, path)];
  });
}

describe("examples/orchestrate.config.yml", () => {
  it("passes `config.mjs check` with no problems and nothing left to ask", () => {
    const { code, result } = check();
    assert.equal(code, 0, JSON.stringify(result.problems));
    assert.equal(result.path, FILE);
    assert.deepEqual(result.problems, []);
    assert.equal(result.readiness.ready, true);
    assert.deepEqual(result.readiness.needs, []);
  });

  it("reports the documents it names as problems when a repository lacks them", () => {
    const { code, out } = config.main(["check"], {
      read: (path) => (path === FILE ? EXAMPLE : null),
      exists: () => false,
    });
    assert.equal(code, 1);
    const problems = JSON.parse(out).problems.join("\n");
    assert.match(problems, /read_first\[0\]/);
    assert.match(problems, /triage_labels/);
  });

  it("shows the `records` keys as a commented block that reads with no problems once uncommented", () => {
    const lines = EXAMPLE.split("\n");
    const start = lines.findIndex((line) => line === "# records:");
    assert.ok(start >= 0, "a commented `records:` block");
    const block = [];
    for (const line of lines.slice(start)) {
      if (!line.startsWith("# ")) break;
      block.push(line.slice(2));
    }
    const { config: parsed, problems } = config.parseConfig(FILE, block.join("\n"));
    assert.deepEqual(problems, []);
    assert.deepEqual(keyPaths(parsed).sort(), [
      "records",
      "records.repository",
      "records.sink",
      "records.sink.branch",
      "records.sink.repo",
      "records.sink.type",
      "records.upload",
    ]);
    // A repository that copies the example gets no sink until it uncomments the block.
    assert.equal(
      config.effectiveConfig(config.parseConfig(FILE, EXAMPLE).config).records.sink,
      null,
    );
  });

  it("names the `gitlab` sink in the commented block, and a block set to it reads with no problems", () => {
    assert.match(EXAMPLE, /type: github # github \| gitlab/);
    const lines = EXAMPLE.split("\n");
    const start = lines.findIndex((line) => line === "# records:");
    const block = [];
    for (const line of lines.slice(start)) {
      if (!line.startsWith("# ")) break;
      block.push(line.slice(2));
    }
    const text = block.join("\n").replace("type: github", "type: gitlab");
    const { config: parsed, problems } = config.parseConfig(FILE, text);
    assert.deepEqual(problems, []);
    assert.equal(config.effectiveConfig(parsed).records.sink.type, "gitlab");
  });

  it("names the `s3` sink in a commented block of its own, which reads with no problems once uncommented", () => {
    const lines = EXAMPLE.split("\n");
    const start = lines.indexOf("# records:", lines.indexOf("# records:") + 1);
    assert.ok(start > lines.indexOf("# records:"), "a second commented `records:` block");
    const block = [];
    for (const line of lines.slice(start)) {
      if (!line.startsWith("# ")) break;
      block.push(line.slice(2));
    }
    const { config: parsed, problems } = config.parseConfig(FILE, block.join("\n"));
    assert.deepEqual(problems, []);
    assert.deepEqual(keyPaths(parsed).sort(), [
      "records",
      "records.sink",
      "records.sink.bucket",
      "records.sink.endpoint",
      "records.sink.region",
      "records.sink.type",
    ]);
    assert.equal(config.effectiveConfig(parsed).records.sink.type, "s3");
    assert.match(EXAMPLE, /ORCHESTRATE_S3_ACCESS_KEY_ID/);
  });

  it("names `records.raw.sink` in a commented block of its own, `s3` only, which reads with no problems once uncommented", () => {
    const lines = EXAMPLE.split("\n");
    const start = lines.indexOf("# records: # only when no block above is uncommented");
    assert.ok(
      start > lines.indexOf("# records:", lines.indexOf("# records:") + 1),
      "a third `records:` block",
    );
    const block = [];
    for (const line of lines.slice(start)) {
      if (!line.startsWith("# ")) break;
      block.push(line.slice(2));
    }
    const { config: parsed, problems } = config.parseConfig(FILE, block.join("\n"));
    assert.deepEqual(problems, []);
    assert.deepEqual(keyPaths(parsed).sort(), [
      "records",
      "records.raw",
      "records.raw.sink",
      "records.raw.sink.bucket",
      "records.raw.sink.endpoint",
      "records.raw.sink.region",
      "records.raw.sink.type",
    ]);
    assert.equal(config.effectiveConfig(parsed).records.raw.sink.type, "s3");
    // A repository that copies the example is never offered a raw upload.
    assert.equal(
      config.effectiveConfig(config.parseConfig(FILE, EXAMPLE).config).records.raw.sink,
      null,
    );
    assert.match(EXAMPLE, /expires `raw\/`/);
  });

  it("merges `raw:` into the sink block above: uncommenting both gives one `records:` key (C9)", () => {
    const lines = EXAMPLE.split("\n");
    const blockAt = (start) => {
      const block = [];
      for (const line of lines.slice(start)) {
        if (!line.startsWith("# ")) break;
        block.push(line.slice(2));
      }
      return block;
    };
    const github = blockAt(lines.indexOf("# records:"));
    const s3 = blockAt(lines.indexOf("# records:", lines.indexOf("# records:") + 1));
    const raw = blockAt(lines.indexOf("# records: # only when no block above is uncommented"));
    assert.match(raw[0], /^records: # only when no block above is uncommented/);
    assert.match(EXAMPLE, /A second\n# `records:` key is refused as a duplicate/);
    for (const [name, sink] of [
      ["github", github],
      ["s3", s3],
    ]) {
      const { config: parsed, problems } = config.parseConfig(
        FILE,
        [...sink, ...raw.slice(1)].join("\n"),
      );
      assert.deepEqual(problems, [], name);
      const records = config.effectiveConfig(parsed).records;
      assert.equal(records.sink.type, name);
      assert.equal(records.raw.sink.type, "s3");
      // Uncommenting both `records:` lines is the duplicate the comment warns of.
      assert.match(
        config.parseConfig(FILE, [...sink, ...raw].join("\n")).problems.join("\n"),
        /duplicate key/,
        name,
      );
    }
  });

  it("shows the `prune` key as a commented block that reads with no problems once uncommented", () => {
    const lines = EXAMPLE.split("\n");
    const start = lines.findIndex((line) => line === "# prune:");
    assert.ok(start >= 0, "a commented `prune:` block");
    const block = [];
    for (const line of lines.slice(start)) {
      if (!line.startsWith("# ")) break;
      block.push(line.slice(2));
    }
    const { config: parsed, problems } = config.parseConfig(FILE, block.join("\n"));
    assert.deepEqual(problems, []);
    assert.deepEqual(keyPaths(parsed).sort(), ["prune", "prune.after_days"]);
    // A repository that copies the example prunes nothing until it uncomments the block.
    assert.equal(
      config.effectiveConfig(config.parseConfig(FILE, EXAMPLE).config).prune.after_days,
      null,
    );
  });

  it("shows the `efforts` keys as a commented block that reads with no problems once uncommented", () => {
    const lines = EXAMPLE.split("\n");
    const start = lines.indexOf("# efforts:");
    assert.ok(start >= 0, "a commented `efforts:` block");
    const block = [];
    for (const line of lines.slice(start)) {
      if (!line.startsWith("# ")) break;
      block.push(line.slice(2));
    }
    const { config: parsed, problems } = config.parseConfig(FILE, block.join("\n"));
    assert.deepEqual(problems, []);
    assert.deepEqual(Object.keys(parsed.efforts), [...config.MODEL_KEYS]);
  });

  it("sets nothing its own harness cannot use", () => {
    const { notes } = check().result.readiness;
    assert.deepEqual(
      notes.filter((note) => note.includes("is not used")),
      [],
    );
  });

  it("shows every key config.mjs accepts", () => {
    const { config: parsed } = config.parseConfig(FILE, EXAMPLE);
    // `records` and `efforts` are shown commented out, and checked by the tests above.
    const shown = new Set([
      ...keyPaths(parsed),
      ...config.MODEL_KEYS.map((k) => `efforts.${k}`),
      "efforts",
      ...config.RECORDS_KEYS.map((k) => `records.${k}`),
      "records",
      ...config.PRUNE_KEYS.map((k) => `prune.${k}`),
      "prune",
    ]);
    const sub = (section, keys) => keys.map((k) => `${section}.${k}`);
    const accepted = [
      ...Object.keys(config.SECTIONS),
      ...sub("routes", config.ROUTE_KEYS),
      ...sub("skills", config.SKILL_KEYS),
      ...sub("models", config.MODEL_KEYS),
      ...sub("limits", config.LIMIT_KEYS),
      ...sub("decisions", config.DECISION_KEYS),
      ...sub("ready_to_merge", config.READY_KEYS),
      ...sub("spec", config.SPEC_KEYS),
      ...sub("regate", config.REGATE_KEYS),
      ...sub("regate.allowed_failures", config.ALLOWED_FAILURE_KEYS),
    ];
    // Each section the reader resolves to a mapping of values (all but
    // `triage_labels`, whose effective form is derived) needs its keys shown
    // too, so a new section with keys of its own fails here.
    for (const [section, value] of Object.entries(config.effectiveConfig(parsed)))
      if (
        section !== "triage_labels" &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
      )
        accepted.push(...sub(section, Object.keys(value)));
    assert.deepEqual(
      accepted.filter((key) => !shown.has(key)),
      [],
      "keys config.mjs accepts that the example does not show",
    );
  });

  it("has a comment on every key", () => {
    const bare = EXAMPLE.split("\n")
      .map((line, n) => ({ line, n: n + 1 }))
      // Quoted text is blanked first, so a ` # ` inside a value is not a comment.
      .filter(({ line }) => {
        const bare = line.replace(/"[^"]*"|'[^']*'/g, '""');
        return /^\s*(?:- )?[\w-]+:/.test(bare) && !/ # /.test(bare);
      });
    assert.deepEqual(
      bare.map(({ n, line }) => `${n}: ${line}`),
      [],
      "key lines with no trailing comment",
    );
  });

  it("holds no sign-in value and no hosted address", () => {
    const values = JSON.stringify(config.parseConfig(FILE, EXAMPLE).config);
    assert.doesNotMatch(values, /password|token|secret/i);
    assert.doesNotMatch(values, /https?:\/\//);
  });
});

describe("orchestrate.config.yml: this repository's allowed failures", () => {
  const own = config.parseConfig(FILE, read(FILE));

  it("reads with no problems", () => {
    assert.deepEqual(own.problems, []);
  });

  it("names the five tests that fail on the default branch under macOS, each with a reason", () => {
    const allowed = config.effectiveConfig(own.config).regate_allowed_failures;
    assert.deepEqual(allowed.map((a) => a.test).sort(), [
      "checks the report in the sandbox with a real sh, then tars that one file",
      "test_the_check_refuses_a_bad_model_or_limit_and_a_sum_past_the_timeout",
      "test_the_launcher_keeps_the_api_key_path_from_the_key",
      "test_the_launcher_passes_the_effort_as_a_flag_only_when_it_is_set",
      "test_the_launcher_selects_the_subscription_path_from_the_token",
    ]);
    for (const { reason } of allowed) assert.match(reason, /\S/);
  });

  it("keeps the commands it re-gated with, and adds the pre-commit run the PR template asks for", () => {
    const { regate } = config.effectiveConfig(own.config);
    assert.ok(regate.includes("uv run pytest"));
    assert.ok(regate.includes("uv run pre-commit run --all-files"));
    // Its local prettier hook needs the node_modules `npm ci` installs.
    assert.ok(
      regate.indexOf("uv run pre-commit run --all-files") > regate.indexOf("npm ci"),
      "pre-commit runs after npm ci",
    );
  });
});
