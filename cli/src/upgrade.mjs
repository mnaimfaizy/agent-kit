// `agent-kit upgrade --tag vY`: move a Consumer from the tag its pins name to
// vY. It replaces each Kit-owned path whole (delete, then copy from vY),
// deletes paths only the old tag listed, rewrites the `@ref` of every
// Agent-kit `uses:` pin, prints the examples/ diff for the Consumer to apply
// by hand, and then runs doctor's file and pin checks.
//
// Plan first, then write: every file is read from the tag and every refusal
// is checked before anything on disk changes, so a refusal never leaves a
// half-upgraded checkout. It writes only local files.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PinRewriteError, readWorkflows, rewriteKitPins } from "./callers.mjs";
import { checkKitOwnedTrees } from "./checks/kit-owned-trees.mjs";
import { checkPins } from "./checks/pins.mjs";
import { result } from "./checks/result.mjs";
import { formatResult } from "./doctor.mjs";
import { firstLine } from "./exec.mjs";
import { openKitRepo, PreManifestTagError, serverFromEnv } from "./kit-tag.mjs";
import {
  applyPlan,
  checkDeletable,
  checkLocalPath,
  checkNoLinks,
  kitFileWrites,
  Refusal,
  stageFileModes,
  uncommittedChanges,
} from "./local-writes.mjs";
import { caseCollisions } from "./safe-paths.mjs";
import { compareTags } from "./tags.mjs";

const MAX_LISTED = 20;
const BOM = "\ufeff";
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A workflow file's text, or a Refusal when it is not UTF-8 (rewriting it would corrupt it). */
function readWorkflowText(root, path) {
  // The Consumer's own file, rewritten in place: any name it has is fine.
  checkNoLinks(root, path);
  const raw = readFileSync(join(root, path));
  try {
    // TextDecoder drops a leading byte-order mark: keep it, so it is written back.
    const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    return (hasBom ? BOM : "") + utf8.decode(raw);
  } catch {
    throw new Refusal(`${path} is not valid UTF-8, so its pins cannot be rewritten safely.`);
  }
}

/**
 * Work out everything upgrade would do, reading every file it would write,
 * and throw Refusal for anything that stops it. Touches nothing on disk.
 */
export function planUpgrade({ runner, root, oldSnap, newSnap, files, force, pinnedTag }) {
  const newPaths = newSnap.kitOwnedPaths;
  const removed = oldSnap.kitOwnedPaths.filter((p) => !newPaths.includes(p));
  for (const snap of [newSnap, oldSnap]) {
    const clash = caseCollisions(snap.kitOwnedPaths);
    if (clash.length) {
      throw new Refusal(
        `${snap.tag}'s kit-owned-paths.txt lists paths that differ only in case: ${clash[0].join(" and ")}.`,
      );
    }
  }

  // Every path is deleted first; the new tag's paths are then copied fresh.
  const deletes = [...newPaths, ...removed].map((p) => p.replace(/\/$/, ""));
  for (const rel of deletes) checkDeletable(root, rel);
  const writes = kitFileWrites(newSnap);
  for (const w of writes) checkLocalPath(root, w.path, { deleted: deletes });

  const pinEdits = [];
  if (pinnedTag !== newSnap.tag) {
    for (const file of files) {
      if (file.pins.length === 0) continue;
      const text = readWorkflowText(root, file.path);
      let rewritten;
      try {
        rewritten = rewriteKitPins(text, newSnap.tag);
      } catch (err) {
        if (err instanceof PinRewriteError) throw new Refusal(`${file.path}: ${err.message}`);
        throw err;
      }
      pinEdits.push({
        path: file.path,
        count: rewritten.count,
        bytes: Buffer.from(rewritten.text, "utf8"),
      });
    }
  }

  const { changed: dirty, ignored } = uncommittedChanges({ runner, root, paths: deletes });
  if (dirty.length && !force) {
    throw new Refusal(
      `${dirty.length} file(s) in the paths upgrade would replace or delete have uncommitted changes. ` +
        `Commit or stash them, or run again with --force to discard them.`,
      [...dirty.slice(0, MAX_LISTED), ...(dirty.length > MAX_LISTED ? ["…"] : [])],
    );
  }

  return { deletes, removed, writes, pinEdits, dirty, ignored };
}

