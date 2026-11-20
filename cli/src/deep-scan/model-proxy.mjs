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

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** The model API every forwarded request goes to. */
export const MODEL_API = "https://api.anthropic.com";

/** Only the Messages API's paths are forwarded. */
const MODEL_PATH = /^\/v1\//;

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
 * launcher's check of --model, and the only form of an answer's `model` the
 * summary names.
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
 * Start the proxy on `bind` (an address the sandbox reaches, never all
 * interfaces). `refused` collects every host or path it turned away.
 * With `maxTokens`, the first request once the counted tokens reach it is
 * refused, as is every one after, and `onCap` is called once. The answer
 * that crosses the cap is delivered: a request in flight is never cut.
 * @param {{ credential: string, kind?: "api-key" | "subscription", bind: string, upstream?: string, maxTokens?: number, onCap?: () => void }} opts
 *   `kind` is the credential's (default an API key). `upstream` is the
 *   model API; only tests pass another.
 * @returns {Promise<{ port: number, refused: string[], tokens: () => number, models: () => string[], summary: () => string, close: () => Promise<void> }>}
 *   `models` is each distinct model id the answers named, in the order first
 *   seen, at most MAX_KEPT of them, and only plain ids of MAX_ENTRY or fewer.
 */
export async function startModelProxy({
  credential,
  kind = "api-key",
  bind,
  upstream = MODEL_API,
  maxTokens,
  onCap = () => {},
}) {
  if (kind !== "api-key" && kind !== "subscription") {
    throw new Error(`the model proxy has no credential kind ${JSON.stringify(kind)}`);
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
  const sockets = new Set();
  const count = (key) => statuses.set(key, (statuses.get(key) ?? 0) + 1);

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
    // No dot segment, plain or encoded, may walk the path out of /v1/.
    if (
      !MODEL_PATH.test(path) ||
      UNCOUNTED_PATH.test(path) ||
      /(^|\/)(\.|%2e){1,2}(\/|$)|%2f|\\/i.test(path)
    ) {
      refuse(path);
      res.writeHead(403).end("deep-scan model proxy: only the model API's /v1/ paths\n");
      return;
    }
    if (maxTokens !== undefined && tokens >= maxTokens) {
      pastCap += 1;
      if (pastCap === 1) onCap();
      res.writeHead(403, { "content-type": "application/json" }).end(
        JSON.stringify({
          type: "error",
          error: {
            type: "permission_error",
            message: `deep-scan model proxy: this run's token cap (${maxTokens}) is reached`,
          },
        }),
      );
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!DROPPED.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
    }
    headers[auth[0]] = auth[1];
    // A plain body, so the meter can read its usage.
    headers["accept-encoding"] = "identity";
    forwarded += 1;
    const upstreamReq = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: req.method,
        path: raw,
        headers,
      },
      (r) => {
        count(String(r.statusCode ?? "error"));
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
      count("error");
      if (!res.headersSent) {
        res.writeHead(502).end("deep-scan model proxy: the model API could not be reached\n");
      } else {
        res.destroy();
      }
    });
    req.pipe(upstreamReq);
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
