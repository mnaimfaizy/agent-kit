// Fetches Agent-kit tags into a throwaway bare repository and reads files,
// file lists and tree hashes from them. Nothing is bundled in the npm
// package: the git tag Consumers pin in `uses:` is the only source of kit
// files (ADR 0001). One repository can hold two tags, so `upgrade` can diff
// them.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_PATTERN } from "./checks/result.mjs";
import { firstLine } from "./exec.mjs";
import { parseKitOwnedPaths } from "./kit-owned-paths.mjs";
import { caseCollisions, checkSafePath, fileDirConflicts } from "./safe-paths.mjs";
import { FIRST_MANIFEST_TAG, isReleaseTag } from "./tags.mjs";

const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/;
export const DEFAULT_SERVER = "https://github.com";
const SERVER = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;

/** File modes the CLI copies: a regular file, or an executable one. */
const FILE_MODES = new Set(["100644", "100755"]);
const MODE_NAMES = { 120000: "a symbolic link", 160000: "a submodule" };
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

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

function checkArgs({ repo, serverUrl }) {
  if (!REPO_PATTERN.test(repo)) {
    throw new KitTagError(`not a GitHub repository name: ${JSON.stringify(repo)}`);
  }
  if (!SERVER.test(serverUrl)) {
    throw new KitTagError(`not a GitHub server URL: ${JSON.stringify(serverUrl)}`);
  }
}

/**
 * Open a throwaway bare repository for `repo`, to fetch one or more tags
 * into. Call `cleanup()` when done.
 *
 * @param {{
 *   runner: import("./exec.mjs").Runner,
 *   repo: string,
 *   serverUrl?: string,   // https://github.com, or a GitHub Enterprise Server host
 *   remoteUrl?: string,   // tests: fetch from here instead
 * }} opts
 */
export function openKitRepo({ runner, repo, serverUrl = DEFAULT_SERVER, remoteUrl }) {
  checkArgs({ repo, serverUrl });
  const url = remoteUrl ?? `${serverUrl}/${repo}.git`;
  const tmp = mkdtempSync(join(tmpdir(), "agent-kit-tag-"));
  const dir = join(tmp, "repo.git");
  const noHooks = join(tmp, "no-hooks");
  mkdirSync(noHooks);
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  // No hooks run, whatever the adopter's global git config says.
  const base = ["-C", dir, "-c", `core.hooksPath=${noHooks}`];
  const git = (...args) => runner("git", [...base, ...args]);
  const gitBytes = (...args) => runner("git", [...base, ...args], { encoding: "buffer" });
  try {
    const r = runner("git", ["init", "--bare", "--quiet", "--template=", dir]);
    if (r.status !== 0) throw new KitTagError(`git init failed: ${firstLine(r.stderr)}`);
  } catch (err) {
    cleanup();
    throw err;
  }

  /**
   * Fetch `tag` into the repository. It must carry kit-owned-paths.txt, or
   * this throws PreManifestTagError.
   */
  const fetchTag = (tag, { forDeletion = true } = {}) => {
    if (!isReleaseTag(tag)) throw new KitTagError(`not a Release-line tag: ${JSON.stringify(tag)}`);
    let r = git(
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

    /**
     * Every file under folder `path` at the tag, as `{ path, mode, oid }`.
     * Throws KitTagError for anything that is not a regular or executable
     * file (a symbolic link, a submodule), for a file path that is not safe
     * to write on every platform, and for two paths that would be one file
     * on a case-insensitive file system.
     */
    const listFiles = (path) => {
      const folder = checkPath(path);
      const res = git("ls-tree", "-r", "-z", "--full-tree", commit, "--", folder);
      if (res.status !== 0) {
        throw new KitTagError(`could not list ${folder}/ at ${tag}: ${firstLine(res.stderr)}`);
      }
      const files = [];
      for (const entry of res.stdout.split("\0").filter(Boolean)) {
        const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(entry);
        if (!m) throw new KitTagError(`unexpected git ls-tree output at ${tag}`);
        const [, mode, type, oid, file] = m;
        if (!file.startsWith(`${folder}/`)) continue;
        if (!FILE_MODES.has(mode) || type !== "blob" || !OID.test(oid)) {
          const kind = MODE_NAMES[mode] ?? `mode ${mode}`;
          throw new KitTagError(
            `${tag} has ${JSON.stringify(file)} as ${kind}; the CLI copies only regular files`,
          );
        }
        try {
          checkSafePath(file, `${tag} file`);
        } catch (err) {
          throw new KitTagError(err.message);
        }
        files.push({ path: file, mode, oid });
      }
      const names = files.map((f) => f.path);
      const collisions = caseCollisions(names);
      if (collisions.length) {
        throw new KitTagError(
          `${tag} has files that differ only in case, which would overwrite each other on ` +
            `Windows and macOS: ${collisions.map((g) => g.join(" and ")).join("; ")}`,
        );
      }
      const conflicts = fileDirConflicts(names);
      if (conflicts.length) {
        throw new KitTagError(
          `${tag} has ${conflicts[0][0]} as both a file and a folder (${conflicts[0][1]})`,
        );
      }
      return files;
    };

    /** The exact bytes of a blob listed by listFiles, as a Buffer. */
    const readBlob = (oid) => {
      if (!OID.test(oid)) throw new KitTagError(`not a git object id: ${JSON.stringify(oid)}`);
      const res = gitBytes("cat-file", "blob", oid);
      if (res.status !== 0 || !Buffer.isBuffer(res.stdout)) {
        throw new KitTagError(`could not read ${oid} at ${tag}: ${firstLine(res.stderr)}`);
      }
      return res.stdout;
    };

    const manifest = readFile("kit-owned-paths.txt");
    if (manifest === null) throw new PreManifestTagError(repo, tag, serverUrl);
    const kitOwnedPaths = parseKitOwnedPaths(manifest, { forDeletion });
    return { repo, tag, commit, serverUrl, kitOwnedPaths, readFile, treeHash, listFiles, readBlob };
  };

  /**
   * `git diff` of folder `path` between two fetched tags, as text. No
   * external diff tool or textconv filter from the adopter's git config runs.
   */
  const diff = (oldSnapshot, newSnapshot, path) => {
    const folder = checkPath(path);
    const res = git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      oldSnapshot.commit,
      newSnapshot.commit,
      "--",
      `${folder}/`,
    );
    if (res.status !== 0) throw new KitTagError(`git diff failed: ${firstLine(res.stderr)}`);
    return res.stdout;
  };

  return { repo, serverUrl, fetchTag, diff, cleanup };
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
  checkArgs({ repo, serverUrl });
  // Checked before any git runs, so a bad tag never reaches the command line.
  if (!isReleaseTag(tag)) throw new KitTagError(`not a Release-line tag: ${JSON.stringify(tag)}`);
  const kit = openKitRepo({ runner, repo, serverUrl, remoteUrl });
  try {
    return { ...kit.fetchTag(tag, { forDeletion }), cleanup: kit.cleanup };
  } catch (err) {
    kit.cleanup();
    throw err;
  }
}
