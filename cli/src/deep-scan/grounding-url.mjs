// Grounding URLs are fetched on the host, by `deep-scan`, and the body is
// copied into the sandbox, which treats everything in it as untrusted. So a
// grounding fetch must reach only what the sandbox could reach on the public
// web: an `https:` page on a public host, by its DNS name, with no redirect
// (a redirect could name any address). Each address the name resolves to is
// checked, and the connection goes to the address that was checked, so a DNS
// answer that changes between the check and the connection cannot swap it.
//
// Node core only (ADR 0001): `node:https` with a checking `lookup`, since the
// global fetch takes no lookup of its own.

import { lookup as dnsLookup } from "node:dns";
import { Agent, request } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

/** A grounding entry with a scheme is a URL; anything else is a repository path. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** True when a grounding entry is a URL to fetch, not a repository path. */
export function isGroundingUrl(source) {
  return SCHEME.test(String(source));
}

/**
 * What is wrong with a grounding URL as written, or null when it may be
 * fetched: it must be `https:`, and name a fully qualified host by its DNS
 * name (no IP literal, single-label name or localhost).
 */
export function groundingUrlProblem(source) {
  let url;
  try {
    url = new URL(String(source));
  } catch {
    return "is not a valid URL";
  }
  if (url.protocol !== "https:") return "must be an https:// URL";
  // WHATWG URL parsing has already turned 0x7f.1, 2130706433 and similar
  // into dotted IPv4, and keeps an IPv6 literal in brackets.
  const host = url.hostname;
  if (host.startsWith("[") || isIP(host)) {
    return "must name its host by a DNS name, not an IP address";
  }
  const name = host.replace(/\.$/, "").toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) {
    return "must name a public host, not localhost";
  }
  if (!name.includes("."))
    return "must name a fully qualified public host, not a single-label name";
  return null;
}

// Addresses a grounding fetch never connects to: unspecified, loopback,
// private, shared (CGNAT), link-local (cloud metadata among them), the
// documentation and benchmarking ranges, multicast and reserved; and the IPv6
// forms that embed an IPv4 address (mapped, NAT64, 6to4, Teredo), so none can
// carry a private one through. One list per family: a BlockList matches an
// IPv4 address against IPv6 rules by its mapped form, so `::ffff:0:0/96` in a
// shared list would refuse every IPv4 address.
const NOT_PUBLIC_V4 = new BlockList();
const NOT_PUBLIC_V6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  NOT_PUBLIC_V4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
]) {
  NOT_PUBLIC_V6.addSubnet(net, prefix, "ipv6");
}

/** True when `address` is a public unicast IP address. */
export function isPublicAddress(address) {
  const family = isIP(String(address));
  if (family === 0) return false;
  try {
    if (family === 4) return !NOT_PUBLIC_V4.check(String(address), "ipv4");
    return !NOT_PUBLIC_V6.check(String(address), "ipv6");
  } catch {
    return false;
  }
}

/**
 * A `lookup` for sockets that resolves as `dns.lookup` does, and fails when
 * any address the name resolves to is not public. The socket then connects
 * only to the addresses returned here.
 */
export function publicLookup(hostname, options, callback) {
  const opts = typeof options === "function" ? {} : options ?? {};
  const done = typeof options === "function" ? options : callback;
  dnsLookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return done(error);
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0) {
      return done(Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND" }));
    }
    const blocked = list.find((a) => !isPublicAddress(a.address));
    if (blocked) {
      return done(
        Object.assign(
          new Error(`${hostname} resolves to ${blocked.address}, which is not a public address`),
          { code: "ENOTPUBLIC" },
        ),
      );
    }
    if (opts.all) return done(null, list);
    return done(null, list[0].address, list[0].family);
  });
}

// Its own agent: no keep-alive, and no proxy from the environment.
const AGENT = new Agent({ keepAlive: false });
const NULL_BODY = new Set([204, 205, 304]);

/**
 * The fetch `deep-scan` uses for grounding URLs: one GET, over `https:`
 * only, to a public address checked by `publicLookup`, with no redirect
 * followed. It answers with a `Response`, as the global fetch does, so the
 * caller reads it the same way. `init.signal` stops it.
 */
export function publicHttpsFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const problem = groundingUrlProblem(url);
    if (problem) {
      reject(new Error(`the URL ${problem}`));
      return;
    }
    const req = request(
      url,
      {
        method: "GET",
        agent: AGENT,
        lookup: publicLookup,
        signal: init.signal,
        headers: { accept: "*/*", "user-agent": "agent-kit-deep-scan" },
      },
      (res) => {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            for (const one of [value].flat()) if (one !== undefined) headers.append(name, one);
          }
          const status = res.statusCode ?? 0;
          let body = null;
          if (NULL_BODY.has(status)) res.resume();
          else body = Readable.toWeb(res);
          resolve(new Response(body, { status, headers }));
        } catch (error) {
          res.destroy();
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
}
