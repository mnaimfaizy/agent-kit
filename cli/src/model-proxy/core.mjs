// The model proxy's core (ADR 0023): a key-injecting reverse proxy that runs
// in the launcher, on the host, outside the sandbox. It knows no model API:
// everything about one comes from its provider profile (profiles/). The
// sandboxed agent holds only a placeholder key and reaches the model API
// through this proxy, which forwards only to the profile's upstream, drops
// every header that could carry the placeholder and inserts the real
// credential in the one header the profile writes. The credential lives only
// in this process's memory: it is never an argument, an environment variable
// or a file of any command the launcher runs. Node core only (ADR 0001).
//
// It also holds the run's token cap: it counts what each answer reports as
// used, and once the count reaches the cap it refuses every further request
// and tells the launcher, which stops the agent step. From the same answers it
// reads the model each one names, so the launcher can say which model the API
// answered with, not only which was asked for.
//
// What it forwards is judged on every request, since anything in the sandbox
// can reach the proxy:
// - only a method and path the profile lists, on a path that decodes plainly;
// - with `callerKey`, only a request that carries the run's caller key, the
//   value the launcher gave the sandboxed agent in place of a real
//   credential, so another process in the sandbox that never read it cannot
//   spend the real one;
// - only a JSON object the profile's filter passes, within its size bound;
// - at most MAX_IN_FLIGHT requests at once, each holding a reservation of
//   the tokens it may spend, so the cap holds against requests sent together.

import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** How many requests may be in flight to the model API at once. */
export const MAX_IN_FLIGHT = 4;

/** How much of an answer the meter reads: a line of a stream, or a whole JSON body. */
const MAX_LINE = 1024 * 1024;
const MAX_BODY = 16 * 1024 * 1024;

/**
 * A plain model id: no space, quote or leading dash. It is the launcher's
 * check of a requested model, which goes into the agent step's command line
 * (the same pattern as the static workflow's model input), and the only form
 * of an answer's model the summary names, so an answer cannot write a line of
 * its own.
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/;

/** How many distinct refused hosts, paths or answered models the summary keeps, and how long each. */
const MAX_KEPT = 5;
const MAX_ENTRY = 80;

// Hop-by-hop headers (RFC 9110 7.6.1), the client's standard credential
// headers, and the Host, which is the model API's own. A profile's key headers
// join them, and its `forwardsHeader` may hold back more of a request's.
const DROPPED = [
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
];

/**
 * Everything the core needs to know about one model API.
 * @typedef {object} ProviderProfile
 * @property {string} upstream  the model API's origin, which every forwarded request goes to
 * @property {Readonly<Record<string, (credential: string) => string[]>>} credentialKinds
 *   for each kind of credential, the one header it is written in, as [name, value]
 * @property {readonly string[]} keyHeaders  lower-case headers the sandbox may carry its
 *   caller key in, besides a bearer `Authorization`; never forwarded, either way
 * @property {(header: string) => boolean} forwardsHeader  whether a request header, by
 *   lower-case name, passes to the model API, among those the core has not already dropped
 * @property {(path: string, decoded: string) => boolean} inScope  whether the path, as sent
 *   and as percent-decoded, is one of the API's own that the cap could count
 * @property {ReadonlyArray<{ method: string, path: string, spends: boolean }>} routes  the
 *   only requests forwarded, by decoded path; one that `spends` holds a reservation
 * @property {{ scope: string, route: string }} refusals  what a caller refused by
 *   `inScope` or by `routes` is told
 * @property {number} maxRequestBytes  the largest request body read, judged and forwarded
 * @property {(body: object) => string | null} requestRefusal  why the parsed body, a JSON
 *   object, is refused, as a short fixed reason, or null
 * @property {(body: Buffer) => number} inputEstimate  the input tokens a request may spend
 * @property {(body: any) => unknown} declaredLimit  the output tokens a request declares
 * @property {(kind: "unauthenticated" | "cap_reached" | "invalid_request" | "too_large" | "busy", message: string) => object} errorBody
 *   the proxy's own refusal, in the API's error shape
 * @property {RegExp} streamHint  what a stream's data line holds when it is worth reading
 * @property {(answer: any) => unknown} answeringModel  the model an answer, or one of a
 *   stream's events, names
 * @property {() => (answer: any) => number} usageReducer  for one answer, a function that
 *   takes its body, or each of a stream's events that `streamHint` matches, and returns
 *   the tokens newly counted, each once
 */

