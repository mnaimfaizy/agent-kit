// Contract for the model proxy core (cli/src/model-proxy/core.mjs, ADR 0023):
// it holds no knowledge of any one model API, and a provider profile supplies
// all of it. Tested with a made-up profile against a local fake upstream.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
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

/** A fake upstream answering every request with `answer` after `ms`. */
async function upstreamOf(answer, ms = 0) {
  const seen = [];
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
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      }, ms);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Run `body` with a toy proxy in front of a fake upstream, closing both after. */
async function withProxy({ answer = {}, ms = 0, ...opts }, body) {
  const api = await upstreamOf(answer, ms);
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
    for (const kind of ["api-key", "constructor"]) {
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
    withProxy({ answer: { spent: 10 }, ms: 200, maxTokens: 100 }, async ({ api, proxy, send }) => {
      const first = send({ say: { at_most: 100 } });
      await new Promise((r) => setTimeout(r, 60));
      // Nothing is counted yet: the first request's declared limit holds the cap.
      assert.equal(proxy.tokens(), 0);
      const second = await send({ say: { at_most: 1 } });
      assert.equal(second.status, 429);
      assert.equal((await second.json()).toy, "busy");
      await (await first).text();
      assert.equal(proxy.tokens(), 10, "settled to the real usage, not the reservation");
      // The reservation is gone, so there is room again.
      assert.equal((await send({ say: { at_most: 100 } })).status, 200);
      assert.equal(api.seen.length, 2);
    }));

  it("reserves nothing for a route that spends nothing", () =>
    withProxy({ answer: {}, ms: 100, maxTokens: 100 }, async ({ send }) => {
      const answers = await Promise.all(
        [1, 2].map(() => send({ path: "/toy/weigh", say: { at_most: 100 } })),
      );
      assert.deepEqual(
        answers.map((r) => r.status),
        [200, 200],
      );
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
    withProxy({ ms: 200 }, async ({ send }) => {
      const answers = await Promise.all(Array.from({ length: MAX_IN_FLIGHT + 3 }, () => send()));
      const forwarded = answers.filter((r) => r.status === 200).length;
      assert.equal(forwarded, MAX_IN_FLIGHT);
      assert.equal(answers.filter((r) => r.status === 429).length, 3);
    }));
});
