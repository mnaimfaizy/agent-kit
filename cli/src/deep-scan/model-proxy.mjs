// The scan phase's only route out (#370): a key-injecting reverse proxy that
// runs in the launcher, on the host, outside the sandbox. The sandboxed
// Claude Code holds only a placeholder key and reaches the model API through
// this proxy, which forwards only to the model API, strips the placeholder
// (`x-api-key`, `Authorization`) and inserts the real credential: as
// `x-api-key` for an API key, or, on the subscription path (#375), as the
// bearer value of `Authorization` and nothing else, so every other header
// Claude Code sends (its OAuth beta header among them) passes on as it is
// and need not be known here. The
// credential lives only in this process's memory: it is never an argument,
// an environment variable or a file of any command the launcher runs.
// Node core only (ADR 0001).
//
// It also holds the run's token cap (#371): it counts the `usage` each
// model API answer returns, and once the count reaches the cap it refuses
// every further request and tells the launcher, which stops the agent step.
// From the same answers it reads the `model` each one names, so the launcher
// can say which model the API answered with, not only which was asked for.
//
// What it forwards is only what the sandboxed Claude Code needs, judged on
// every request, since anything in the sandbox can reach the proxy:
// - only `POST` to the Messages API's own two paths (FORWARDED);
// - with `callerKey`, only a request that carries the run's caller key, the
//   value the launcher gave the sandboxed Claude Code in place of a real
//   credential, so another process in the sandbox that never read it cannot
//   spend the real one;
// - only a JSON body with nothing that makes the model API act outside the
//   sandbox: no server-side tool (any `tools` entry but a client tool with an
//   `input_schema`), no `mcp_servers` or `container`, and no content that
//   names a file or URL for the API to fetch. Every beta feature that acts
//   on the API's side is turned on through one of those body fields, so the
//   beta header itself passes as Claude Code sent it;
// - at most MAX_IN_FLIGHT requests at once, each holding a reservation of
//   the tokens it may spend, so the cap holds against requests sent together.

import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** The model API every forwarded request goes to. */
export const MODEL_API = "https://api.anthropic.com";

/** Every path is checked against /v1/ first, then against FORWARDED. */
const MODEL_PATH = /^\/v1\//;

/** The only requests forwarded, by decoded path, and only as `POST`: Claude Code's Messages API calls. */
export const FORWARDED = Object.freeze(["/v1/messages", "/v1/messages/count_tokens"]);

/** The largest request body the proxy reads, judges and forwards. */
export const MAX_REQUEST = 32 * 1024 * 1024;

/** How many requests may be in flight to the model API at once. */
export const MAX_IN_FLIGHT = 4;

/**
 * A request's input tokens, estimated from its body for its reservation:
 * one token per this many bytes, which is fewer bytes than any ordinary text
 * takes per token, so the estimate is high rather than low.
 */
const BYTES_PER_TOKEN = 2;

/** How deep the body's messages and system blocks are walked; deeper is refused. */
const MAX_DEPTH = 64;

/**
 * Paths whose spend an answer's `usage` would not show (a batch is billed
 * later, outside this run), so the token cap could not hold: refused.
 */
const UNCOUNTED_PATH = /^\/v1\/(messages\/batches|complete)(\/|$)/i;

/** The `usage` fields the cap counts: every kind of token billed. */
export const COUNTED_USAGE = Object.freeze([
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
]);

/** How much of an answer the meter reads: a line of a stream, or a whole JSON body. */
const MAX_LINE = 1024 * 1024;
const MAX_BODY = 16 * 1024 * 1024;

/**
 * A model id as Claude Code's --model takes it, and nothing more: the
 * launcher's check of --model, which goes into the agent step's command
 * line (so no space, quote or leading dash; the same pattern as the static
 * workflow's model input), and the only form of an answer's `model` the
 * summary names, so an answer cannot write a line of its own.
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/;

/** How many distinct refused hosts, paths or answered models the summary keeps, and how long each. */
const MAX_KEPT = 5;
const MAX_ENTRY = 80;

// Hop-by-hop headers (RFC 9110 7.6.1), the client's credentials, and the
// Host, which is the model API's own.
const DROPPED = new Set([
  "x-api-key",
  "authorization",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
]);

