// Parses kit-owned-paths.txt. `upgrade` deletes every entry before copying it
// fresh, so the parser refuses any line that is not one of the permitted
// shapes, the same rule scripts/kit-owned-paths-contract.test.py enforces on
// the kit side. A tag that broke that rule must not delete Consumer files.

const ALLOWED_SHAPE =
  /^(?:\.claude\/skills\/[A-Za-z0-9._-]+\/|\.github\/(?:agent-runtime|agent-pipeline|security-audit)\/)$/;

export class ManifestError extends Error {}

export function parseKitOwnedPaths(text) {
  const entries = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith("#")) continue;
    if (!ALLOWED_SHAPE.test(line) || line.split("/").includes("..")) {
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
