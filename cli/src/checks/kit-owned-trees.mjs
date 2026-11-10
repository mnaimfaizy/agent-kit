// Each Kit-owned path in the working copy must have the same git tree hash as
// the same path at the pinned tag. Kit-owned paths are copied verbatim and
// never edited, so any difference means a stale, partial or edited copy.

import { DEFAULT_KIT_REPO } from "../callers.mjs";
import { localTreeHashes } from "../local-tree.mjs";
import { upgradeCommand } from "../tags.mjs";
import { result } from "./result.mjs";

const ID = "kit-owned-trees";
const TITLE = "Kit-owned paths match the pinned tag";
/** A Kit-owned skill folder, capturing the skill's name. */
const SKILL_DIR = /^\.claude\/skills\/([^/]+)\/$/;

/**
 * @param {{ runner: import("../exec.mjs").Runner, cwd: string, snapshot: { tag: string, kitOwnedPaths: string[], treeHash: (p: string) => string | null } }} opts
 */
export function checkKitOwnedTrees({ runner, cwd, snapshot }) {
  const { tag, kitOwnedPaths } = snapshot;
  const repo = snapshot.repo ?? DEFAULT_KIT_REPO;
  const { hashes, skipped, notes, links } = localTreeHashes({ runner, cwd, paths: kitOwnedPaths });
  const serverUrl = snapshot.serverUrl ?? "https://github.com";
  const bad = [];
  const notChecked = [];
  const linkedSkills = [];
  for (const path of kitOwnedPaths) {
    if (links.has(path)) {
      const link = links.get(path);
      const skill = SKILL_DIR.exec(path)?.[1];
      bad.push(
        `${path}: ${link} is a symbolic link or junction, where the tag ships plain files` +
          (skill ? ` (installing the skill with \`npx skills\` does this)` : ""),
      );
      if (skill) linkedSkills.push({ skill, link });
      continue;
    }
    if (skipped.has(path)) {
      notChecked.push(`${path}: not checked, ${skipped.get(path)}`);
      continue;
    }
    const expected = snapshot.treeHash(path);
    const actual = hashes.get(path);
    if (expected === null) {
      bad.push(`${path}: listed in ${tag}'s kit-owned-paths.txt but not in the tag`);
    } else if (actual === null) {
      bad.push(`${path}: missing (expected tree ${expected.slice(0, 12)})`);
    } else if (actual !== expected) {
      bad.push(`${path}: differs (local ${actual.slice(0, 12)}, ${tag} ${expected.slice(0, 12)})`);
    }
  }
  const howCompared = [...notes].map(([path, note]) => `${path}: ${note}`);
  const checked = kitOwnedPaths.length - notChecked.length;
  if (bad.length === 0 && notChecked.length === 0) {
    return result(ID, TITLE, "pass", `All ${kitOwnedPaths.length} Kit-owned paths match ${tag}.`, {
      details: howCompared,
    });
  }
  if (bad.length === 0) {
    // A path that could not be compared is never reported as matching.
    return result(
      ID,
      TITLE,
      "skip",
      `${checked} Kit-owned path(s) match ${tag}; ${notChecked.length} could not be checked.`,
      { details: [...notChecked, ...howCompared, "Run doctor in a full checkout to check them."] },
    );
  }
  return result(
    ID,
    TITLE,
    "fail",
    `${bad.length} of ${kitOwnedPaths.length} Kit-owned paths do not match ${tag}.`,
    {
      details: [
        ...bad,
        ...notChecked,
        ...howCompared,
        ...linkedSkills.map(
          ({ skill, link }) =>
            `To restore ${skill}, remove the link ${link} (and the copy npx skills made at ` +
            `.agents/skills/${skill}/), then run the command below: a Consumer gets Kit-owned ` +
            `skills from the tag, not from npx skills.`,
        ),
        ...(links.size
          ? [
              `--force: once the link is gone its files show as deleted, which upgrade otherwise ` +
                `refuses as uncommitted changes. It discards changes in Kit-owned paths only.`,
            ]
          : []),
        `Kit-owned paths are replaced whole from the tag your pins name, never edited.`,
        `If a pin bump (for example from Dependabot) moved the pins to ${tag}, re-copy them on the same branch.`,
        `Run the command below, or delete and re-copy each path by hand as ` +
          `${manualCopyUrl(repo, tag, serverUrl)} describes.`,
      ],
      fix: [links.size ? `${upgradeCommand(tag)} --force` : upgradeCommand(tag)],
    },
  );
}

/** adopt.md's copy section at the tag, which links the manual delete-then-copy loop. */
export function manualCopyUrl(repo, tag, serverUrl = "https://github.com") {
  return `${serverUrl}/${repo}/blob/${tag}/docs/adopt.md#copy-kit-owned-paths-from-the-same-tag`;
}
