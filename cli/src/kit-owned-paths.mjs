// Parses kit-owned-paths.txt.
//
// Two levels of trust:
// - forDeletion (the default): `upgrade` deletes every entry before copying
//   it fresh, so only the permitted shapes pass, the same rule
//   scripts/kit-owned-paths-contract.test.py enforces on the kit side. A tag
//   that broke that rule must not delete Consumer files.
// - read-only (`forDeletion: false`, used by doctor): any plain relative
//   folder path is accepted, so an older CLI can still check a newer tag that
//   adds a new kind of Kit-owned path. Nothing is deleted on this path.

const ALLOWED_SHAPE =
  /^(?:\.claude\/skills\/[A-Za-z0-9._-]+\/|\.github\/(?:agent-runtime|agent-pipeline|security-audit)\/)$/;
const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/$/;

export class ManifestError extends Error {}

function safe(line) {
  const parts = line.slice(0, -1).split("/");
  return SAFE_PATH.test(line) && !parts.includes("..") && !parts.includes(".");
}

/**
 * @param {string} text
 * @param {{ forDeletion?: boolean }} [opts]
 */
export function parseKitOwnedPaths(text, { forDeletion = true } = {}) {
  const entries = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith("#")) continue;
    const ok = safe(line) && (!forDeletion || ALLOWED_SHAPE.test(line));
    if (!ok) {
      throw new ManifestError(
        `kit-owned-paths.txt: ${JSON.stringify(line)} is not a permitted Kit-owned path`,
      );
    }
    if (entries.includes(line)) throw new ManifestError(`kit-owned-paths.txt lists ${line} twice`);
    entries.push(line);
  }
  if (entries.length === 0) throw new ManifestError("kit-owned-paths.txt lists no paths");
  return entries;
}
