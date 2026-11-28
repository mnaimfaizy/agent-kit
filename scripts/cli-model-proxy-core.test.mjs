// Contract for the model proxy core (cli/src/model-proxy/core.mjs, ADR 0023):
// it holds no knowledge of any one model API, and a provider profile supplies
// all of it. Tested with a made-up profile against a local fake upstream.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MAX_IN_FLIGHT, startProxy } from "../cli/src/model-proxy/core.mjs";

const REAL = "toy-real-credential";
const CALLER = "toy-caller-key-0123456789abcdef0123456789";

/** A provider that shares no name, path or field with a real model API. */
const TOY = Object.freeze({
  upstream: "https://models.toy.invalid",
  credentialKinds: Object.freeze({
    token: (credential) => ["x-toy-auth", `Token ${credential}`],
    // Written in a header that is not the one the caller sends its key in.
    sealed: (credential) => ["x-toy-sealed", credential],
  }),
  keyHeaders: Object.freeze(["x-toy-auth"]),
  forwardsHeader: (header) => header !== "x-toy-private",
  inScope: (path, decoded) => path.startsWith("/toy/") && decoded.startsWith("/toy/"),
  routes: Object.freeze([
    Object.freeze({ method: "PUT", path: "/toy/say", spends: true }),
    Object.freeze({ method: "PUT", path: "/toy/weigh", spends: false }),
  ]),
  refusals: Object.freeze({ scope: "only /toy/ paths", route: "only PUT to say or weigh" }),
  maxRequestBytes: 4096,
  requestRefusal: (body) => (body?.forbidden ? "a forbidden request" : null),
  inputEstimate: () => 0,
  declaredLimit: (body) => body.at_most,
  errorBody: (kind, message) => ({ toy: kind, message }),
  streamHint: /"(spent|speaker)"/,
  answeringModel: (answer) => answer.speaker,
  usageReducer: () => {
    let seen = 0;
    return (answer) => {
      const added = Math.max((answer.spent ?? 0) - seen, 0);
      seen += added;
      return added;
    };
  },
});

/**
 * A fake upstream answering every request with `answer`. With `hold`, it
 * answers only when `release` is called, so a test decides what is in flight.
 */
async function upstreamOf(answer, hold) {
  const seen = [];
  const held = [];
  const waiting = [];
  const reply = (res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "x-toy-auth": "the upstream's own",
      cookie: "a=b",
      "x-toy-trace": "kept",
    });
    res.end(JSON.stringify(answer));
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (hold) held.push(res);
      else reply(res);
      for (const check of waiting) check();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    /** Resolves once `n` requests have reached the upstream. */
    arrived: (n) =>
      new Promise((resolve) => {
        const check = () => seen.length >= n && resolve(undefined);
        waiting.push(check);
        check();
      }),
    release: () => held.splice(0).forEach(reply),
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

/** Run `body` with a toy proxy in front of a fake upstream, closing both after. */
async function withProxy({ answer = {}, hold = false, ...opts }, body) {
  const api = await upstreamOf(answer, hold);
  const proxy = await startProxy(TOY, {
    credential: REAL,
    kind: "token",
    bind: "127.0.0.1",
    upstream: api.url,
    ...opts,
  });
  const send = ({ method = "PUT", path = "/toy/say", say = {}, headers = {} } = {}) =>
    fetch(`http://127.0.0.1:${proxy.port}${path}`, {
      method,
      headers,
      ...(method === "GET" ? {} : { body: JSON.stringify(say) }),
    });
  try {
    await body({ api, proxy, send });
  } finally {
    await proxy.close();
    await api.close();
  }
}

/**
 * The answer to `sent`, which the proxy must give itself: fails, rather than
 * waiting on a held answer, if it reaches the upstream as request `n`.
 */
const answeredByProxy = (api, sent, n) =>
  Promise.race([sent, api.arrived(n).then(() => assert.fail(`request ${n} reached the upstream`))]);

/** PUT `path` exactly as written, which `fetch` would tidy first. */
const putAsWritten = (port, path) =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "PUT", path }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end("{}");
  });

