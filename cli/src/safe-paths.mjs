// Rules for a repository-relative path the CLI writes or deletes in a
// Consumer's checkout. A path read from a tag passes only if writing it is
// safe on Linux, macOS and Windows alike: plain name characters, no `.` or
// `..` segment, nothing git or Windows treats as special (`.git` in any case,
// its 8.3 short name `git~1`, a trailing dot, a device name such as `nul`).

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

export class UnsafePathError extends Error {}

/** Why `segment` is unsafe, or null. */
function segmentProblem(segment) {
  if (!SEGMENT.test(segment)) return "has a character outside A-Z a-z 0-9 . _ -";
  if (segment === "." || segment === "..") return "is a . or .. segment";
  if (segment.toLowerCase() === ".git" || /^git~\d+$/i.test(segment)) return "names .git";
  if (segment.endsWith(".")) return "ends with a dot, which Windows drops";
  if (WINDOWS_DEVICE.test(segment)) return "is a Windows device name";
  return null;
}

/**
 * Throw UnsafePathError unless `path` (no leading or trailing slash) is safe
 * to write or delete. Returns the path.
 */
export function checkSafePath(path, what = "path") {
  const s = String(path);
  if (s === "" || s.startsWith("/") || s.endsWith("/")) {
    throw new UnsafePathError(`refusing ${what} ${JSON.stringify(s)}: not a relative file path`);
  }
  for (const segment of s.split("/")) {
    const problem = segmentProblem(segment);
    if (problem) {
      throw new UnsafePathError(
        `refusing ${what} ${JSON.stringify(s)}: ${JSON.stringify(segment)} ${problem}`,
      );
    }
  }
  return s;
}

/**
 * Groups of paths that are the same file on a case-insensitive file system
 * (Windows and macOS by default). Writing them would leave only one.
 */
export function caseCollisions(paths) {
  const byKey = new Map();
  for (const p of paths) {
    const key = p.toLowerCase();
    byKey.set(key, [...(byKey.get(key) ?? []), p]);
  }
  return [...byKey.values()].filter((group) => new Set(group).size > 1);
}

/** Every prefix that is also a file: `a` and `a/b` cannot both be files. */
export function fileDirConflicts(paths) {
  const lower = new Set(paths.map((p) => p.toLowerCase()));
  const out = [];
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (lower.has(prefix.toLowerCase())) out.push([prefix, p]);
    }
  }
  return out;
}
