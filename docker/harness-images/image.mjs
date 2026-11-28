// The Harness images (ADR 0029), as .github/workflows/harness-images.yml and
// harness-images-refresh.yml run them:
//
//   node docker/harness-images/image.mjs publish <harness>
//     Build and push the image of the current pin for amd64 and arm64, unless
//     it is there already.
//   node docker/harness-images/image.mjs build <harness>
//     Build it without pushing (a pull request from a fork).
//   node docker/harness-images/image.mjs check <harness>
//     Fail unless the adapter records that image's digest.
//   node docker/harness-images/image.mjs record <harness>
//     Write that digest, and the inputs tag it came from, into the adapter.
//   node docker/harness-images/image.mjs refresh
//     Move every Dockerfile to its bases' current digests and today's date.
//
// An image is tagged with a hash of its inputs (its Dockerfile and the CLI
// version), and an existing tag is never rebuilt: a rebuild would give another
// digest for the same pin. Nothing pulls by that tag; the Launcher pulls by
// the digest the adapter records.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claudeCode } from "../../cli/src/harness/claude-code.mjs";

/** Each Harness image: its adapter, the adapter's source and the Dockerfile. */
export const HARNESSES = Object.freeze({
  "claude-code": {
    adapter: claudeCode,
    source: "cli/src/harness/claude-code.mjs",
    dockerfile: "docker/harness-images/claude-code.Dockerfile",
  },
});

export const PLATFORMS = Object.freeze(["linux/amd64", "linux/arm64"]);

const SOURCE_LABEL = "org.opencontainers.image.source=https://github.com/mnaimfaizy/agent-kit";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DIGEST_LINE = /^const IMAGE_DIGEST = "[^"]*";.*$/m;

class Failed extends Error {}

/**
 * The tag of the image built from this Dockerfile and CLI version.
 * @param {string} dockerfile its text
 * @param {string} version
 */
export function inputsTag(dockerfile, version) {
  const hash = createHash("sha256")
    .update(`${version}\n${dockerfile.replace(/\r\n?/g, "\n")}`)
    .digest("hex");
  return `inputs-${hash.slice(0, 32)}`;
}

/**
 * An adapter's source with `digest` as its recorded Harness image digest, and
 * beside it the inputs tag the image was built under. A contract test holds
 * that tag to the current Dockerfile and CLI version without a registry, so a
 * pin changed with no new digest fails the tests on every pull request.
 * @param {string} source
 * @param {string} digest
 * @param {string} tag
 */
export function recordDigest(source, digest, tag) {
  if (!DIGEST.test(digest)) throw new Failed(`not a sha256 digest: ${JSON.stringify(digest)}`);
  if (!DIGEST_LINE.test(source)) throw new Failed("the adapter has no `const IMAGE_DIGEST` line.");
  return source.replace(DIGEST_LINE, `const IMAGE_DIGEST = "${digest}"; // ${tag}`);
}

/**
 * A Dockerfile with each `FROM <tag>@<digest>` at the digest `resolve(tag)`
 * gives, and its REFRESHED date moved, so the packages are taken again, even
 * on a second refresh in one month (a security fix).
 * @param {string} text
 * @param {{ resolve: (tag: string) => string, date: string }} opts
 */
export function refreshDockerfile(text, { resolve, date }) {
  const refreshed = /^ARG REFRESHED=.*$/m;
  if (!refreshed.test(text)) throw new Failed("the Dockerfile has no `ARG REFRESHED=` line.");
  return text
    .replace(/^FROM (\S+?)@sha256:[0-9a-f]{64}/gm, (_, tag) => `FROM ${tag}@${resolve(tag)}`)
    .replace(refreshed, `ARG REFRESHED=${date}`);
}

