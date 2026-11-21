// The relay and the probe of a Deep scan on Docker Engine (#404). This file
// runs inside a launcher-owned container, never in the launcher: the
// launcher stages a copy, checks it against its pinned SHA-256 (relay.mjs),
// and mounts it read-only into the official node image. Node core only.
//
//   forward <listen-port> <host> <port>
//     Accept TCP on <listen-port>, the one port it listens on, and pipe each
//     connection to <host>:<port>, the host-side proxy. It reads nothing and
//     holds no credential: the bytes pass through as they are.
//
//   probe [--timeout-ms <ms>] <host> <port> [<host> <port> ...]
//     Try a TCP connection to each target, again and again until one
//     connects or the time is up (a relay just started may not listen yet),
//     and print one JSON array: for each target, in order, the outcome that
//     reached furthest: "connected", "refused" (a host answered, so a route
//     exists), "error <code>", or "unreachable" (no route, or no answer in
//     time).

import { connect, createServer } from "node:net";

const [mode, ...rest] = process.argv.slice(2);

if (mode === "forward") {
  const [listen, host, port] = rest;
  // Half-close: when one side ends, `pipe` ends the other once what is
  // queued for it is written, so a reply that ends at once arrives whole.
  // Only an error tears both sides down.
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({ host, port: Number(port), allowHalfOpen: true });
    const fail = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", fail);
    upstream.on("error", fail);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.on("error", (e) => {
    process.stderr.write(`relay: ${e.message}\n`);
    process.exit(1);
  });
  server.listen(Number(listen), () => process.stdout.write(`relay: listening on ${listen}\n`));
  process.on("SIGTERM", () => process.exit(0));
} else if (mode === "probe") {
  let timeoutMs = 3000;
  if (rest[0] === "--timeout-ms") {
    timeoutMs = Number(rest[1]);
    rest.splice(0, 2);
  }
  const targets = [];
  for (let i = 0; i + 1 < rest.length; i += 2) targets.push([rest[i], Number(rest[i + 1])]);
  const UNREACHABLE = new Set(["ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"]);
  const attempt = ([host, port], ms) =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      const done = (result) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => done("unreachable"), ms);
      socket.once("connect", () => done("connected"));
      socket.once("error", (e) =>
        done(
          e.code === "ECONNREFUSED"
            ? "refused"
            : UNREACHABLE.has(e.code)
              ? "unreachable"
              : `error ${e.code}`,
        ),
      );
    });
  const deadline = Date.now() + timeoutMs;
  // The outcome that reached furthest wins: one answer from a host is a route.
  const rank = (r) => (r === "connected" ? 3 : r === "refused" ? 2 : r === "unreachable" ? 0 : 1);
  const reach = async (target) => {
    let best = "unreachable";
    for (;;) {
      const result = await attempt(target, Math.max(1, deadline - Date.now()));
      if (rank(result) > rank(best)) best = result;
      if (best === "connected" || Date.now() >= deadline) return best;
      await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
  };
  const results = await Promise.all(targets.map(reach));
  process.stdout.write(`${JSON.stringify(results)}\n`);
} else {
  process.stderr.write("usage: relay.mjs forward <listen-port> <host> <port> | probe ...\n");
  process.exit(2);
}
