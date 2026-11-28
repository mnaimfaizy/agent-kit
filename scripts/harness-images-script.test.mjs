// Contract for docker/harness-images/image.mjs, which the two Harness image
// workflows run (ADR 0029): the image of a pin is tagged by a hash of its
// inputs, built and pushed only when that tag is absent, and the adapter must
// record the digest it names. docker is a fake runner here; nothing is built.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { claudeCode } from "../cli/src/harness/claude-code.mjs";
import {
  HARNESSES,
  inputsTag,
  main,
  recordDigest,
  refreshDockerfile,
} from "../docker/harness-images/image.mjs";

const REPO = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, REPO), "utf8");
const DOCKERFILE = read("docker/harness-images/claude-code.Dockerfile");
const ADAPTER = read("cli/src/harness/claude-code.mjs");

const digest = (c) => `sha256:${c.repeat(64)}`;
const IMAGE = "ghcr.io/mnaimfaizy/agent-kit-sandbox-claude-code";
const manifest = (platforms = ["linux/amd64", "linux/arm64"]) =>
  JSON.stringify({
    manifests: platforms.map((p) => {
      const [os, architecture] = p.split("/");
      return { platform: { os, architecture } };
    }),
  });

describe("the Harness images the script knows", () => {
  it("are one per Dockerfile, each the image its adapter pins", () => {
    const files = readdirSync(new URL("docker/harness-images/", REPO))
      .filter((f) => f.endsWith(".Dockerfile"))
      .map((f) => f.replace(".Dockerfile", ""));
    assert.deepEqual(Object.keys(HARNESSES), files);
    assert.equal(claudeCode().installLayer.image.split("@")[0], IMAGE);
  });
});

