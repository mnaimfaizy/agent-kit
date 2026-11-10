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

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { firstLine } from "./exec.mjs";
import { EXECUTABLE_MODE, REGULAR_MODE } from "./kit-tag.mjs";

const MODES = new Set([EXECUTABLE_MODE, REGULAR_MODE]);

const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/$/;

export const SKIP_WORKTREE_REASON =
  "some of its files are marked skip-worktree (for example by a sparse checkout) and HEAD has no copy of them to compare";
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
 * True when core.fileMode is off (the default on Windows): git then cannot
 * see an executable bit on disk and takes a file's mode from the index.
 */
export function fileModeIsOff(runner, root) {
  const r = runner("git", ["-C", root, "config", "--type=bool", "core.fileMode"]);
  return r.status === 0 && r.stdout.trim() === "false";
}

/**
 * `-c` options that keep git from running anything the checkout's or the
 * adopter's git config names: no hooks (`noHooks` is an empty folder), no
 * fsmonitor, no background maintenance, and no clean/process filter drivers.
 */
export function gitSafetyArgs({ runner, root, noHooks }) {
  const safety = [
    "-c",
    `core.hooksPath=${noHooks}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
  ];
  const listed = runner("git", ["-C", root, "config", "--name-only", "--get-regexp", "^filter\\."]);
  for (const driver of filterDrivers(listed.status === 0 ? listed.stdout.split("\n") : [])) {
    if (/[=\r\n]/.test(driver)) {
      throw new LocalTreeError(`cannot turn off git filter driver ${JSON.stringify(driver)}`);
    }
    safety.push("-c", `filter.${driver}.clean=`, "-c", `filter.${driver}.process=`);
    safety.push("-c", `filter.${driver}.required=false`);
  }
  return safety;
}

/** `lstat`, or null when nothing is there. */
export function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * The first symbolic link or junction at, above or inside the folder `path`
 * (relative to `root`, ending in /), as a path without a trailing slash, or
 * null. git looks straight through a Windows junction, stops at a symlink
 * with "beyond a symbolic link", and stores a symlink inside a folder as a
 * link entry, so this is checked before git ever sees the path.
 */
export function linkAt(root, path) {
  const folder = path.replace(/\/$/, "");
  const parts = folder.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    const st = lstatOrNull(join(root, sub));
    if (!st) return null;
    if (st.isSymbolicLink()) return sub;
  }
  const walk = (sub) => {
    for (const name of readdirSync(join(root, sub)).sort()) {
      const child = `${sub}/${name}`;
      const st = lstatOrNull(join(root, child));
      if (st?.isSymbolicLink()) return child;
      const inner = st?.isDirectory() ? walk(child) : null;
      if (inner) return inner;
    }
    return null;
  };
  return lstatOrNull(join(root, folder))?.isDirectory() ? walk(folder) : null;
}

/**
 * @param {{ runner: import("./exec.mjs").Runner, cwd: string, paths: string[] }} opts
 * @returns {{ root: string, hashes: Map<string, string | null>, skipped: Map<string, string>, notes: Map<string, string>, links: Map<string, string> }}
 *   A null hash means the path is missing locally; `skipped` holds paths that
 *   could not be compared, with the reason; `notes` explains how a path was compared;
 *   `links` maps a path that is, sits under, or holds a symbolic link or junction to
 *   that link. A linked path is never hashed.
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

    const safety = gitSafetyArgs({ runner, root, noHooks });
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

    // Without core.fileMode (the default on Windows) git cannot see an
    // executable bit on disk and takes the mode from the index: so does this.
    const trustIndexModes = fileModeIsOff(runner, root);

    const hashes = new Map();
    const skipped = new Map();
    const notes = new Map();
    const links = new Map();
    for (const path of paths) {
      const link = linkAt(root, path);
      if (link !== null) {
        links.set(path, link);
        continue;
      }
      // The real index (read only) knows skip-worktree entries (`S`), which
      // have no files on disk. Everything else comes from the working copy
      // (`git add`); only the S files are then reset to HEAD's copy, so local
      // edits and new files elsewhere in the path still count.
      const tags = real("ls-files", "-t", "-z", "--", path);
      const entries = tags.status === 0 ? tags.stdout.split("\0").filter(Boolean) : [];
      const skipFiles = entries.filter((e) => e.startsWith("S ")).map((e) => e.slice(2));
      if (skipFiles.length) {
        const inHead =
          head.status === 0
            ? real("ls-tree", "-r", "-z", "--name-only", "HEAD", "--", path)
            : { status: 1, stdout: "" };
        const committed = new Set(inHead.stdout.split("\0").filter(Boolean));
        if (inHead.status !== 0 || skipFiles.some((f) => !committed.has(f))) {
          skipped.set(path, SKIP_WORKTREE_REASON);
          continue;
        }
      }
      // --sparse: in a sparse checkout, a path outside the cone may still have
      // stray files on disk, and plain `git add` refuses to touch it. git
      // before 2.34 has no --sparse; it then gets a plain add.
      let add = git("add", "--all", "--sparse", "--", path);
      if (add.status !== 0 && /unknown option|usage: git add/i.test(add.stderr)) {
        add = git("add", "--all", "--", path);
      }
      // Two refusals that still stage what can be staged, then exit 1: files
      // force-added under an ignored folder, and (old git) a path outside
      // the sparse-checkout definition.
      const benign =
        /ignored by one of your \.gitignore files|outside of your sparse-checkout definition/i.test(
          add.stderr,
        );
      if (add.status !== 0 && !benign && existsSync(join(root, path))) {
        throw new LocalTreeError(`git add ${path} failed: ${firstLine(add.stderr)}`);
      }
      for (let i = 0; i < skipFiles.length; i += 200) {
        const reset = git("reset", "--quiet", "HEAD", "--", ...skipFiles.slice(i, i + 200));
        if (reset.status !== 0) {
          throw new LocalTreeError(
            `git reset of skip-worktree files failed: ${firstLine(reset.stderr)}`,
          );
        }
      }
      if (trustIndexModes) {
        const modes = (res) =>
          new Map(
            (res.status === 0 ? res.stdout.split("\0") : [])
              .filter(Boolean)
              .map((e) => [e.slice(e.indexOf("\t") + 1), e.slice(0, 6)]),
          );
        const inReal = modes(real("ls-files", "-s", "-z", "--", path));
        const inTemp = modes(git("ls-files", "-s", "-z", "--", path));
        // Both directions: the real index may have gained or lost the bit.
        for (const [want, flag] of [
          [EXECUTABLE_MODE, "--chmod=+x"],
          [REGULAR_MODE, "--chmod=-x"],
        ]) {
          const fix = [...inReal]
            .filter(
              ([f, mode]) => mode === want && MODES.has(inTemp.get(f)) && inTemp.get(f) !== want,
            )
            .map(([f]) => f);
          for (let i = 0; i < fix.length; i += 200) {
            const chmod = git("update-index", flag, "--", ...fix.slice(i, i + 200));
            if (chmod.status !== 0) {
              throw new LocalTreeError(
                `git update-index ${flag} failed: ${firstLine(chmod.stderr)}`,
              );
            }
          }
        }
      }
      const inIndex = git("ls-files", "-z", "--", path);
      const staged = inIndex.status === 0 ? inIndex.stdout.split("\0").filter(Boolean) : [];
      if (staged.length === 0) {
        hashes.set(path, null);
        continue;
      }
      if (skipFiles.length) {
        // The HEAD-only wording only when nothing came from the working copy.
        notes.set(
          path,
          staged.length === skipFiles.length
            ? HEAD_COPY_NOTE
            : `${skipFiles.length} of its ${staged.length} files are marked skip-worktree and were compared as committed at HEAD; the rest came from the working copy`,
        );
      }
      const tree = git("write-tree", `--prefix=${path}`);
      if (tree.status !== 0) {
        throw new LocalTreeError(
          `git write-tree --prefix=${path} failed: ${firstLine(tree.stderr)}`,
        );
      }
      hashes.set(path, tree.stdout.trim());
    }
    return { root, hashes, skipped, notes, links };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
