// Git tree hashes of paths in the local working copy, as they would be if the
// working copy were committed now (tracked and untracked files, minus ignored
// ones, after git's own line-ending rules).
//
// Read-only: git runs against a temporary index built from HEAD, and writes
// any new objects to a temporary object directory that borrows the
// repository's objects through objects/info/alternates. The Consumer's index,
// object store and refs are never written. Because the temporary index holds
// only HEAD plus the Kit-owned paths, a merge conflict elsewhere in the
// repository does not get in the way.
//
// git runs no hooks (core.hooksPath is an empty folder), no fsmonitor, and no
// configured clean/process filter drivers, so hashing a checkout runs no
// command that the checkout's or the adopter's git config names.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { firstLine } from "./exec.mjs";

const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/$/;

export const SKIP_WORKTREE_REASON =
  "its files are marked skip-worktree (for example by a sparse checkout) and HEAD has no copy to compare";
export const HEAD_COPY_NOTE =
  "its files are marked skip-worktree (for example by a sparse checkout), so the copy committed at HEAD was compared";

export class LocalTreeError extends Error {}

/** `filter.<driver>.<key>` config names → the driver names. */
export function filterDrivers(configNames) {
  const drivers = new Set();
  for (const raw of configNames) {
    const m = /^filter\.(.+)\.[^.]+$/i.exec(raw.trim());
    if (m) drivers.add(m[1]);
  }
  return [...drivers];
}

/**
 * @param {{ runner: import("./exec.mjs").Runner, cwd: string, paths: string[] }} opts
 * @returns {{ root: string, hashes: Map<string, string | null>, skipped: Map<string, string>, notes: Map<string, string> }}
 *   A null hash means the path is missing locally; `skipped` holds paths that
 *   could not be compared, with the reason; `notes` explains how a path was compared.
 */
export function localTreeHashes({ runner, cwd, paths }) {
  for (const p of paths) {
    if (!SAFE_PATH.test(p) || p.split("/").includes("..")) {
      throw new LocalTreeError(`refusing to hash ${JSON.stringify(p)}`);
    }
  }
  const top = runner("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw new LocalTreeError(`not a git repository: ${firstLine(top.stderr)}`);
  const root = top.stdout.trim();
  // --git-common-dir (not --path-format=absolute, which needs git 2.31) may
  // be relative to `root`; the objects of a linked worktree live there too.
  const common = runner("git", ["-C", root, "rev-parse", "--git-common-dir"]);
  if (common.status !== 0) {
    throw new LocalTreeError(`git rev-parse failed: ${firstLine(common.stderr)}`);
  }
  const commonDir = common.stdout.trim();
  const realObjects = join(isAbsolute(commonDir) ? commonDir : resolve(root, commonDir), "objects");
  if (/[\r\n]/.test(realObjects) || realObjects.startsWith('"')) {
    throw new LocalTreeError("the repository path cannot be written to an alternates file");
  }

  const tmp = mkdtempSync(join(tmpdir(), "agent-kit-tree-"));
  try {
    const index = join(tmp, "index");
    const objects = join(tmp, "objects");
    const noHooks = join(tmp, "no-hooks");
    mkdirSync(join(objects, "info"), { recursive: true });
    mkdirSync(noHooks);
    // An alternates file, not GIT_ALTERNATE_OBJECT_DIRECTORIES: that variable
    // splits on ':' on POSIX, so a path containing one would break it.
    writeFileSync(join(objects, "info", "alternates"), `${realObjects}\n`);

    const safety = [
      "-c",
      `core.hooksPath=${noHooks}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "gc.auto=0",
    ];
    const listed = runner("git", [
      "-C",
      root,
      "config",
      "--name-only",
      "--get-regexp",
      "^filter\\.",
    ]);
    for (const driver of filterDrivers(listed.status === 0 ? listed.stdout.split("\n") : [])) {
      if (/[=\r\n]/.test(driver)) {
        throw new LocalTreeError(`cannot turn off git filter driver ${JSON.stringify(driver)}`);
      }
      safety.push("-c", `filter.${driver}.clean=`, "-c", `filter.${driver}.process=`);
      safety.push("-c", `filter.${driver}.required=false`);
    }
    const base = ["-C", root, ...safety, "--literal-pathspecs"];
    const env = { GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: objects };
    const git = (...args) => runner("git", [...base, ...args], { env });
    const real = (...args) => runner("git", [...base, ...args]);

    const head = real("rev-parse", "--verify", "--quiet", "HEAD^{commit}");
    // HEAD gives tracked files their recorded modes (core.fileMode=false on
    // Windows would otherwise drop executable bits).
    if (head.status === 0) {
      const read = git("read-tree", "HEAD");
      if (read.status !== 0) {
        throw new LocalTreeError(`git read-tree HEAD failed: ${firstLine(read.stderr)}`);
      }
    }

    const hashes = new Map();
    const skipped = new Map();
    const notes = new Map();
    for (const path of paths) {
      // The real index (read only) knows skip-worktree entries (`S`), which
      // have no files on disk: compare what HEAD has instead.
      const tags = real("ls-files", "-t", "--", path);
      if (tags.status === 0 && tags.stdout.split("\n").some((l) => l.startsWith("S "))) {
        const committed = real("rev-parse", "--verify", "--quiet", `HEAD:${path.slice(0, -1)}`);
        if (committed.status === 0) {
          hashes.set(path, committed.stdout.trim());
          notes.set(path, HEAD_COPY_NOTE);
        } else {
          skipped.set(path, SKIP_WORKTREE_REASON);
        }
        continue;
      }
      const add = git("add", "--all", "--", path);
      // Files force-added under an ignored folder: git still stages the
      // tracked ones, then exits 1 to say the path is ignored.
      const ignoredOnly = /ignored by one of your \.gitignore files/i.test(add.stderr);
      if (add.status !== 0 && !ignoredOnly && existsSync(join(root, path))) {
        throw new LocalTreeError(`git add ${path} failed: ${firstLine(add.stderr)}`);
      }
      const inIndex = git("ls-files", "--", path);
      if (inIndex.status !== 0 || inIndex.stdout.trim() === "") {
        hashes.set(path, null);
        continue;
      }
      const tree = git("write-tree", `--prefix=${path}`);
      if (tree.status !== 0) {
        throw new LocalTreeError(
          `git write-tree --prefix=${path} failed: ${firstLine(tree.stderr)}`,
        );
      }
      hashes.set(path, tree.stdout.trim());
    }
    return { root, hashes, skipped, notes };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
