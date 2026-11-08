// A check result, and the rules for anything doctor prints. `skip` means the
// check did not run, and is never counted as a pass.
//
// Doctor prints values that come from files and API responses it does not
// control (secret and variable names, label names, error text). So:
// - a fix command is printed only when every value in it passes a strict
//   allowlist, and each argument is quoted; otherwise the adopter gets a
//   "fix by hand" note with the value JSON-escaped, never a command;
// - every printed line has control characters escaped and cannot start a
//   CI log command (see sanitizeLine).

export const STATUSES = ["pass", "warn", "fail", "skip"];

export function result(id, title, status, summary, { details = [], fix = [] } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
  return { id, title, status, summary, details, fix };
}

/** A GitHub Actions secret or variable name. */
export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A label name doctor will put in a command: no quotes, no shell or PowerShell syntax. */
export const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 :._/-]*$/;
/** owner/name as GitHub allows it, never starting with `-`. */
export const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** Arguments doctor itself writes into a command (flags and fixed words). */
const WORD = /^[A-Za-z0-9_.:/@=+-]+$/;

/**
 * Quote one argument for a POSIX shell. Callers only pass values that matched
 * an allowlist above, none of which contains a quote, so single quotes are
 * enough in bash and in PowerShell alike.
 */
export function shellQuote(value) {
  const s = String(value);
  if (s.includes("'")) throw new Error("refusing to quote a value that contains a single quote");
  return WORD.test(s) ? s : `'${s}'`;
}

/** Build a printable command from argument words, every one quoted. */
export function command(...args) {
  return args.map(shellQuote).join(" ");
}

/** A note for a value that cannot go into a command, shown JSON-escaped. */
export function byHand(what, value) {
  return `fix by hand: ${what} ${JSON.stringify(String(value))} (not printed as a command)`;
}

// C0 and C1 controls, DEL, and the Unicode line and paragraph separators.
const CONTROL = new RegExp("[\u0000-\u001f\u007f-\u009f\u2028\u2029]", "g");

/**
 * Make one output line safe for a terminal and for a CI log: escape control
 * characters (so no ANSI escape, no carriage return, no embedded newline),
 * and keep the line from starting a GitHub Actions workflow command
 * (`::name::` or the older `##[name]`).
 */
export function sanitizeLine(line) {
  let s = String(line).replace(
    CONTROL,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const lead = s.length - s.trimStart().length;
  const rest = s.slice(lead);
  if (rest.startsWith("::") || rest.startsWith("##[")) s = `${s.slice(0, lead)}\\${rest}`;
  return s;
}
