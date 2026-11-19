// The scan phase's only route out (#370): a key-injecting reverse proxy that
// runs in the launcher, on the host, outside the sandbox. The sandboxed
// Claude Code holds only a placeholder key and reaches the model API through
// this proxy, which forwards only to the model API, strips the placeholder
// (`x-api-key`, `Authorization`) and inserts the real credential. The
// credential lives only in this process's memory: it is never an argument,
// an environment variable or a file of any command the launcher runs.
// Node core only (ADR 0001).

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** The model API every forwarded request goes to. */
export const MODEL_API = "https://api.anthropic.com";

/** Only the Messages API's paths are forwarded. */
const MODEL_PATH = /^\/v1\//;

/** How many distinct refused hosts or paths the summary keeps, and how long each. */
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
 * @param {{ credential: string, bind: string, upstream?: string }} opts
 *   `upstream` is the model API; only tests pass another.
 * @returns {Promise<{ port: number, refused: string[], summary: () => string, close: () => Promise<void> }>}
 */
export async function startModelProxy({ credential, bind, upstream = MODEL_API }) {
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
    if (!MODEL_PATH.test(path) || /(^|\/)(\.|%2e){1,2}(\/|$)|%2f|\\/i.test(path)) {
      refuse(path);
      res.writeHead(403).end("deep-scan model proxy: only the model API's /v1/ paths\n");
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!DROPPED.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
    }
    headers["x-api-key"] = credential;
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
    summary() {
      const byStatus = [...statuses].map(([s, n]) => `${s} x${n}`).join(", ");
      const parts = [
        `forwarded ${forwarded} request(s) to ${target.host}${byStatus ? ` (answers: ${byStatus})` : ""}`,
      ];
      if (refusedCount) {
        const more = refusedCount > refused.length ? ", ..." : "";
        parts.push(`refused ${refusedCount} (${refused.join(", ")}${more})`);
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