describe("the model proxy core takes everything about a provider from its profile", () => {
  it("names no provider, header or path of a real model API", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "cli", "src", "model-proxy", "core.mjs"),
      "utf8",
    );
    assert.doesNotMatch(source, /anthropic|claude|openai|gemini|x-api-key|\/v1\b/i);
    assert.doesNotMatch(source, /max_tokens|input_tokens|output_tokens|Messages API/);
  });

  it("writes the profile's auth header, and never passes on a header that could carry the caller's key", () =>
    withProxy({}, async ({ api, send }) => {
      const res = await send({
        path: "/toy/say?q=1",
        headers: {
          "x-toy-auth": "Token placeholder",
          authorization: "Bearer placeholder",
          cookie: "a=b",
          "x-other": "kept",
          "x-toy-private": "dropped",
        },
      });
      assert.equal(res.status, 200);
      const [got] = api.seen;
      assert.deepEqual([got.method, got.url], ["PUT", "/toy/say?q=1"]);
      assert.equal(got.headers["x-toy-auth"], `Token ${REAL}`);
      assert.equal(got.headers.authorization, undefined);
      assert.equal(got.headers.cookie, undefined);
      assert.equal(got.headers["x-other"], "kept");
      assert.equal(got.headers["x-toy-private"], undefined, "the profile's header rule holds");
    }));

  it("drops the caller's key header both ways, even when the real credential goes in another", () =>
    withProxy({ kind: "sealed" }, async ({ api, send }) => {
      const res = await send({
        headers: { "x-toy-auth": "placeholder", "accept-encoding": "gzip" },
      });
      assert.equal(api.seen[0].headers["x-toy-auth"], undefined);
      assert.equal(api.seen[0].headers["x-toy-sealed"], REAL);
      // A plain answer is asked for, whatever the caller asked for.
      assert.equal(api.seen[0].headers["accept-encoding"], "identity");
      assert.equal(res.headers.get("x-toy-auth"), null);
      assert.equal(res.headers.get("cookie"), null);
      assert.equal(res.headers.get("x-toy-trace"), "kept");
    }));

  it("refuses a dot segment, an encoded slash or a backslash, however it is written", () =>
    withProxy({}, async ({ api, proxy }) => {
      const paths = [
        "/toy/./say",
        "/toy/x/../say",
        "/toy/%2e/say",
        "/toy/.%2E/say",
        "/toy/x%2fsay",
        "/toy/x%5Csay",
        "/toy/%E0%A4%A",
        "/toy/say/",
      ];
      for (const path of paths) {
        const { status, text } = await putAsWritten(proxy.port, path);
        // Refused for the path itself, before any route is looked at.
        assert.deepEqual([status, text], [403, "model proxy: only /toy/ paths\n"], path);
      }
      assert.equal(api.seen.length, 0);
    }));

  it("refuses a compressed request body, which it could not judge", () =>
    withProxy({}, async ({ api, send }) => {
      const res = await send({ headers: { "content-encoding": "gzip" } });
      assert.equal(res.status, 415);
      assert.equal(api.seen.length, 0);
    }));

  it("forwards only the profile's routes, within its scope, on a path that decodes plainly", () =>
    withProxy({}, async ({ api, proxy, send }) => {
      for (const [opts, why] of [
        [{ path: "/other/say" }, "only /toy/ paths"],
        [{ path: "/toy/%252e/say" }, "only /toy/ paths"],
        [{ path: "/toy//say" }, "only /toy/ paths"],
        [{ method: "POST" }, "only PUT to say or weigh"],
        [{ path: "/toy/sing" }, "only PUT to say or weigh"],
      ]) {
        const res = await send(opts);
        assert.equal(res.status, 403, JSON.stringify(opts));
        assert.match(await res.text(), new RegExp(why), JSON.stringify(opts));
      }
      assert.equal(api.seen.length, 0);
      assert.ok(proxy.refused.includes("POST /toy/say"), proxy.refused.join(", "));
      assert.equal((await send({ path: "/toy/%73ay" })).status, 200);
    }));

  it("accepts the run's caller key in the profile's key header or as a bearer value", () =>
    withProxy({ callerKey: CALLER }, async ({ api, send }) => {
      const refused = await send({ headers: { "x-toy-auth": "nope" } });
      assert.equal(refused.status, 401);
      assert.equal((await refused.json()).toy, "unauthenticated");
      assert.equal((await send({ headers: { "x-toy-auth": CALLER } })).status, 200);
      assert.equal((await send({ headers: { authorization: `Bearer ${CALLER}` } })).status, 200);
      assert.equal(api.seen.length, 2);
    }));

  it("refuses a body that is not a JSON object itself, before any of the profile's body hooks", () =>
    withProxy({}, async ({ api, proxy }) => {
      // The toy filter passes these, and its declared limit would throw on some.
      for (const body of ["not json", "", "null", "[]", "7", '"text"']) {
        const res = await fetch(`http://127.0.0.1:${proxy.port}/toy/say`, { method: "PUT", body });
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.deepEqual(await res.json(), {
          toy: "invalid_request",
          message: "model proxy: refused a body that is not a JSON object",
        });
      }
      assert.equal(api.seen.length, 0);
    }));

  it("refuses what the profile's body filter and size bound refuse", () =>
    withProxy({}, async ({ api, send }) => {
      const filtered = await send({ say: { forbidden: true } });
      assert.equal(filtered.status, 400);
      assert.deepEqual(await filtered.json(), {
        toy: "invalid_request",
        message: "model proxy: refused a forbidden request",
      });
      const large = await send({ say: { text: "x".repeat(TOY.maxRequestBytes) } });
      assert.equal(large.status, 413);
      assert.equal((await large.json()).toy, "too_large");
      assert.equal(api.seen.length, 0);
    }));

  it("refuses a credential kind the profile does not have", async () => {
    for (const kind of ["api-key", "constructor", ["token"], new String("token")]) {
      await assert.rejects(
        startProxy(TOY, { credential: REAL, kind, bind: "127.0.0.1" }),
        /no credential kind/,
      );
    }
  });

  it("names the model each answer names, and the upstream, in its summary", () =>
    withProxy({ answer: { speaker: "toy-1", spent: 7 } }, async ({ proxy, send }) => {
      await (await send()).text();
      assert.deepEqual(proxy.models(), ["toy-1"]);
      assert.equal(proxy.tokens(), 7);
      assert.match(proxy.summary(), /answered with toy-1/);
    }));
});