/**
 * Start the proxy for `profile` on `bind` (an address the relay reaches, never
 * all interfaces; on Docker Sandboxes, 127.0.0.1, which its policy lets the
 * sandbox reach). `refused` collects every host or path it turned away. With
 * `maxTokens`, the first request once the counted tokens reach it is refused,
 * as is every one after, and `onCap` is called once. The answer that crosses
 * the cap is delivered: a request in flight is never cut. A request is held
 * back (429, retry after a second) while MAX_IN_FLIGHT are in flight, or
 * while the counted tokens and the reservations of those in flight reach the
 * cap, so requests sent together cannot all pass the check before any answer
 * is counted.
 * @param {ProviderProfile} profile
 * @param {{ credential: string, kind: string, bind: string, upstream?: string, maxTokens?: number, onCap?: () => void, callerKey?: string, name?: string }} opts
 *   `kind` is one of the profile's credential kinds. `upstream` is the model
 *   API (default the profile's); only tests pass another. `callerKey`, when
 *   given, is the only value accepted as the caller's key, in one of the
 *   profile's key headers or as a bearer value; the launcher always gives one.
 *   `name` is what the proxy calls itself in what it answers.
 * @returns {Promise<{ port: number, refused: string[], tokens: () => number, models: () => string[], credentialRefused: () => boolean, summary: () => string, close: () => Promise<void> }>}
 *   `models` is each distinct model id the answers named, in the order first
 *   seen, at most MAX_KEPT of them, and only plain ids of MAX_ENTRY or fewer.
 *   `credentialRefused` is true when at least one request was forwarded and
 *   the model API answered every one with 401 or 403: it refused the
 *   credential (a request that got no answer, or still waits for one, is not
 *   a refusal). The proxy's own refusals (a path, a host, the cap) are not
 *   answers of the model API, so they never count.
 */
