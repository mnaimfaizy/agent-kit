// The `anthropic` provider profile (ADR 0023): everything the model proxy's
// core (../core.mjs) knows about the Anthropic API. The real credential goes
// in as `x-api-key` for an API key, or, on the subscription path (#375), as
// the bearer value of `Authorization` and nothing else, so every other header
// Claude Code sends (its OAuth beta header among them) passes on as it is and
// need not be known here.
//
// What it lets through is only what the sandboxed Claude Code needs:
// - only `POST` to the Messages API's own two paths (FORWARDED);
// - only a body with nothing that makes the model API act outside the sandbox:
//   no server-side tool (any `tools` entry but a client tool with an
//   `input_schema`), no `mcp_servers` or `container`, and no content that
//   names a file or URL for the API to fetch. Every beta feature that acts on
//   the API's side is turned on through one of those body fields, so the beta
//   header itself passes as Claude Code sent it.

/** The model API every forwarded request goes to. */
export const MODEL_API = "https://api.anthropic.com";

/** A path must be under /v1/ and not UNCOUNTED_PATH before it is matched against ROUTES. */
const MODEL_PATH = /^\/v1\//;

/**
 * Paths whose spend an answer's `usage` would not show (a batch is billed
 * later, outside this run), so the token cap could not hold: refused.
 */
const UNCOUNTED_PATH = /^\/v1\/(messages\/batches|complete)(\/|$)/i;

/** The call that spends tokens, and the one that only counts them. */
const ROUTES = Object.freeze([
  Object.freeze({ method: "POST", path: "/v1/messages", spends: true }),
  Object.freeze({ method: "POST", path: "/v1/messages/count_tokens", spends: false }),
]);

/** The only requests forwarded, by decoded path, and only as `POST`: Claude Code's Messages API calls. */
export const FORWARDED = Object.freeze(ROUTES.map((r) => r.path));

/** The largest request body the proxy reads, judges and forwards. */
export const MAX_REQUEST = 32 * 1024 * 1024;

/**
 * A request's input tokens, estimated from its body for its reservation:
 * one token per this many bytes, which is fewer bytes than any ordinary text
 * takes per token, so the estimate is high rather than low.
 */
const BYTES_PER_TOKEN = 2;

/** How deep the body's messages and system blocks are walked; deeper is refused. */
const MAX_DEPTH = 64;

/** The `usage` fields the cap counts: every kind of token billed. */
export const COUNTED_USAGE = Object.freeze([
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
]);

/** The header an API key goes in, as the caller sends its key and the proxy writes the real one. */
const API_KEY_HEADER = "x-api-key";

/**
 * The request headers never passed on, beyond the hop-by-hop and standard
 * credential headers the core drops itself. Every other header passes.
 */
const NEVER_FORWARDED = Object.freeze([API_KEY_HEADER]);

/** The Messages API's error type for each of the proxy's own refusals. */
const ERROR_TYPES = Object.freeze({
  unauthenticated: "authentication_error",
  cap_reached: "permission_error",
  invalid_request: "invalid_request_error",
  too_large: "request_too_large",
  busy: "rate_limit_error",
});

/** Content sources that make the model API fetch something: a URL, or a file it holds. */
const FETCHED_SOURCE = new Set(["url", "file"]);

/** Content blocks that hand the model API something to act on outside the request. */
const ACTING_BLOCK = new Set(["container_upload", "mcp_tool_use", "server_tool_use"]);

/**
 * Why a Messages API request body is refused, or null. The body must be a
 * JSON object; no `mcp_servers` or `container`; every `tools` entry a
 * client tool (no `type`, or `custom`, and an `input_schema` object), so no
 * server-side tool; and nothing in `messages` or `system` that names a URL
 * or a file for the API to fetch, or an upload or server-side call.
 * @param {unknown} body
 * @returns {string | null}  a short, fixed reason, never the sandbox's text
 */
