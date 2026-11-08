// What `init` and `upgrade` share for changing a Consumer's checkout: path
// checks, the uncommitted-changes check, reading Kit-owned files from a tag,
// and carrying out a plan. Both commands plan first and write second: every
// refusal (a Refusal) is raised while planning, before anything is written.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { firstLine } from "./exec.mjs";
import { EXECUTABLE_MODE } from "./kit-tag.mjs";
import { fileModeIsOff, gitSafetyArgs } from "./local-tree.mjs";
import { checkSafePath } from "./safe-paths.mjs";

/** A reason not to start. Nothing has been written when this is thrown. */
export class Refusal extends Error {
  constructor(message, details = []) {
    super(message);
    this.details = details;
  }
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * Refuse unless `rel` (a repository-relative path, no trailing slash) can be
 * deleted and written without leaving `root`: it must be a safe path, no part
 * of it may be a symbolic link or junction, and every existing parent must
 * be a folder.
 */
export function checkLocalPath(root, rel) {
  try {
    checkSafePath(rel);
  } catch (err) {
    throw new Refusal(err.message);
  }
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    const st = lstatOrNull(join(root, sub));
    if (!st) return;
    if (st.isSymbolicLink()) {
      throw new Refusal(
        `${sub} is a symbolic link or junction; the CLI does not delete or write through links. ` +
          `Replace it with a plain folder or file, then run the command again.`,
      );
    }
    if (i < parts.length && !st.isDirectory()) {
      throw new Refusal(`${sub} is a file, but ${rel} needs it to be a folder.`);
    }
  }
}

/** Links inside `rel`: never followed or guessed at. */
function linksUnder(root, rel) {
  const found = [];
  const walk = (sub) => {
    const st = lstatOrNull(join(root, sub));
    if (!st) return;
    if (st.isSymbolicLink()) found.push(sub);
    else if (st.isDirectory()) {
      for (const name of readdirSync(join(root, sub)).sort()) walk(`${sub}/${name}`);
    }
  };
  walk(rel);
  return found;
}

/** Refuse unless folder `rel` can be deleted whole: checkLocalPath, and no link inside it. */
export function checkDeletable(root, rel) {
  checkLocalPath(root, rel);
  const links = linksUnder(root, rel);
  if (links.length) {
    throw new Refusal(
      `${rel}/ holds a symbolic link or junction, which the kit never ships: ${links[0]}. ` +
        `Remove it by hand, then run the command again.`,
    );
  }
}

/** A temporary empty hooks folder and the safe git options for `root`; call done(). */
function safeGit(runner, root) {
  const tmp = mkdtempSync(join(tmpdir(), "agent-kit-git-"));
  const noHooks = join(tmp, "no-hooks");
  mkdirSync(noHooks);
  try {
    return {
      args: ["-C", root, ...gitSafetyArgs({ runner, root, noHooks }), "--literal-pathspecs"],
      done: () => rmSync(tmp, { recursive: true, force: true }),
    };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Files under `paths` with uncommitted changes (modified, staged, deleted or
 * untracked), as "XY path", and, apart, the ignored files and folders there
 * (deleting the paths deletes those too). git runs no hooks, fsmonitor or
 * filter drivers, and takes no optional locks.
 *
 * @returns {{ changed: string[], ignored: string[] }}
 */
export function uncommittedChanges({ runner, root, paths }) {
  const git = safeGit(runner, root);
  try {
    const r = runner("git", [
      ...git.args,
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--ignore-submodules=all",
      "--no-renames",
      "--",
      ...paths,
    ]);
    if (r.status !== 0) throw new Refusal(`git status failed: ${firstLine(r.stderr)}`);
    const entries = r.stdout.split("\0").filter(Boolean);
    // git status cannot see local edits to files marked assume-unchanged
    // (a lower-case tag) or skip-worktree (S): count those as changed.
    const flagged = runner("git", [...git.args, "ls-files", "-v", "-z", "--", ...paths]);
    if (flagged.status !== 0)
      throw new Refusal(`git ls-files failed: ${firstLine(flagged.stderr)}`);
    const hidden = flagged.stdout
      .split("\0")
      .filter((e) => /^(?:[a-z]|S) /.test(e))
      .map(
        (e) =>
          `${e[0]} ${e.slice(2)} (marked ${e[0] === "S" ? "skip-worktree" : "assume-unchanged"})`,
      );
    return {
      changed: [
        ...entries
          .filter((e) => !e.startsWith("!!"))
          .map((e) => `${e.slice(0, 2).trim() || "?"} ${e.slice(3)}`),
        ...hidden,
      ],
      ignored: entries.filter((e) => e.startsWith("!!")).map((e) => e.slice(3)),
    };
  } finally {
    git.done();
  }
}

/**
 * Every file of every Kit-owned path at the tag, with its bytes, ready to
 * write. Refuses a listed path with no files.
 *
 * @returns {{ path: string, mode: string, bytes: Buffer }[]}
 */
export function kitFileWrites(snap) {
  const writes = [];
  for (const path of snap.kitOwnedPaths) {
    const listed = snap.listFiles(path);
    if (listed.length === 0) {
      throw new Refusal(
        `${snap.tag}'s kit-owned-paths.txt lists ${path}, but the tag has no files there.`,
      );
    }
    for (const f of listed) {
      writes.push({ path: f.path, mode: f.mode, bytes: snap.readBlob(f.oid) });
    }
  }
  return writes;
}

/**
 * Carry out a plan: delete each folder in `deletes`, then write each file.
 * Only file-system errors can stop it part-way.
 *
 * @param {string} root
 * @param {{ deletes?: string[], writes: { path: string, mode?: string, bytes: Buffer | string }[] }} plan
 */
export function applyPlan(root, { deletes = [], writes }) {
  // Checked again here: time may have passed at the confirmation prompt.
  for (const rel of deletes) checkDeletable(root, rel);
  for (const w of writes) checkLocalPath(root, w.path);
  for (const rel of deletes) rmSync(join(root, rel), { recursive: true, force: true });
  for (const w of writes) {
    const target = join(root, w.path);
    mkdirSync(dirname(target), { recursive: true });
    const executable = w.mode === EXECUTABLE_MODE;
    writeFileSync(target, w.bytes, { mode: executable ? 0o755 : 0o644 });
    if (executable) chmodSync(target, 0o755);
  }
}

/**
 * Without core.fileMode (the default on Windows) git cannot see the
 * executable bit just written, and `git add` would record the files as
 * 100644. Stage them with the bit instead, so the commit keeps the tag's
 * mode. Returns a line to print, or null when nothing was needed.
 */
export function stageExecutableBits({ runner, root, files }) {
  if (files.length === 0) return null;
  if (!fileModeIsOff(runner, root)) return null;
  const git = safeGit(runner, root);
  try {
    const r = runner("git", [...git.args, "add", "--chmod=+x", "--", ...files]);
    return r.status === 0
      ? `Staged ${files.length} executable file(s) with their executable bit (core.fileMode is off here).`
      : `Could not stage the executable bit (${firstLine(r.stderr)}); after \`git add\`, run ` +
          `\`git update-index --chmod=+x -- <file>\` for: ${files.join(", ")}`;
  } finally {
    git.done();
  }
}
