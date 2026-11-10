// What `init` and `upgrade` share for changing a Consumer's checkout: path
// checks, the uncommitted-changes check, reading Kit-owned files from a tag,
// and carrying out a plan. Both commands plan first and write second: every
// refusal (a Refusal) is raised while planning, before anything is written.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { firstLine } from "./exec.mjs";
import { EXECUTABLE_MODE } from "./kit-tag.mjs";
import { fileModeIsOff, gitSafetyArgs, linksUnder, lstatOrNull } from "./local-tree.mjs";
import { checkSafePath } from "./safe-paths.mjs";

/** A reason not to start. Nothing has been written when this is thrown. */
export class Refusal extends Error {
  constructor(message, details = []) {
    super(message);
    this.details = details;
  }
}

/** The most items a plan or a refusal lists before "…". */
export const MAX_LISTED = 20;

/** `items`, cut to MAX_LISTED with a closing "…" when there are more. */
export function listed(items) {
  return items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), "…"] : items;
}

/** Print a refusal and its details; the exit code is 1. */
export function reportRefusal(out, err) {
  out(`REFUSED  ${err.message}`);
  for (const d of err.details ?? []) out(`      ${d}`);
  out("Nothing was changed.");
  return 1;
}

// Defined beside the link walk doctor uses (local-tree.mjs imports nothing from here).
export { lstatOrNull };

/**
 * Refuse unless `rel` (a repository-relative path, no trailing slash) can be
 * deleted and written without leaving `root`: it must be a safe path (the
 * strict rules for names that come from a tag), no part of it may be a
 * symbolic link or junction, and every existing parent must be a folder.
 */
export function checkLocalPath(root, rel, { deleted = [] } = {}) {
  try {
    checkSafePath(rel);
  } catch (err) {
    throw new Refusal(err.message);
  }
  checkNoLinks(root, rel, { deleted });
}

/**
 * Refuse unless no part of `rel` is a symbolic link or junction and every
 * existing parent is a folder. For the Consumer's own files, rewritten in
 * place, whose names need not follow the strict tag rules.
 *
 * `deleted` lists folders the plan deletes before it writes: what is on disk
 * inside them now (a file the new tag turns into a folder, say) is gone by
 * the time `rel` is written, so the walk stops there.
 */
export function checkNoLinks(root, rel, { deleted = [] } = {}) {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    if (deleted.includes(sub)) return;
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
 * Carry out a plan: delete each folder in `deletes`, write each file in
 * `writes` (paths from a tag), then each file in `rewrites` (the Consumer's
 * own files, rewritten in place, whose names need not follow the tag rules).
 * Only file-system errors can stop it part-way.
 *
 * @param {string} root
 * @param {{ deletes?: string[], writes: { path: string, mode?: string, bytes: Buffer | string }[], rewrites?: { path: string, bytes: Buffer | string }[] }} plan
 */
export function applyPlan(root, { deletes = [], writes, rewrites = [] }) {
  // Checked again here: time may have passed at the confirmation prompt.
  for (const rel of deletes) checkDeletable(root, rel);
  for (const w of writes) checkLocalPath(root, w.path, { deleted: deletes });
  for (const w of rewrites) checkNoLinks(root, w.path);
  for (const rel of deletes) rmSync(join(root, rel), { recursive: true, force: true });
  for (const w of [...writes, ...rewrites]) {
    const target = join(root, w.path);
    mkdirSync(dirname(target), { recursive: true });
    const executable = w.mode === EXECUTABLE_MODE;
    writeFileSync(target, w.bytes, { mode: executable ? 0o755 : 0o644 });
    if (executable) chmodSync(target, 0o755);
  }
}

/**
 * Without core.fileMode (the default on Windows) git cannot see an
 * executable bit on disk, and `git add` keeps the mode the index already
 * has (100644 for a new file). So stage the tag's mode: +x for each
 * executable file written, and -x for each regular file the index still
 * records as executable. Returns a line to print, or null when nothing was
 * needed.
 *
 * @param {{ runner: import("./exec.mjs").Runner, root: string, writes: { path: string, mode?: string }[] }} opts
 */
export function stageFileModes({ runner, root, writes }) {
  if (writes.length === 0 || !fileModeIsOff(runner, root)) return null;
  const git = safeGit(runner, root);
  try {
    const failed = [];
    const add = writes.filter((w) => w.mode === EXECUTABLE_MODE).map((w) => w.path);
    const regular = writes.filter((w) => w.mode !== EXECUTABLE_MODE).map((w) => w.path);
    const regularSet = new Set(regular);
    const drop = [];
    for (const batch of batches(regular)) {
      const indexed = runner("git", [...git.args, "ls-files", "-s", "-z", "--", ...batch]);
      if (indexed.status !== 0) {
        failed.push(`--chmod=-x (git ls-files: ${firstLine(indexed.stderr)}): ${batch.join(", ")}`);
        continue;
      }
      drop.push(
        ...indexed.stdout
          .split("\0")
          .filter((e) => e.startsWith(`${EXECUTABLE_MODE} `))
          .map((e) => e.slice(e.indexOf("\t") + 1))
          .filter((f) => regularSet.has(f)),
      );
    }
    for (const [flag, files] of [
      ["--chmod=+x", add],
      ["--chmod=-x", drop],
    ]) {
      for (const batch of batches(files)) {
        // --sparse: a path outside a sparse-checkout cone is refused without
        // it. git before 2.34 has no --sparse; it then gets a plain add.
        let r = runner("git", [...git.args, "add", "--sparse", flag, "--", ...batch]);
        if (r.status !== 0 && /unknown option|usage: git add/i.test(r.stderr)) {
          r = runner("git", [...git.args, "add", flag, "--", ...batch]);
        }
        if (r.status !== 0) failed.push(`${flag} (${firstLine(r.stderr)}): ${batch.join(", ")}`);
      }
    }
    if (failed.length) {
      return (
        "Could not stage the tag's file modes; after `git add`, run " +
        `\`git update-index <flag> -- <file>\` for: ${failed.join("; ")}`
      );
    }
    if (add.length + drop.length === 0) return null;
    return (
      `Staged the tag's file mode for ${add.length + drop.length} file(s) ` +
      "(core.fileMode is off here, so git cannot see it on disk)."
    );
  } finally {
    git.done();
  }
}

/** Command-line-sized slices of a file list. */
function batches(files, size = 200) {
  const out = [];
  for (let i = 0; i < files.length; i += size) out.push(files.slice(i, i + size));
  return out;
}
