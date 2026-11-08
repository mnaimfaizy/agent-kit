// Git tree hashes of paths in the local working copy, as they would be if the
// working copy were committed now (tracked and untracked files, minus ignored
// ones, after git's own line-ending rules).
//
// Read-only: git runs against a copy of the index in a temporary folder and
// writes any new objects to a temporary object directory, reading existing
// ones through GIT_ALTERNATE_OBJECT_DIRECTORIES. The Consumer's index, object
// store and refs are never written.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstLine } from "./exec.mjs";

const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/$/;

export class LocalTreeError extends Error {}

/**
 * @param {{ runner: import("./exec.mjs").Runner, cwd: string, paths: string[] }} opts
 * @returns {{ root: string, hashes: Map<string, string | null> }} null hash: the path is missing locally.
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
  const gitPath = (name) => {
    const r = runner("git", [
      "-C",
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      name,
    ]);
    if (r.status !== 0) throw new LocalTreeError(`git rev-parse failed: ${firstLine(r.stderr)}`);
    return r.stdout.trim();
  };
  const realIndex = gitPath("index");
  const realObjects = gitPath("objects");

  const tmp = mkdtempSync(join(tmpdir(), "agent-kit-tree-"));
  try {
    const index = join(tmp, "index");
    const objects = join(tmp, "objects");
    mkdirSync(objects);
    // Start from the real index so tracked files keep their recorded modes
    // (core.fileMode=false on Windows would otherwise drop executable bits).
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const env = {
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: realObjects,
    };
    const git = (...args) =>
      runner("git", ["-C", root, "-c", "core.fsmonitor=false", "--literal-pathspecs", ...args], {
        env,
      });

    const hashes = new Map();
    for (const path of paths) {
      const add = git("add", "--all", "--", path);
      if (add.status !== 0 && !existsSync(join(root, path))) {
        hashes.set(path, null);
        continue;
      }
      if (add.status !== 0)
        throw new LocalTreeError(`git add ${path} failed: ${firstLine(add.stderr)}`);
      const tree = git("write-tree", `--prefix=${path}`);
      if (tree.status === 0) hashes.set(path, tree.stdout.trim());
      else if (!existsSync(join(root, path))) hashes.set(path, null);
      else
        throw new LocalTreeError(
          `git write-tree --prefix=${path} failed: ${firstLine(tree.stderr)}`,
        );
    }
    return { root, hashes };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
