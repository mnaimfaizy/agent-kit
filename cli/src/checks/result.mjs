// A check result. `skip` means the check did not run, and is never counted as
// a pass.

export const STATUSES = ["pass", "warn", "fail", "skip"];

export function result(id, title, status, summary, { details = [], fix = [] } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
  return { id, title, status, summary, details, fix };
}

/** Quote a value for a POSIX shell command the adopter copies. */
export function shellQuote(value) {
  const s = String(value);
  return /^[A-Za-z0-9_.:/@=+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