describe("the core's cap is counted in tokens: it reserves on arrival and settles to real usage", () => {
  it("holds a request back while a reservation fills the cap, then settles to what was really spent", () =>
    withProxy(
      { answer: { spent: 10 }, hold: true, maxTokens: 100 },
      async ({ api, proxy, send }) => {
        const first = send({ say: { at_most: 100 } });
        await api.arrived(1);
        // Nothing is counted yet: the first request's declared limit holds the cap.
        assert.equal(proxy.tokens(), 0);
        const second = await answeredByProxy(api, send({ say: { at_most: 1 } }), 2);
        assert.equal(second.status, 429);
        assert.equal((await second.json()).toy, "busy");
        api.release();
        await (await first).text();
        assert.equal(proxy.tokens(), 10, "settled to the real usage, not the reservation");
        // Its reservation is gone: with 10 counted, two small requests fit together.
        const third = send({ say: { at_most: 20 } });
        await api.arrived(2);
        const fourth = send({ say: { at_most: 20 } });
        await Promise.race([api.arrived(3), fourth]);
        api.release();
        assert.deepEqual([(await third).status, (await fourth).status], [200, 200]);
      },
    ));

  it("reserves nothing for a route that spends nothing", () =>
    withProxy({ hold: true, maxTokens: 100 }, async ({ api, send }) => {
      const weigh = () => send({ path: "/toy/weigh", say: { at_most: 100 } });
      const first = weigh();
      await api.arrived(1);
      const second = weigh();
      await Promise.race([api.arrived(2), second]);
      api.release();
      assert.deepEqual([(await first).status, (await second).status], [200, 200]);
    }));

  it("refuses every request once the counted tokens reach the cap, telling the caller once", async () => {
    let capped = 0;
    await withProxy(
      { answer: { spent: 60 }, maxTokens: 100, onCap: () => (capped += 1) },
      async ({ send }) => {
        for (const status of [200, 200, 403, 403]) {
          const res = await send();
          assert.equal(res.status, status);
          const body = await res.json();
          if (status === 403) assert.equal(body.toy, "cap_reached");
        }
        assert.equal(capped, 1);
      },
    );
  });

  it(`keeps at most ${MAX_IN_FLIGHT} requests in flight`, () =>
    withProxy({ hold: true }, async ({ api, send }) => {
      const inFlight = Array.from({ length: MAX_IN_FLIGHT }, () => send());
      await api.arrived(MAX_IN_FLIGHT);
      const extra = await answeredByProxy(api, send(), MAX_IN_FLIGHT + 1);
      assert.equal(extra.status, 429);
      api.release();
      for (const res of await Promise.all(inFlight)) assert.equal(res.status, 200);
      assert.equal(api.seen.length, MAX_IN_FLIGHT);
    }));
});
