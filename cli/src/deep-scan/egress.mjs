// The setup phase's egress gate (#369): an HTTP proxy that runs in the
// launcher, on the host, outside the sandbox, and forwards only to the Scan
// recipe's `registries`. The sandbox sits on a Docker network with no route
// out (`--internal`), and reaches this proxy only through a relay, so the
// proxy is its only way to the internet during setup; the network is cut
// before the agent step. Node core only.

import { createServer, request } from "node:http";
import { connect } from "node:net";

/**
 * Each registry as the host and ports it allows: a bare host name allows
 * ports 80 and 443; a URL or `host:port` allows the port it names (or its
 * scheme's default).
 * @param {string[]} registries
 * @returns {Map<string, Set<number>>}
 */
export function allowlistOf(registries) {
  const allowed = new Map();
  for (const entry of registries) {
    let host;
    let ports;
    try {
      const url = new URL(entry.includes("://") ? entry : `none://${entry}`);
      host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (url.port) ports = [Number(url.port)];
      else if (url.protocol === "http:") ports = [80];
      else if (url.protocol === "https:") ports = [443];
      else ports = [80, 443];
    } catch {
      continue;
    }
    if (!host) continue;
    const set = allowed.get(host) ?? new Set();
    for (const p of ports) set.add(p);
    allowed.set(host, set);
  }
  return allowed;
}

// Hop-by-hop headers (RFC 9110 7.6.1) and the client's proxy headers, which
// go no further than this proxy, and the client's Host: the upstream gets
// the allowed URL's host, so a shared front end cannot route by another.
const DROPPED = new Set([
  "host",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** The headers to send upstream for a request to `url`. */
function forwardedHeaders(headers, url) {
  const named = String(headers.connection ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!DROPPED.has(lower) && !named.includes(lower) && value !== undefined) out[name] = value;
  }
  out.host = url.host;
  return out;
}

/**
 * Start the proxy on `bind` (an address the relay reaches, never all
 * interfaces). `refused` collects every host it turned away.
 * @param {{ registries: string[], bind: string }} opts
 * @returns {Promise<{ port: number, refused: string[], close: () => Promise<void> }>}
 */
export async function startEgressProxy({ registries, bind }) {
  const allowed = allowlistOf(registries);
  const permits = (host, port) =>
    allowed.get(host.toLowerCase().replace(/^\[|\]$/g, ""))?.has(port) ?? false;
  const refused = [];
  const sockets = new Set();

  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("deep-scan setup proxy: an absolute http:// URL is required\n");
      return;
    }
    const port = Number(url.port || 80);
    if (url.protocol !== "http:" || !permits(url.hostname, port)) {
      refused.push(url.host);
      res
        .writeHead(403)
        .end(`deep-scan setup proxy: ${url.host} is not in the recipe's registries\n`);
      return;
    }
    const upstream = request(
      url,
      { method: req.method, headers: forwardedHeaders(req.headers, url) },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });

  server.on("connect", (req, socket, head) => {
    socket.on("error", () => {});
    const target = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
    if (!target || !permits(target[1], Number(target[2]))) {
      refused.push(req.url ?? "");
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(Number(target[2]), target[1].replace(/^\[|\]$/g, ""), () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => socket.destroy());
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
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve(undefined));
      }),
  };
}