/**
 * @param {{
 *   cwd: string,
 *   runner: import("./exec.mjs").Runner,
 *   tag: string,
 *   from?: string,   // the tag being left, when the pins already name `tag`
 *   force?: boolean,
 *   yes?: boolean,
 *   confirm?: ((question: string) => Promise<boolean>) | null,
 *   out: (text: string) => void,
 *   openRepo?: typeof openKitRepo,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 * @returns {Promise<number>} exit code
 */
export async function runUpgrade({
  cwd,
  runner,
  tag: newTag,
  from,
  force = false,
  yes = false,
  confirm = null,
  out,
  openRepo = openKitRepo,
  env = process.env,
}) {
  const refuse = (err) => {
    out(`REFUSED  ${err.message}`);
    for (const d of err.details ?? []) out(`      ${d}`);
    out("Nothing was changed.");
    return 1;
  };

  const top = runner("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return refuse(new Refusal(`${cwd} is not a git repository.`));
  const root = top.stdout.trim();

  let workflows;
  try {
    workflows = readWorkflows(root);
  } catch (err) {
    return refuse(new Refusal(firstLine(err?.message ?? err)));
  }
  const pins = checkPins(workflows.files);
  if (!pins.tag) {
    return refuse(
      new Refusal(
        `upgrade needs every Agent-kit uses: pin to name the same Release-line tag: ${pins.result.summary}`,
        pins.result.details,
      ),
    );
  }
  const pinnedTag = pins.tag;
  if (from !== undefined && pinnedTag !== from && pinnedTag !== newTag) {
    return refuse(
      new Refusal(
        `The pins name ${pinnedTag}, which is neither --from ${from} nor --tag ${newTag}.`,
      ),
    );
  }
  const oldTag = from ?? pinnedTag;
  out(`Upgrading ${pins.repo} from ${oldTag} to ${newTag} in ${root}.`);
  if (compareTags(newTag, oldTag) < 0) out(`Note: ${newTag} is older than ${oldTag}.`);

  let kit;
  try {
    kit = openRepo({ runner, repo: pins.repo, serverUrl: serverFromEnv(env) });
  } catch (err) {
    return refuse(err);
  }
  try {
    let oldSnap;
    let newSnap;
    let plan;
    try {
      oldSnap = kit.fetchTag(oldTag, { forDeletion: true });
      newSnap = newTag === oldTag ? oldSnap : kit.fetchTag(newTag, { forDeletion: true });
      plan = planUpgrade({
        runner,
        root,
        oldSnap,
        newSnap,
        files: workflows.files,
        force,
        pinnedTag,
      });
    } catch (err) {
      // PreManifestTagError gives the same message doctor prints.
      if (err instanceof Refusal || err instanceof PreManifestTagError) return refuse(err);
      return refuse(new Refusal(firstLine(err?.message ?? err)));
    }

    out("");
    out(`Replace (delete, then copy from ${newTag}):`);
    for (const p of newSnap.kitOwnedPaths) {
      const n = plan.writes.filter((w) => w.path.startsWith(p)).length;
      out(`  ${p} (${n} file${n === 1 ? "" : "s"})`);
    }
    if (plan.removed.length) {
      out(`Delete (no longer in ${newTag}'s kit-owned-paths.txt):`);
      for (const p of plan.removed) out(`  ${p}`);
    }
    if (plan.pinEdits.length) {
      out(`Rewrite uses: pins to @${newTag}:`);
      for (const e of plan.pinEdits) out(`  ${e.path} (${e.count} pin${e.count === 1 ? "" : "s"})`);
    } else {
      out(`The uses: pins already name ${newTag}.`);
    }
    if (plan.dirty.length) {
      out(`--force: discarding uncommitted changes in ${plan.dirty.length} file(s):`);
      for (const d of plan.dirty.slice(0, MAX_LISTED)) out(`  ${d}`);
    }
    if (plan.ignored.length) {
      out(`Also deleted: ${plan.ignored.length} ignored file(s) or folder(s) in those paths:`);
      for (const d of plan.ignored.slice(0, MAX_LISTED)) out(`  ${d}`);
    }
    out("");

    if (!yes) {
      if (!confirm) {
        out("Not run: there is no terminal to confirm in. Run again with --yes to go ahead.");
        return 2;
      }
      if (!(await confirm("Go ahead? [y/N] "))) {
        out("Stopped. Nothing was changed.");
        return 1;
      }
    }

    try {
      applyPlan(root, { deletes: plan.deletes, writes: plan.writes, rewrites: plan.pinEdits });
    } catch (err) {
      if (err instanceof Refusal) return refuse(err);
      out(`FAILED  upgrade stopped part-way: ${firstLine(err?.message ?? err)}`);
      out("      See `git status`; restore with `git checkout -- .` and `git clean` as needed.");
      return 1;
    }
    out(
      `Copied ${plan.writes.length} file(s) from ${newTag}` +
        (plan.pinEdits.length ? ` and rewrote ${plan.pinEdits.length} workflow file(s).` : "."),
    );
    const note = stageFileModes({ runner, root, writes: plan.writes });
    if (note) out(note);

    out("");
    if (oldTag === newTag) {
      out(
        `The pins already named ${newTag}, so there is no examples/ diff to show, and no path ` +
          `only an older tag listed was deleted. If they were bumped from an older tag (by ` +
          `Dependabot, say), run again with --from <that tag> to get both.`,
      );
    } else {
      let diff = "";
      try {
        diff = kit.diff(oldSnap, newSnap, "examples/");
      } catch (err) {
        out(`Could not diff examples/: ${firstLine(err?.message ?? err)}`);
      }
      if (diff.trim()) {
        out(
          `examples/ changed between ${oldTag} and ${newTag}. Your Callers are yours: ` +
            `apply what you need by hand.`,
        );
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u0009\u000b-\u001f]/.test(diff)) {
          out(
            "(Control characters, tabs and carriage returns included, are shown escaped as \\uXXXX.)",
          );
        }
        out(diff.replace(/\n$/, ""));
      } else {
        out(`examples/ did not change between ${oldTag} and ${newTag}.`);
      }
    }

    // The same file and pin checks as `doctor --ci`, against the tag already fetched.
    out("");
    out("Checks (as doctor --ci):");
    const results = checksAfterWrite({ runner, root, snap: newSnap });
    for (const r of results) for (const line of formatResult(r)) out(line);
    const failed = results.some((r) => r.status === "fail");
    out("");
    out(
      failed
        ? "Result: a check failed (exit 1)."
        : "Result: done. Review `git status` and `git diff`, then commit the pins and the Kit-owned paths together.",
    );
    return failed ? 1 : 0;
  } finally {
    kit.cleanup();
  }
}

/** doctor --ci's pin and Kit-owned path checks, against an already-fetched tag. */
export function checksAfterWrite({ runner, root, snap }) {
  let pins;
  try {
    pins = checkPins(readWorkflows(root).files);
  } catch (err) {
    return [result("pins", "uses: pins agree", "fail", firstLine(err?.message ?? err))];
  }
  const results = [pins.result];
  if (pins.tag !== snap.tag) {
    results.push(
      result(
        "kit-owned-trees",
        "Kit-owned paths match the pinned tag",
        "fail",
        `The pins do not all name ${snap.tag}.`,
      ),
    );
    return results;
  }
  try {
    results.push(checkKitOwnedTrees({ runner, cwd: root, snapshot: snap }));
  } catch (err) {
    results.push(
      result("kit-owned-trees", "Kit-owned paths match the pinned tag", "fail", err.message),
    );
  }
  return results;
}