describe("the Dockerfile of the Claude Code image", () => {
  it("takes the CLI version from the build, and fails unless that version runs", () => {
    assert.match(DOCKERFILE, /@anthropic-ai\/claude-code@\$CLI_VERSION/);
    assert.match(DOCKERFILE, /^RUN claude --version \| grep -F "\$CLI_VERSION"$/m);
  });

  it("fails unless the CLI runs with nothing on the path, so not on the project's Node", () => {
    assert.match(
      DOCKERFILE,
      /^RUN env -i PATH=\/nonexistent \/opt\/agent-kit\/bin\/claude --version \| grep -F "\$CLI_VERSION"$/m,
    );
  });

  it("pins every base by digest, Debian slim and a Node LTS", () => {
    const from = [...DOCKERFILE.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
    assert.equal(from.length, 2);
    assert.match(from[0], /^node:24-trixie-slim@sha256:[0-9a-f]{64}$/);
    assert.match(from[1], /^debian:trixie-slim@sha256:[0-9a-f]{64}$/);
  });

  it("installs the base tools, and puts the harness in /opt/agent-kit with its own Node", () => {
    for (const tool of ["bash", "ca-certificates", "curl", "git", "nodejs", "python3"]) {
      assert.match(DOCKERFILE, new RegExp(`--no-install-recommends[^;]*\\s${tool}[\\s;]`), tool);
    }
    assert.match(DOCKERFILE, /cp \/usr\/local\/bin\/node \/opt\/agent-kit\/node\/bin\/node/);
    assert.match(DOCKERFILE, /^COPY --from=harness \/opt\/agent-kit \/opt\/agent-kit$/m);
    assert.doesNotMatch(DOCKERFILE, /PATH=/, "the harness's Node stays off the project's path");
  });

  it("holds the adapter's install layer, so it runs alone as a layered image does", () => {
    const { env, run } = claudeCode().installLayer;
    const flat = DOCKERFILE.replace(/ \\\n\s*/g, " ");
    assert.ok(flat.includes(run.join("\n").replace(/ \\\n\s*/g, " ")), flat);
    for (const v of env) assert.match(DOCKERFILE, new RegExp(`^ENV ${v}\\b`, "m"));
  });
});

describe("the inputs tag", () => {
  it("changes with the Dockerfile or the CLI version, and not with line ends", () => {
    const tag = inputsTag("FROM a\n", "1.0.0");
    assert.match(tag, /^inputs-[0-9a-f]{32}$/);
    assert.equal(inputsTag("FROM a\r\n", "1.0.0"), tag);
    assert.notEqual(inputsTag("FROM b\n", "1.0.0"), tag);
    assert.notEqual(inputsTag("FROM a\n", "1.0.1"), tag);
  });
});

describe("recording a digest in the adapter", () => {
  it("replaces the one IMAGE_DIGEST line, with the inputs tag beside it", () => {
    const next = recordDigest(ADAPTER, digest("d"), "inputs-abc");
    assert.ok(next.includes(`const IMAGE_DIGEST = "${digest("d")}"; // inputs-abc\n`));
    assert.equal(next.split("\n").length, ADAPTER.split("\n").length);
  });

  // Offline, on every pull request: a pin changed with no new image recorded
  // fails here, so a release cannot carry a digest of another pin.
  it("holds the digest of the current Dockerfile and CLI version", () => {
    const tag = inputsTag(DOCKERFILE, claudeCode().identity.version);
    const line = `const IMAGE_DIGEST = "${claudeCode().installLayer.image.split("@")[1]}"; // ${tag}`;
    assert.ok(ADAPTER.replace(/\r/g, "").includes(`${line}\n`), `expected ${tag}`);
  });

  it("refuses what is not a digest, and a source with no such line", () => {
    assert.throws(() => recordDigest(ADAPTER, "latest", "t"), /not a sha256 digest/);
    assert.throws(() => recordDigest("const x = 1;\n", digest("d"), "t"), /IMAGE_DIGEST/);
  });
});

describe("refreshing the base", () => {
  it("moves every FROM digest and the package date", () => {
    const asked = [];
    const next = refreshDockerfile(DOCKERFILE, {
      resolve: (tag) => (asked.push(tag), digest(String(asked.length))),
      date: "2027-01-01",
    });
    assert.deepEqual(asked, ["node:24-trixie-slim", "debian:trixie-slim"]);
    assert.ok(next.includes(`FROM node:24-trixie-slim@${digest("1")} AS harness`), next);
    assert.ok(next.includes(`FROM debian:trixie-slim@${digest("2")}\n`), next);
    assert.match(next, /^ARG REFRESHED=2027-01-01$/m);
  });

  it("refuses a Dockerfile with no REFRESHED line to move", () => {
    assert.throws(
      () =>
        refreshDockerfile(`FROM a:1@${digest("a")}\n`, {
          resolve: () => digest("b"),
          date: "2027-01-01",
        }),
      /REFRESHED/,
    );
  });
});

/**
 * Run a command of the script with a fake docker. `tags` maps a tag
 * reference to its digest; a build adds the tag it pushes.
 */
function script(
  args,
  { tags = {}, recorded, recordedTag, platforms, inspectError, buildStatus = 0 } = {},
) {
  recordedTag ??= TAG.split(":")[1];
  const calls = [];
  const out = [];
  const files = {
    "docker/harness-images/claude-code.Dockerfile": DOCKERFILE,
    "cli/src/harness/claude-code.mjs": recorded
      ? recordDigest(ADAPTER, recorded, recordedTag)
      : ADAPTER,
  };
  const held = { ...tags };
  const run = (argv, { input } = {}) => {
    calls.push({ argv, input });
    const joined = argv.join(" ");
    if (joined.startsWith("buildx imagetools inspect --raw")) {
      return { status: 0, stdout: manifest(platforms), stderr: "" };
    }
    if (joined.startsWith("buildx imagetools inspect")) {
      const ref = argv[3];
      if (inspectError) return { status: 1, stdout: "", stderr: inspectError };
      return held[ref]
        ? { status: 0, stdout: `${held[ref]}\n`, stderr: "" }
        : { status: 1, stdout: "", stderr: `ERROR: ${ref}: not found\n` };
    }
    if (joined.startsWith("buildx build") && buildStatus === 0 && argv.includes("--push")) {
      held[argv[argv.indexOf("--tag") + 1]] = digest("e");
    }
    return { status: buildStatus, stdout: "", stderr: "" };
  };
  const code = main(args, {
    run,
    read: (p) => files[p],
    write: (p, text) => (files[p] = text),
    log: (s) => out.push(s),
    now: new Date("2027-01-01T06:00:00Z"),
  });
  return { code, calls, out: out.join("\n"), files };
}

const TAG = `${IMAGE}:${inputsTag(DOCKERFILE, claudeCode().identity.version)}`;
const builds = (r) => r.calls.filter((c) => c.argv[1] === "build");

describe("publish", () => {
  it("builds and pushes both platforms when the inputs tag is absent", () => {
    const r = script(["publish", "claude-code"]);
    assert.equal(r.code, 0, r.out);
    const [build] = builds(r);
    assert.deepEqual(build.argv, [
      "buildx",
      "build",
      "--platform",
      "linux/amd64,linux/arm64",
      "--provenance=false",
      "--build-arg",
      `CLI_VERSION=${claudeCode().identity.version}`,
      "--label",
      "org.opencontainers.image.source=https://github.com/mnaimfaizy/agent-kit",
      "--tag",
      TAG,
      "--push",
      "-",
    ]);
    assert.equal(build.input, DOCKERFILE, "no build context: the Dockerfile on stdin");
    assert.ok(r.out.includes(`${IMAGE}@${digest("e")}`), r.out);
  });

  it("builds nothing when the tag is there, so a recorded digest stays", () => {
    const r = script(["publish", "claude-code"], { tags: { [TAG]: digest("a") } });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(builds(r), []);
    assert.ok(r.out.includes(`${IMAGE}@${digest("a")}`), r.out);
  });

  it("builds nothing when the registry's answer is not a plain 'not found'", () => {
    const r = script(["publish", "claude-code"], { inspectError: "429 Too Many Requests" });
    assert.equal(r.code, 1);
    assert.deepEqual(builds(r), []);
    assert.match(r.out, /429 Too Many Requests/);
  });

  it("builds nothing when a local tool is what was not found", () => {
    const inspectError =
      "error getting credentials: docker-credential-x: executable file not found";
    const r = script(["publish", "claude-code"], { inspectError });
    assert.equal(r.code, 1);
    assert.deepEqual(builds(r), []);
  });

  it("fails when the build fails", () => {
    assert.equal(script(["publish", "claude-code"], { buildStatus: 1 }).code, 1);
  });

  it("build only, for a fork: no push and no tag asked for", () => {
    const r = script(["build", "claude-code"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.calls.length, 1);
    assert.ok(!r.calls[0].argv.includes("--push"));
  });
});

describe("check", () => {
  const tags = { [TAG]: digest("a") };

  it("passes when the adapter records the digest of this pin's image", () => {
    const r = script(["check", "claude-code"], { tags, recorded: digest("a") });
    assert.equal(r.code, 0, r.out);
  });

  it("fails, naming the digest to record, when the adapter records another", () => {
    const r = script(["check", "claude-code"], { tags, recorded: digest("0") });
    assert.equal(r.code, 1);
    assert.ok(r.out.includes(digest("a")), r.out);
    assert.match(r.out, /node docker\/harness-images\/image\.mjs record claude-code/);
  });

  it("fails when the tag beside the digest is another pin's", () => {
    const r = script(["check", "claude-code"], {
      tags,
      recorded: digest("a"),
      recordedTag: "inputs-old",
    });
    assert.equal(r.code, 1);
  });

  it("fails when no image of this pin was ever pushed", () => {
    const r = script(["check", "claude-code"], { recorded: digest("a") });
    assert.equal(r.code, 1);
    assert.match(r.out, /not been pushed/);
  });

  it("fails when the image lacks a platform", () => {
    const r = script(["check", "claude-code"], {
      tags,
      recorded: digest("a"),
      platforms: ["linux/amd64"],
    });
    assert.equal(r.code, 1);
    assert.match(r.out, /linux\/arm64/);
  });
});

describe("record and refresh", () => {
  it("record writes the pushed digest into the adapter", () => {
    const r = script(["record", "claude-code"], { tags: { [TAG]: digest("a") } });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.files["cli/src/harness/claude-code.mjs"].includes(digest("a")));
  });

  it("refresh rewrites every Dockerfile with the bases' current digests", () => {
    const tags = {
      "node:24-trixie-slim": digest("1"),
      "debian:trixie-slim": digest("2"),
    };
    const r = script(["refresh"], { tags });
    assert.equal(r.code, 0, r.out);
    const text = r.files["docker/harness-images/claude-code.Dockerfile"];
    assert.ok(text.includes(digest("1")) && text.includes(digest("2")), text);
    assert.match(text, /^ARG REFRESHED=2027-01-01$/m);
  });

  it("refuses an unknown command or harness", () => {
    assert.equal(script(["publish", "nope"]).code, 2);
    assert.equal(script(["nope"]).code, 2);
  });
});
