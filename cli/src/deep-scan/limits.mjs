// The limits that bound every Deep scan (#371), all enforced from outside
// the sandbox: the setup and scan wall clocks by the launcher, the turns by
// the launcher's own `--max-turns` on the claude command line, and the token
// cap by the model proxy, which counts the model API's returned `usage`.
// Limits come from launcher flags only (and, in CI, workflow inputs): the
// Scan recipe never sets them (recipe.mjs refuses a limit field), so a
// merged recipe change cannot raise a run's spend.

/** The starting defaults, from the spec's limits table. */
export const DEFAULT_LIMITS = Object.freeze({
  setupMinutes: 20,
  scanMinutes: 60,
  turns: 200,
  tokens: 5_000_000,
});

/**
 * The longest wall clock: what a timer can hold (2^31 - 1 ms, about 24
 * days). A longer one would fire at once.
 */
export const MAX_MINUTES = Math.floor((2 ** 31 - 1) / 60_000);

/** Each limit's flag, whether it takes a whole number, and its largest value. */
export const LIMIT_FLAGS = Object.freeze({
  setupMinutes: { flag: "setup-minutes", whole: false, max: MAX_MINUTES },
  scanMinutes: { flag: "scan-minutes", whole: false, max: MAX_MINUTES },
  turns: { flag: "max-turns", whole: true, max: Number.MAX_SAFE_INTEGER },
  tokens: { flag: "max-tokens", whole: true, max: Number.MAX_SAFE_INTEGER },
});

/** The `Stopped:` values report-format.md defines. */
export const WALL_CLOCK = "wall clock";
export const TURNS = "turns";
export const TOKENS = "tokens";

/** The exit code of a run a limit stopped, whether or not a report came out. */
export const STOPPED_EXIT = 3;

/**
 * The limits from the flags' values (strings, or undefined for the default).
 * A value that is not a positive number (a whole one for turns and tokens)
 * is a usage error.
 * @param {Record<string, string | undefined>} values  keyed by flag name
 * @returns {{ limits: Limits } | { error: string }}
 *
 * @typedef {{ setupMinutes: number, scanMinutes: number, turns: number, tokens: number }} Limits
 */
export function parseLimits(values) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, { flag, whole, max }] of Object.entries(LIMIT_FLAGS)) {
    const raw = values[flag];
    if (raw === undefined) continue;
    const shape = whole ? /^\d+$/ : /^\d+(\.\d+)?$/;
    const n = Number(raw);
    if (!shape.test(raw) || !(n > 0) || n > max) {
      return {
        error: `--${flag} must be a positive ${whole ? "whole number" : "number"} of at most ${max}, got: ${JSON.stringify(raw)}`,
      };
    }
    limits[key] = n;
  }
  return { limits };
}

/** The limits as one line of the launcher's output. */
export function describeLimits(limits) {
  const flags = Object.values(LIMIT_FLAGS)
    .map((f) => `--${f.flag}`)
    .join(", ");
  return `Limits: setup ${limits.setupMinutes} min, scan ${limits.scanMinutes} min, ${limits.turns} turns, ${limits.tokens} tokens (raise them with ${flags}).`;
}

/** A run stopped by a limit: what fired, said for a person. */
export class LimitReached extends Error {
  /** @param {{ limit: string, detail: string }} stop */
  constructor(stop) {
    super(`stopped: ${stop.limit} (${stop.detail})`);
    this.stop = stop;
  }
}

/** The status line for a run a limit stopped. */
export const stoppedStatus = (stop) => `Stopped: ${stop.limit} (${stop.detail}).`;

const STOPPED_LINE = /^[ \t]*[-*][ \t]+\*\*Stopped:\*\*.*$/;
const FINDING_COUNT = /^[ \t]*[-*][ \t]+\*\*Finding count:\*\*/;
const REPORT_HEADING = /^## Security audit report[ \t]*$/;

/**
 * The report's bytes with the launcher's `Stopped:` line, when a limit ended
 * the run: after the `Finding count` header line, as report-format.md places
 * it (else after the report's heading, else first). Any `Stopped:` line the
 * agent wrote is removed, since only the launcher writes one. A report with
 * neither is returned byte for byte. Bytes are read as latin1, so a report
 * that is not valid UTF-8 keeps every other byte unchanged.
 * @param {Buffer} data
 * @param {string | null} limit  the `Stopped:` value, or null
 * @returns {Buffer}
 */
export function withStopped(data, limit) {
  const text = data.toString("latin1");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((l) => !STOPPED_LINE.test(l));
  if (limit === null && kept.length === lines.length) return data;
  if (limit !== null) {
    const line = `- **Stopped:** ${limit}`;
    const count = kept.findIndex((l) => FINDING_COUNT.test(l));
    const heading = kept.findIndex((l) => REPORT_HEADING.test(l));
    if (count >= 0) kept.splice(count + 1, 0, line);
    else if (heading >= 0) kept.splice(heading + 1, 0, "", line);
    else kept.unshift(line, "");
  }
  return Buffer.from(kept.join(eol), "latin1");
}