/**
 * Start the proxy on `bind` (an address the relay reaches, never all
 * interfaces; on Docker Sandboxes, 127.0.0.1, which its policy lets the
 * sandbox reach). `refused` collects every host or path it turned away.
 * With `maxTokens`, the first request once the counted tokens reach it is
 * refused, as is every one after, and `onCap` is called once. The answer
 * that crosses the cap is delivered: a request in flight is never cut. A
 * request is held back (429, retry after a second) while MAX_IN_FLIGHT are
 * in flight, or while the counted tokens and the reservations of those in
 * flight reach the cap, so requests sent together cannot all pass the check
 * before any answer is counted.
 * @param {{ credential: string, kind?: "api-key" | "subscription", bind: string, upstream?: string, maxTokens?: number, onCap?: () => void, callerKey?: string }} opts
 *   `kind` is the credential's (default an API key). `upstream` is the
 *   model API; only tests pass another. `callerKey`, when given, is the
 *   only value accepted as the caller's `x-api-key` or `Authorization`
 *   bearer value; the launcher always gives one.
 * @returns {Promise<{ port: number, refused: string[], tokens: () => number, models: () => string[], credentialRefused: () => boolean, summary: () => string, close: () => Promise<void> }>}
 *   `models` is each distinct model id the answers named, in the order first
 *   seen, at most MAX_KEPT of them, and only plain ids of MAX_ENTRY or fewer.
 *   `credentialRefused` is true when at least one request was forwarded and
 *   the model API answered every one with 401 or 403: it refused the
 *   credential (a request that got no answer, or still waits for one, is not
 *   a refusal). The proxy's own refusals (a path, a host, the cap) are not
 *   answers of the model API, so they never count.
 */