function docker(argv, { input } = {}) {
  // A build's progress goes straight to the log; an inspect's answer is read.
  const building = argv[1] === "build";
  const r = spawnSync("docker", argv, {
    input,
    encoding: "utf8",
    stdio: ["pipe", building ? "inherit" : "pipe", building ? "inherit" : "pipe"],
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? r.error?.message ?? "" };
}

const ROOT = new URL("../../", import.meta.url);

/**
 * @param {string[]} argv the command and, but for `refresh`, the harness
 * @returns {number} the exit code: 0 done, 1 failed, 2 usage
 */
export function main(
  argv,
  {
    run = docker,
    read = (path) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8"),
    write = (path, text) => writeFileSync(fileURLToPath(new URL(path, ROOT)), text),
    log = console.log,
    now = new Date(),
  } = {},
) {
  const [command, name] = argv;
  const usage = () => {
    log(
      `usage: image.mjs publish|build|check|record <${Object.keys(HARNESSES).join("|")}> | refresh`,
    );
    return 2;
  };

  /** The digest `ref` names in its registry, or null when it has no such tag. */
  const digestOf = (ref) => {
    const r = run(["buildx", "imagetools", "inspect", ref, "--format", "{{.Manifest.Digest}}"]);
    if (r.status !== 0) {
      // Only the registry's "not found" for this reference means absent: after
      // any other answer (a rate limit, an outage, a missing credential
      // helper) a build would move the tag off a recorded digest.
      if (r.stderr.includes(`${ref}: not found`)) return null;
      if (/manifest unknown|name unknown/i.test(r.stderr)) return null;
      throw new Failed(`could not inspect ${ref}: ${r.stderr.trim()}`);
    }
    const digest = r.stdout.trim();
    if (!DIGEST.test(digest)) throw new Failed(`no digest for ${ref}: ${JSON.stringify(digest)}`);
    return digest;
  };

  try {
    if (command === "refresh") {
      const date = now.toISOString().slice(0, 10);
      const resolve = (tag) => {
        const digest = digestOf(tag);
        if (digest === null) throw new Failed(`the base ${tag} was not found.`);
        return digest;
      };
      for (const { dockerfile } of Object.values(HARNESSES)) {
        write(dockerfile, refreshDockerfile(read(dockerfile), { resolve, date }));
        log(`Refreshed ${dockerfile} to ${date}.`);
      }
      return 0;
    }

    if (!["publish", "build", "check", "record"].includes(command)) return usage();
    if (!Object.hasOwn(HARNESSES, name ?? "")) return usage();
    const harness = HARNESSES[name];
    const plan = harness.adapter();
    const [image] = plan.installLayer.image.split("@");
    const { version } = plan.identity;
    const dockerfile = read(harness.dockerfile);
    const tag = inputsTag(dockerfile, version);
    const ref = `${image}:${tag}`;

    const build = (extra) => {
      const r = run(
        [
          "buildx",
          "build",
          "--platform",
          PLATFORMS.join(","),
          "--provenance=false",
          "--build-arg",
          `CLI_VERSION=${version}`,
          "--label",
          SOURCE_LABEL,
          ...extra,
          "-",
        ],
        { input: dockerfile },
      );
      if (r.status !== 0) throw new Failed(`building ${ref} failed: ${r.stderr.trim()}`);
    };

    if (command === "build") {
      build([]);
      log(`Built ${name} ${version} for ${PLATFORMS.join(" and ")}; nothing pushed.`);
      return 0;
    }

    let digest = digestOf(ref);
    if (command === "publish") {
      if (digest === null) {
        build(["--tag", ref, "--push"]);
        digest = digestOf(ref);
        if (digest === null) throw new Failed(`${ref} is not there after its push.`);
        log(`Pushed ${ref}`);
      } else {
        log(`Already pushed, not rebuilt: ${ref}`);
      }
      log(`${image}@${digest}`);
      return 0;
    }

    if (digest === null) {
      throw new Failed(`the image of this pin has not been pushed: ${ref}`);
    }
    if (command === "record") {
      write(harness.source, recordDigest(read(harness.source), digest, tag));
      log(`Recorded ${image}@${digest} in ${harness.source}.`);
      return 0;
    }

    const raw = run(["buildx", "imagetools", "inspect", "--raw", `${image}@${digest}`]);
    if (raw.status !== 0) throw new Failed(`could not read ${image}@${digest}: ${raw.stderr}`);
    const platforms = (JSON.parse(raw.stdout).manifests ?? []).map(
      (m) => `${m.platform?.os}/${m.platform?.architecture}`,
    );
    const missing = PLATFORMS.filter((p) => !platforms.includes(p));
    if (missing.length) throw new Failed(`${ref} lacks ${missing.join(" and ")}.`);
    const source = read(harness.source);
    if (recordDigest(source, digest, tag) !== source) {
      const held = DIGEST_LINE.exec(source)[0];
      throw new Failed(
        [
          `${harness.source} holds \`${held}\`, and the image of this pin is ${digest}.`,
          `Record it: node docker/harness-images/image.mjs record ${name} (logged in to ghcr.io),`,
          `or write \`const IMAGE_DIGEST = "${digest}"; // ${tag}\` there, then commit and push.`,
        ].join("\n"),
      );
    }
    log(`${harness.source} records the image of this pin: ${image}@${digest}`);
    return 0;
  } catch (e) {
    if (!(e instanceof Failed)) throw e;
    log(e.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
