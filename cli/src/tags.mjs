// Release-line tags: vX.Y.Z or vX.Y.Z-(alpha|beta|rc).N, the same shape
// scripts/verify_release_snapshot.py accepts. The npm package version is the
// tag without its leading v.

export const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;

/** The first tag published to npm; older tags have no matching package version. */
export const FIRST_NPM_TAG = "v1.0.0-alpha.12";

/** The first tag that ships kit-owned-paths.txt. */
export const FIRST_MANIFEST_TAG = "v1.0.0-alpha.11";

export const PACKAGE_NAME = "@mnaimfaizy/agent-kit";

const STAGE_RANK = { alpha: 0, beta: 1, rc: 2, "": 3 };

export function isReleaseTag(tag) {
  return typeof tag === "string" && TAG_PATTERN.test(tag);
}

function key(tag) {
  const m = TAG_PATTERN.exec(tag);
  if (!m) throw new Error(`not a Release-line tag: ${tag}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), STAGE_RANK[m[4] ?? ""], Number(m[5] ?? 0)];
}

/** Negative if a < b, 0 if equal, positive if a > b. */
export function compareTags(a, b) {
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}

export function versionForTag(tag) {
  key(tag);
  return tag.slice(1);
}

/** The `npx` command that upgrades to `tag`. */
export function upgradeCommand(tag) {
  const spec =
    compareTags(tag, FIRST_NPM_TAG) >= 0 ? `${PACKAGE_NAME}@${versionForTag(tag)}` : PACKAGE_NAME;
  return `npx ${spec} upgrade --tag ${tag}`;
}