export async function startModelProxy({
  credential,
  kind = "api-key",
  bind,
  upstream = MODEL_API,
  maxTokens,
  onCap = () => {},
  callerKey,
}) {
  if (kind !== "api-key" && kind !== "subscription") {
    throw new Error(`the model proxy has no credential kind ${JSON.stringify(kind)}`);
  }
  if (callerKey !== undefined && (typeof callerKey !== "string" || callerKey.length < 32)) {
    throw new Error("the model proxy's caller key must be a string of at least 32 characters");
  }
  // The one header the proxy writes: the sandbox's x-api-key and
  // Authorization are always dropped, so the placeholder never passes on.
  const auth =
    kind === "subscription" ? ["authorization", `Bearer ${credential}`] : ["x-api-key", credential];
  const target = new URL(upstream);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const refused = [];
  let refusedCount = 0;
  // What the sandbox sends is untrusted: keep a few short entries, and a count.
  const refuse = (what) => {
    refusedCount += 1;
    const entry = what.slice(0, MAX_ENTRY);
    if (refused.length < MAX_KEPT && !refused.includes(entry)) refused.push(entry);
  };
  /** @type {Map<string, number>} upstream status (or "error") to count */
  const statuses = new Map();
  let forwarded = 0;
  let tokens = 0;
  /** @type {string[]} */
  const models = [];
  let moreModels = false;
  // What an answer names is kept only as a plain, short id.
  const answeredBy = (model) => {
    if (typeof model !== "string" || model.length > MAX_ENTRY || !MODEL_ID.test(model)) return;
    if (models.includes(model)) return;
    if (models.length < MAX_KEPT) models.push(model);
    else moreModels = true;
  };
  let pastCap = 0;
  let inFlight = 0;
  let reserved = 0;
  let heldBack = 0;
  const sockets = new Set();
  const count = (key) => statuses.set(key, (statuses.get(key) ?? 0) + 1);
  const answerError = (res, status, type, message, headers = {}) =>
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(
      JSON.stringify({
        type: "error",
        error: { type, message: `deep-scan model proxy: ${message}` },
      }),
    );

  const server = createServer((req, res) => {
    const raw = req.url ?? "";
    if (!raw.startsWith("/")) {
      // An absolute URL: someone is using the proxy as a forward proxy.
      let host = raw;
      try {
        host = new URL(raw).host;
      } catch {
        host = raw;
      }
      refuse(host);
      res.writeHead(403).end("deep-scan model proxy: only the model API is reachable\n");
      return;
    }
    const path = raw.split("?")[0];
    // The checks run on the path as the API would route it, percent-decoded,
    // so `/v1/%6dessages/batches` is the batch path it names. A path that
    // does not decode, or still holds a `%` once decoded (encoded twice), is
    // refused. No dot segment, plain or encoded, may walk it out of /v1/.
    let decoded = null;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      decoded = null;
    }
    if (
      decoded === null ||
      decoded.includes("%") ||
      !MODEL_PATH.test(path) ||
      !MODEL_PATH.test(decoded) ||
      UNCOUNTED_PATH.test(decoded) ||
      // An empty segment (`/v1//messages/batches`): a front end that merges
      // slashes would route it past the uncounted-path check.
      /\/\/|\/$/.test(decoded) ||
      /(^|\/)\.{1,2}(\/|$)|\\/.test(decoded) ||
      /(^|\/)(\.|%2e){1,2}(\/|$)|%2f|\\/i.test(path)
    ) {
      refuse(path);
      res.writeHead(403).end("deep-scan model proxy: only the model API's /v1/ paths\n");
      return;
    }
    // Only Claude Code's own Messages API calls: POST, to one of two paths.
    if (req.method !== "POST" || !FORWARDED.includes(decoded)) {
      refuse(`${req.method} ${path}`);
      res.writeHead(403).end("deep-scan model proxy: only POST to the Messages API\n");
      return;
    }
    if (callerKey !== undefined && !callerHolds(req.headers, callerKey)) {
      refuse("a caller without the run's key");
      answerError(res, 401, "authentication_error", "this caller does not hold the run's key");
      return;
    }
    if (maxTokens !== undefined && tokens >= maxTokens) {
      pastCap += 1;
      if (pastCap === 1) onCap();
      answerError(res, 403, "permission_error", `this run's token cap (${maxTokens}) is reached`);
      return;
    }
    const encoding = String(req.headers["content-encoding"] ?? "identity")
      .trim()
      .toLowerCase();
    if (encoding !== "identity" && encoding !== "") {
      refuse("a compressed request body");
      answerError(res, 415, "invalid_request_error", "a request body must not be compressed");
      return;
    }
    // The whole body, bounded, so it is judged before any of it is sent.
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_REQUEST) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => res.destroy());
    req.on("end", () => {
      if (tooLarge) {
        refuse("a request body over the size limit");
        answerError(
          res,
          413,
          "request_too_large",
          `a request body is at most ${MAX_REQUEST} bytes`,
        );
        return;
      }
      const body = Buffer.concat(chunks);
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        parsed = undefined;
      }
      const why = requestRefusal(parsed);
      if (why) {
        refuse(why);
        answerError(res, 400, "invalid_request_error", `refused ${why}`);
        return;
      }
      // What this request may spend, held against the cap while it is in
      // flight: its declared output and an estimate of its input. A token
      // count spends nothing.
      const reservation =
        decoded === "/v1/messages"
          ? Math.ceil(body.length / BYTES_PER_TOKEN) +
            (Number.isSafeInteger(parsed.max_tokens) && parsed.max_tokens > 0
              ? parsed.max_tokens
              : 0)
          : 0;
      if (
        inFlight >= MAX_IN_FLIGHT ||
        (maxTokens !== undefined && inFlight > 0 && tokens + reserved >= maxTokens)
      ) {
        heldBack += 1;
        answerError(
          res,
          429,
          "rate_limit_error",
          "too many requests in flight for this run's token cap; retry",
          { "retry-after": "1" },
        );
        return;
      }
      inFlight += 1;
      reserved += reservation;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        inFlight -= 1;
        reserved -= reservation;
      };
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!DROPPED.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
      }
      headers[auth[0]] = auth[1];
      headers["content-length"] = String(body.length);
      // A plain body, so the meter can read its usage.
      headers["accept-encoding"] = "identity";
      forwarded += 1;
      const upstreamReq = send(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          method: "POST",
          path: raw,
          headers,
        },
        (r) => {
          count(String(r.statusCode ?? "error"));
          // The reservation holds until the answer has been read whole, and
          // so counted, even if the sandbox stops listening first.
          r.on("close", settle);
          const back = {};
          for (const [name, value] of Object.entries(r.headers)) {
            if (!DROPPED.has(name.toLowerCase()) && value !== undefined) back[name] = value;
          }
          res.writeHead(r.statusCode ?? 502, back);
          meter(
            r,
            (n) => {
              tokens += n;
            },
            answeredBy,
          );
          r.pipe(res);
        },
      );
      upstreamReq.on("error", () => {
        settle();
        count("error");
        if (!res.headersSent) {
          res.writeHead(502).end("deep-scan model proxy: the model API could not be reached\n");
        } else {
          res.destroy();
        }
      });
      upstreamReq.end(body);
    });
  });

  // A CONNECT tunnel would reach any host: refused.
  server.on("connect", (req, socket) => {
    socket.on("error", () => {});
    refuse(req.url ?? "");
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bind, () => resolve(undefined));
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    refused,
    tokens: () => tokens,
    models: () => [...models],
    // Every forwarded request answered, and each answer a 401 or 403.
    credentialRefused: () =>
      forwarded > 0 &&
      [...statuses].reduce(
        (sum, [status, n]) => (status === "401" || status === "403" ? sum + n : sum),
        0,
      ) === forwarded,
    summary() {
      const byStatus = [...statuses].map(([s, n]) => `${s} x${n}`).join(", ");
      const parts = [
        `forwarded ${forwarded} request(s) to ${target.host}${byStatus ? ` (answers: ${byStatus})` : ""}`,
      ];
      if (forwarded) {
        parts.push(
          models.length
            ? `the model API answered with ${models.join(", ")}${moreModels ? ", ..." : ""}`
            : "no answer named a model",
        );
      }
      if (refusedCount) {
        const more = refusedCount > refused.length ? ", ..." : "";
        parts.push(`refused ${refusedCount} (${refused.join(", ")}${more})`);
      }
      if (heldBack) {
        parts.push(`held back ${heldBack} request(s) while others were in flight`);
      }
      if (maxTokens !== undefined) {
        parts.push(
          `counted ${tokens} of the ${maxTokens}-token cap${pastCap ? `, and refused ${pastCap} request(s) past it` : ""}`,
        );
      }
      return parts.join("; ");
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * Whether the request carries the run's caller key, as Claude Code sends
 * its key: `x-api-key`, or the bearer value of `Authorization`. Compared in
 * constant time.
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @param {string} key
 */
function callerHolds(headers, key) {
  const want = Buffer.from(key, "utf8");
  const offered = [];
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string") offered.push(apiKey);
  const bearer = /^Bearer (\S+)$/.exec(String(headers.authorization ?? ""));
  if (bearer) offered.push(bearer[1]);
  return offered.some((value) => {
    const got = Buffer.from(value, "utf8");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

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
 * Count the tokens an answer's `usage` reports, as the answer streams past:
 * each kind in COUNTED_USAGE, from a JSON body or from a stream's
 * `message_start` and `message_delta` events. A stream's usage is
 * cumulative, so each kind counts its highest value once. A compressed body
 * (sent although the proxy asked for none) is decoded for counting only.
 * The `model` the answer names (a JSON body's, or a stream's
 * `message_start`'s) goes to `named`, unchecked.
 * @param {import("node:http").IncomingMessage} r
 * @param {(n: number) => void} add  called with each newly counted amount
 * @param {(model: unknown) => void} named  called with each `model` an answer names
 */
function meter(r, add, named) {
  const seen = Object.fromEntries(COUNTED_USAGE.map((k) => [k, 0]));
  const take = (obj) => {
    const model = obj?.model ?? obj?.message?.model;
    if (model !== undefined) named(model);
    const usage = obj?.usage ?? obj?.message?.usage;
    if (!usage || typeof usage !== "object") return;
    for (const key of COUNTED_USAGE) {
      const n = usage[key];
      if (typeof n === "number" && Number.isFinite(n) && n > seen[key]) {
        add(n - seen[key]);
        seen[key] = n;
      }
    }
  };
  const parse = (text) => {
    try {
      take(JSON.parse(text));
    } catch {
      // Not JSON: nothing to count.
    }
  };
  const stream = /text\/event-stream/i.test(String(r.headers["content-type"] ?? ""));
  const decoders = {
    gzip: createGunzip,
    "x-gzip": createGunzip,
    deflate: createInflate,
    br: createBrotliDecompress,
  };
  const encoding = String(r.headers["content-encoding"] ?? "identity")
    .trim()
    .toLowerCase();
  /** @type {import("node:stream").Readable} */
  let body = r;
  if (encoding !== "identity" && encoding !== "") {
    const make = decoders[encoding];
    if (!make) return;
    const decoder = make();
    decoder.on("error", () => {});
    r.on("data", (chunk) => decoder.write(chunk));
    r.on("end", () => decoder.end());
    body = decoder;
  }
  let pending = "";
  let size = 0;
  let overflow = false;
  body.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (!stream) {
      size += text.length;
      if (size > MAX_BODY) overflow = true;
      if (!overflow) pending += text;
      return;
    }
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    if (pending.length > MAX_LINE) pending = "";
    for (const line of lines) {
      if (line.startsWith("data:") && /"(usage|model)"/.test(line)) parse(line.slice(5).trim());
    }
  });
  body.on("end", () => {
    if (!stream && !overflow) parse(pending);
    else if (stream && pending.startsWith("data:")) parse(pending.slice(5).trim());
  });
}
