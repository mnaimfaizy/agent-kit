// Each Kit-owned path in the working copy must have the same git tree hash as
// the same path at the pinned tag. Kit-owned paths are copied verbatim and
// never edited, so any difference means a stale, partial or edited copy.

import { localTreeHashes } from "../local-tree.mjs";
import { upgradeCommand } from "../tags.mjs";
import { result } from "./result.mjs";

const ID = "kit-owned-trees";
const TITLE = "Kit-owned paths match the pinned tag";

/**
 * @param {{ runner: import("../exec.mjs").Runner, cwd: string, snapshot: { tag: string, kitOwnedPaths: string[], treeHash: (p: string) => string | null } }} opts
 */
export function checkKitOwnedTrees({ runner, cwd, snapshot }) {
  const { tag, kitOwnedPaths } = snapshot;
  const { hashes } = localTreeHashes({ runner, cwd, paths: kitOwnedPaths });
  const bad = [];
  for (const path of kitOwnedPaths) {
    const expected = snapshot.treeHash(path);
    const actual = hashes.get(path);
    if (expected === null)
      bad.push(`${path}: listed in ${tag}'s kit-owned-paths.txt but not in the tag`);
    else if (actual === null) bad.push(`${path}: missing (expected tree ${expected.slice(0, 12)})`);
    else if (actual !== expected) {
      bad.push(`${path}: differs (local ${actual.slice(0, 12)}, ${tag} ${expected.slice(0, 12)})`);
    }
  }
  if (bad.length === 0) {
    return result(ID, TITLE, "pass", `All ${kitOwnedPaths.length} Kit-owned paths match ${tag}.`);
  }
  return result(
    ID,
    TITLE,
    "fail",
    `${bad.length} of ${kitOwnedPaths.length} Kit-owned paths do not match ${tag}.`,
    {
      details: [
        ...bad,
        `Kit-owned paths are replaced whole from the tag your pins name, never edited.`,
        `If a pin bump (for example from Dependabot) moved the pins to ${tag}, run this on the same branch:`,
      ],
      fix: [upgradeCommand(tag)],
    },
  );
}