export function requestRefusal(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "a body that is not a JSON object";
  }
  for (const key of ["mcp_servers", "container"]) {
    if (Object.hasOwn(body, key)) return `a request with ${key}`;
  }
  if (Object.hasOwn(body, "tools")) {
    if (!Array.isArray(body.tools)) return "tools that are not a list";
    for (const tool of body.tools) {
      if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
        return "a tool that is not an object";
      }
      if (tool.type !== undefined && tool.type !== "custom") return "a server-side tool";
      if (tool.input_schema === null || typeof tool.input_schema !== "object") {
        return "a tool with no input_schema";
      }
    }
  }
  for (const key of ["messages", "system"]) {
    if (!Object.hasOwn(body, key)) continue;
    const why = contentRefusal(body[key], 0);
    if (why) return why;
  }
  return null;
}

/** @param {unknown} value @param {number} depth @returns {string | null} */
function contentRefusal(value, depth) {
  if (value === null || typeof value !== "object") return null;
  if (depth > MAX_DEPTH) return "content nested too deeply";
  if (Array.isArray(value)) {
    for (const item of value) {
      const why = contentRefusal(item, depth + 1);
      if (why) return why;
    }
    return null;
  }
  if (typeof value.type === "string" && ACTING_BLOCK.has(value.type)) {
    return `a ${value.type} block`;
  }
  if (Object.hasOwn(value, "file_id")) return "a file reference";
  const source = value.source;
  if (source && typeof source === "object" && FETCHED_SOURCE.has(source.type)) {
    return `a ${source.type} source`;
  }
  for (const child of Object.values(value)) {
    const why = contentRefusal(child, depth + 1);
    if (why) return why;
  }
  return null;
}

/**
 * The `usage` of one answer, each token counted once: each kind in
 * COUNTED_USAGE, from a JSON body or from a stream's `message_start` and
 * `message_delta` events. A stream's usage is cumulative, so each kind counts
 * its highest value once.
 * @returns {(answer: any) => number}  the tokens the body or event newly reports
 */
function usageReducer() {
  const seen = Object.fromEntries(COUNTED_USAGE.map((k) => [k, 0]));
  return (answer) => {
    const usage = answer?.usage ?? answer?.message?.usage;
    if (!usage || typeof usage !== "object") return 0;
    let added = 0;
    for (const key of COUNTED_USAGE) {
      const n = usage[key];
      if (typeof n === "number" && Number.isFinite(n) && n > seen[key]) {
        added += n - seen[key];
        seen[key] = n;
      }
    }
    return added;
  };
}

/** @type {Readonly<import("../core.mjs").ProviderProfile>} */
export const anthropic = Object.freeze({
  upstream: MODEL_API,
  credentialKinds: Object.freeze({
    "api-key": (credential) => [API_KEY_HEADER, credential],
    subscription: (credential) => ["authorization", `Bearer ${credential}`],
  }),
  keyHeaders: Object.freeze([API_KEY_HEADER]),
  forwardsHeader: (header) => !NEVER_FORWARDED.includes(header),
  inScope: (path, decoded) =>
    MODEL_PATH.test(path) && MODEL_PATH.test(decoded) && !UNCOUNTED_PATH.test(decoded),
  routes: ROUTES,
  refusals: Object.freeze({
    scope: "only the model API's /v1/ paths",
    route: "only POST to the Messages API",
  }),
  maxRequestBytes: MAX_REQUEST,
  requestRefusal,
  inputEstimate: (body) => Math.ceil(body.length / BYTES_PER_TOKEN),
  declaredLimit: (body) => body.max_tokens,
  errorBody: (kind, message) => ({
    type: "error",
    error: { type: ERROR_TYPES[kind], message },
  }),
  streamHint: /"(usage|model)"/,
  // A JSON body names its model, and so does a stream's `message_start`.
  answeringModel: (answer) => answer?.model ?? answer?.message?.model,
  usageReducer,
});
