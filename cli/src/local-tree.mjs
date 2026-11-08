// Git tree hashes of paths in the local working copy, as they would be if the
// working copy were committed now (tracked and untracked files, minus ignored
// ones, after git's own line-ending rules).
//
// Read-only: git runs against a temporary index built from HEAD, and writes
// any new objects to a temporary object directory, reading existing ones
// through GIT_ALTERNATE_OBJECT_DIRECTORIES. The Consumer's index, object
// store and refs are never written. Because the temporary index holds only
// HEAD plus the Kit-owned paths, a merge conflict elsewhere in the
// repository does not get in the way.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstLine } from "./exec.mjs";

const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/$/;

export const SPARSE_REASON =
  "outside the sparse-checkout cone, so its files are not in the working copy";

export class LocalTreeError extends Error {}

/**
 * @param {{ runner: import("./exec.mjs").Runner, cwd: string, paths: string[] }} opts
 * @returns {{ root: string, hashes: Map<string, string | null>, skipped: Map<string, string> }}
 *   A null hash means the path is missing locally; `skipped` holds paths that
 *   could not be compared, with the reason.
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
  const base = ["-C", root, "-c", "core.fsmonitor=false", "--literal-pathspecs"];
  const objectsPath = runner("git", [
    "-C",
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "objects",
  ]);
  if (objectsPath.status !== 0) {
    throw new LocalTreeError(`git rev-parse failed: ${firstLine(objectsPath.stderr)}`);
  }
  const realObjects = objectsPath.stdout.trim();
  const hasHead = runner("git", [...base, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);

  const skipped = new Map();
  const tmp = mkdtempSync(join(tmpdir(), "agent-kit-tree-"));
  try {
    const index = join(tmp, "index");
    const objects = join(tmp, "objects");
    mkdirSync(objects);
    const env = {
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: realObjects,
    };
    const git = (...args) => runner("git", [...base, ...args], { env });
    // HEAD gives tracked files their recorded modes (core.fileMode=false on
    // Windows would otherwise drop executable bits).
    if (hasHead.status === 0) {
      const read = git("read-tree", "HEAD");
      if (read.status !== 0)
        throw new LocalTreeError(`git read-tree HEAD failed: ${firstLine(read.stderr)}`);
    }

    const hashes = new Map();
    for (const path of paths) {
      // The real index (read only) knows the sparse-checkout cone: `S` marks
      // skip-worktree entries, which have no files on disk to compare.
      const tags = runner("git", [...base, "ls-files", "-t", "--", path]);
      if (tags.status === 0 && tags.stdout.split("\n").some((l) => l.startsWith("S "))) {
        skipped.set(path, SPARSE_REASON);
        continue;
      }
      const add = git("add", "--all", "--", path);
      if (add.status !== 0 && existsSync(join(root, path))) {
        throw new LocalTreeError(`git add ${path} failed: ${firstLine(add.stderr)}`);
      }
      const listed = git("ls-files", "--", path);
      if (listed.status !== 0 || listed.stdout.trim() === "") {
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
    return { root, hashes, skipped };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