export async function startProxy(
  profile,
  {
    credential,
    kind,
    bind,
    upstream = profile.upstream,
    maxTokens,
    onCap = () => {},
    callerKey,
    name = "model proxy",
  },
) {
  if (typeof kind !== "string" || !Object.hasOwn(profile.credentialKinds, kind)) {
    throw new Error(`the model proxy has no credential kind ${JSON.stringify(kind)}`);
  }
  if (callerKey !== undefined && (typeof callerKey !== "string" || callerKey.length < 32)) {
    throw new Error("the model proxy's caller key must be a string of at least 32 characters");
  }
  // The one header the proxy writes: the sandbox's own key headers are always
  // dropped, so the placeholder never passes on.
  const auth = profile.credentialKinds[kind](credential);
  const dropped = new Set([...DROPPED, ...profile.keyHeaders]);
  const passed = (headers) =>
    Object.fromEntries(
      Object.entries(headers).filter(
        ([header, value]) => !dropped.has(header.toLowerCase()) && value !== undefined,
      ),
    );
  // A request's headers also pass the profile's rule.
  const requestHeaders = (headers) =>
    Object.fromEntries(
      Object.entries(passed(headers)).filter(([header]) => profile.forwardsHeader(header)),
    );
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
  const answerText = (res, status, message) => res.writeHead(status).end(`${name}: ${message}\n`);
  const answerError = (res, status, errorKind, message, headers = {}) =>
    res
      .writeHead(status, { "content-type": "application/json", ...headers })
      .end(JSON.stringify(profile.errorBody(errorKind, `${name}: ${message}`)));

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
      answerText(res, 403, "only the model API is reachable");
      return;
    }
    const path = raw.split("?")[0];
    const decoded = decodePlainPath(path);
    if (decoded === null || !profile.inScope(path, decoded)) {
      refuse(path);
      answerText(res, 403, profile.refusals.scope);
      return;
    }
    const route = profile.routes.find((r) => r.method === req.method && r.path === decoded);
    if (!route) {
      refuse(`${req.method} ${path}`);
      answerText(res, 403, profile.refusals.route);
      return;
    }
    if (callerKey !== undefined && !callerHolds(req.headers, profile.keyHeaders, callerKey)) {
      refuse("a caller without the run's key");
      answerError(res, 401, "unauthenticated", "this caller does not hold the run's key");
      return;
    }
    if (maxTokens !== undefined && tokens >= maxTokens) {
      pastCap += 1;
      if (pastCap === 1) onCap();
      answerError(res, 403, "cap_reached", `this run's token cap (${maxTokens}) is reached`);
      return;
    }
    const encoding = String(req.headers["content-encoding"] ?? "identity")
      .trim()
      .toLowerCase();
    if (encoding !== "identity" && encoding !== "") {
      refuse("a compressed request body");
      answerError(res, 415, "invalid_request", "a request body must not be compressed");
      return;
    }
    // The whole body, bounded, so it is judged before any of it is sent.
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > profile.maxRequestBytes) {
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
          "too_large",
          `a request body is at most ${profile.maxRequestBytes} bytes`,
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
      // The core refuses a body that is no object itself, so no profile's
      // body hook is ever handed one.
      const why = isObject(parsed)
        ? profile.requestRefusal(parsed)
        : "a body that is not a JSON object";
      if (why) {
        refuse(why);
        answerError(res, 400, "invalid_request", `refused ${why}`);
        return;
      }
      // What this request may spend, held against the cap while it is in
      // flight: its declared output and an estimate of its input.
      const reservation = route.spends
        ? profile.inputEstimate(body) + tokenCount(profile.declaredLimit(parsed))
        : 0;
      if (
        inFlight >= MAX_IN_FLIGHT ||
        (maxTokens !== undefined && inFlight > 0 && tokens + reserved >= maxTokens)
      ) {
        heldBack += 1;
        answerError(
          res,
          429,
          "busy",
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
      const headers = requestHeaders(req.headers);
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
          method: route.method,
          path: raw,
          headers,
        },
        (r) => {
          count(String(r.statusCode ?? "error"));
          // The reservation holds until the answer has been read whole, and
          // so counted, even if the sandbox stops listening first.
          r.on("close", settle);
          res.writeHead(r.statusCode ?? 502, passed(r.headers));
          meter(
            r,
            profile,
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
          answerText(res, 502, "the model API could not be reached");
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
 * A request path percent-decoded, as the API would route it, so an encoded
 * letter is checked as the letter it names; or null when it does not decode
 * plainly. A path that does not decode, or still holds a `%` once decoded
 * (encoded twice), is refused, as is a dot segment, plain or encoded, an
 * encoded slash, a backslash, and an empty segment, which a front end that
 * merges slashes would route past a check of the path.
 * @param {string} path  without its query
 * @returns {string | null}
 */
function decodePlainPath(path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const plain =
    !decoded.includes("%") &&
    !/\/\/|\/$/.test(decoded) &&
    !/(^|\/)\.{1,2}(\/|$)|\\/.test(decoded) &&
    !/(^|\/)(\.|%2e){1,2}(\/|$)|%2f|\\/i.test(path);
  return plain ? decoded : null;
}

/** Whether a parsed body is a JSON object, not a list, a bare value or nothing. */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A declared token limit as a reservation counts it: a positive whole number, or nothing. */
function tokenCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Whether the request carries the run's caller key, as an agent sends its
 * key: in one of `keyHeaders`, or as the bearer value of `Authorization`.
 * Compared in constant time.
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @param {readonly string[]} keyHeaders
 * @param {string} key
 */
function callerHolds(headers, keyHeaders, key) {
  const want = Buffer.from(key, "utf8");
  const offered = keyHeaders
    .map((header) => headers[header])
    .filter((value) => typeof value === "string");
  const bearer = /^Bearer (\S+)$/.exec(String(headers.authorization ?? ""));
  if (bearer) offered.push(bearer[1]);
  return offered.some((value) => {
    const got = Buffer.from(value, "utf8");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

/**
 * Count the tokens an answer reports, as the answer streams past: the
 * profile's usage reducer takes a JSON body, or each data event of a stream
 * that the profile's `streamHint` matches.
 * A compressed body (sent although the proxy asked for none) is decoded for
 * counting only. The model the answer names goes to `named`, unchecked.
 * @param {import("node:http").IncomingMessage} r
 * @param {ProviderProfile} profile
 * @param {(n: number) => void} add  called with each newly counted amount
 * @param {(model: unknown) => void} named  called with each model an answer names
 */
function meter(r, profile, add, named) {
  const reduce = profile.usageReducer();
  const take = (answer) => {
    const model = profile.answeringModel(answer);
    if (model !== undefined) named(model);
    const n = reduce(answer);
    if (n > 0) add(n);
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
      if (line.startsWith("data:") && profile.streamHint.test(line)) parse(line.slice(5).trim());
    }
  });
  body.on("end", () => {
    if (!stream && !overflow) parse(pending);
    else if (stream && pending.startsWith("data:")) parse(pending.slice(5).trim());
  });
}
