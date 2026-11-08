// Fetches one Agent-kit tag into a throwaway bare repository and reads files
// and tree hashes from it. Nothing is bundled in the npm package: the git tag
// Consumers pin in `uses:` is the only source of kit files (ADR 0001).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_PATTERN } from "./checks/result.mjs";
import { firstLine } from "./exec.mjs";
import { parseKitOwnedPaths } from "./kit-owned-paths.mjs";
import { FIRST_MANIFEST_TAG, isReleaseTag } from "./tags.mjs";

const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/;
export const DEFAULT_SERVER = "https://github.com";
const SERVER = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;

export class KitTagError extends Error {}

/** A tag with no kit-owned-paths.txt (up to v1.0.0-alpha.10): the CLI refuses it. */
export class PreManifestTagError extends KitTagError {
  constructor(repo, tag, serverUrl = DEFAULT_SERVER) {
    super(
      `${tag} has no kit-owned-paths.txt, so the CLI cannot handle it ` +
        `(the manifest ships from ${FIRST_MANIFEST_TAG}). Adopt or upgrade ${tag} by hand ` +
        `with that tag's ${serverUrl}/${repo}/blob/${tag}/docs/adopt.md, ` +
        `or move your pins to ${FIRST_MANIFEST_TAG} or later.`,
    );
    this.repo = repo;
    this.tag = tag;
  }
}

function checkPath(path) {
  if (!SAFE_PATH.test(path) || path.split("/").includes("..")) {
    throw new KitTagError(`refusing to read ${JSON.stringify(path)} from the tag`);
  }
  return path.replace(/\/$/, "");
}

/**
 * Fetch `tag` of `repo`. The tag must carry kit-owned-paths.txt, or this throws
 * PreManifestTagError. Call `cleanup()` when done.
 *
 * @param {{
 *   runner: import("./exec.mjs").Runner,
 *   repo: string,
 *   tag: string,
 *   serverUrl?: string,   // https://github.com, or a GitHub Enterprise Server host
 *   remoteUrl?: string,   // tests: fetch from here instead
 *   forDeletion?: boolean // strict manifest shapes, for code that deletes paths
 * }} opts
 */
export function openKitTag({
  runner,
  repo,
  tag,
  serverUrl = DEFAULT_SERVER,
  remoteUrl,
  forDeletion = true,
}) {
  if (!REPO_PATTERN.test(repo)) {
    throw new KitTagError(`not a GitHub repository name: ${JSON.stringify(repo)}`);
  }
  if (!isReleaseTag(tag)) throw new KitTagError(`not a Release-line tag: ${JSON.stringify(tag)}`);
  if (!SERVER.test(serverUrl)) {
    throw new KitTagError(`not a GitHub server URL: ${JSON.stringify(serverUrl)}`);
  }
  const url = remoteUrl ?? `${serverUrl}/${repo}.git`;
  const tmp = mkdtempSync(join(tmpdir(), "agent-kit-tag-"));
  const dir = join(tmp, "repo.git");
  const noHooks = join(tmp, "no-hooks");
  mkdirSync(noHooks);
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  // No hooks run, whatever the adopter's global git config says.
  const git = (...args) => runner("git", ["-C", dir, "-c", `core.hooksPath=${noHooks}`, ...args]);
  try {
    let r = runner("git", ["init", "--bare", "--quiet", "--template=", dir]);
    if (r.status !== 0) throw new KitTagError(`git init failed: ${firstLine(r.stderr)}`);
    r = git(
      "fetch",
      "--quiet",
      "--depth=1",
      "--no-tags",
      "--",
      url,
      `+refs/tags/${tag}:refs/tags/${tag}`,
    );
    if (r.status !== 0) {
      throw new KitTagError(
        `could not fetch ${tag} from ${repo}: ${firstLine(r.stderr) || "git fetch failed"}`,
      );
    }
    r = git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`);
    if (r.status !== 0) throw new KitTagError(`${tag} does not point at a commit`);
    const commit = r.stdout.trim();

    const readFile = (path) => {
      const res = git("cat-file", "blob", `${commit}:${checkPath(path)}`);
      return res.status === 0 ? res.stdout : null;
    };
    const treeHash = (path) => {
      // `<rev>:<path>` takes the rest as a path, so `^{tree}` cannot follow it:
      // resolve the object, then check its type.
      const res = git("rev-parse", "--verify", "--quiet", `${commit}:${checkPath(path)}`);
      if (res.status !== 0) return null;
      const hash = res.stdout.trim();
      const type = git("cat-file", "-t", hash);
      return type.status === 0 && type.stdout.trim() === "tree" ? hash : null;
    };

    const manifest = readFile("kit-owned-paths.txt");
    if (manifest === null) throw new PreManifestTagError(repo, tag, serverUrl);
    const kitOwnedPaths = parseKitOwnedPaths(manifest, { forDeletion });
    return { repo, tag, commit, serverUrl, kitOwnedPaths, readFile, treeHash, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
