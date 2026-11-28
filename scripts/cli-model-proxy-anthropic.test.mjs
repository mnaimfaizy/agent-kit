// Contract for the `anthropic` provider profile
// (cli/src/model-proxy/profiles/anthropic.mjs, ADR 0023): its routes, its
// body filter and its usage reducer, through the proxy core in front of a
// local fake upstream.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { startProxy } from "../cli/src/model-proxy/core.mjs";
import { anthropic } from "../cli/src/model-proxy/profiles/anthropic.mjs";

const REAL = "sk-ant-api03-fake-real-key-for-profile-tests";
const SSE = "text/event-stream";
const JSON_TYPE = "application/json";
const TURN = { model: "claude-test", max_tokens: 100, messages: [] };

/** One stream event, as the Messages API writes it. */
const event = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

/** Run `body` with the profile's proxy in front of a fake upstream answering `text`. */
async function withProxy({ type = JSON_TYPE, text = "{}", ...opts }, body) {
  const seen = [];
  const api = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": type }).end(text));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const proxy = await startProxy(anthropic, {
    credential: REAL,
    kind: "api-key",
    bind: "127.0.0.1",
    upstream: `http://127.0.0.1:${api.address().port}`,
    ...opts,
  });
  const send = ({ method = "POST", path = "/v1/messages", request = TURN } = {}) =>
    fetch(`http://127.0.0.1:${proxy.port}${path}`, {
      method,
      ...(method === "GET" ? {} : { body: JSON.stringify(request) }),
    });
  try {
    await body({ seen, proxy, send });
  } finally {
    await proxy.close();
    await new Promise((r) => api.close(r));
  }
}

describe("the anthropic profile's upstream, credentials and routes", () => {
  it("is a frozen description of the Messages API at api.anthropic.com", () => {
    assert.equal(anthropic.upstream, "https://api.anthropic.com");
    assert.ok(Object.isFrozen(anthropic));
  });

  it("writes an API key as x-api-key and a subscription token as a bearer value", () => {
    assert.deepEqual(anthropic.credentialKinds["api-key"]("k"), ["x-api-key", "k"]);
    assert.deepEqual(anthropic.credentialKinds.subscription("t"), ["authorization", "Bearer t"]);
  });

  it("forwards POST to the two Messages API paths, and nothing else", () =>
    withProxy({}, async ({ seen, send }) => {
      for (const path of ["/v1/messages?beta=true", "/v1/messages/count_tokens"]) {
        assert.equal((await send({ path })).status, 200, path);
      }
      for (const [method, path] of [
        ["GET", "/v1/models"],
        ["GET", "/v1/messages"],
        ["POST", "/v1/files"],
        ["POST", "/v1/complete"],
        ["POST", "/v1/messages/batches"],
        ["POST", "/api/oauth/profile"],
      ]) {
        assert.equal((await send({ method, path })).status, 403, `${method} ${path}`);
      }
      assert.deepEqual(
        seen.map((s) => s.url),
        ["/v1/messages?beta=true", "/v1/messages/count_tokens"],
      );
    }));
});

describe("the anthropic profile's body filter lets only client tools through", () => {
  const clientTool = { name: "Read", input_schema: { type: "object" } };

  it("forwards a client tool, and refuses each way to make the API act, as an API error", () =>
    withProxy({}, async ({ seen, send }) => {
      assert.equal((await send({ request: { ...TURN, tools: [clientTool] } })).status, 200);
      for (const extra of [
        { tools: [{ type: "web_search_20250305", name: "web_search" }] },
        { tools: [clientTool, { type: "web_fetch_20250910", name: "web_fetch" }] },
        { mcp_servers: [] },
        { container: "c" },
        { system: [{ type: "text", text: "s", file_id: "f" }] },
        {
          messages: [
            { role: "user", content: [{ type: "image", source: { type: "url", url: "u" } }] },
          ],
        },
        { messages: [{ role: "assistant", content: [{ type: "server_tool_use" }] }] },
      ]) {
        const res = await send({ request: { ...TURN, ...extra } });
        assert.equal(res.status, 400, JSON.stringify(extra));
        const answer = await res.json();
        assert.equal(answer.type, "error");
        assert.equal(answer.error.type, "invalid_request_error");
      }
      assert.equal(seen.length, 1);
    }));
});

describe("the anthropic profile's usage reducer counts each token once", () => {
  const usage = {
    input_tokens: 10,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 30,
    output_tokens: 40,
    // Already inside the four above, or not tokens: never counted.
    cache_creation: { ephemeral_5m_input_tokens: 20 },
    server_tool_use: { web_search_requests: 9 },
  };

  it("sums the four kinds of a JSON answer, and names its model", () =>
    withProxy(
      { text: JSON.stringify({ type: "message", model: "claude-test-1", usage }) },
      async ({ proxy, send }) => {
        await (await send()).text();
        assert.equal(proxy.tokens(), 100);
        assert.deepEqual(proxy.models(), ["claude-test-1"]);
      },
    ));

  it("counts a stream's cumulative usage at its highest value, and names message_start's model", () =>
    withProxy(
      {
        type: SSE,
        text: [
          event({
            type: "message_start",
            message: {
              model: "claude-test-2",
              usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 1 },
            },
          }),
          event({ type: "message_delta", usage: { output_tokens: 12 } }),
          event({ type: "message_delta", usage: { input_tokens: 7, output_tokens: 25 } }),
        ].join(""),
      },
      async ({ proxy, send }) => {
        await (await send()).text();
        assert.equal(proxy.tokens(), 7 + 3 + 25);
        assert.deepEqual(proxy.models(), ["claude-test-2"]);
      },
    ));

  it("settles each request to its real usage, refusing once that reaches the cap", () =>
    withProxy(
      { text: JSON.stringify({ usage: { input_tokens: 60, output_tokens: 40 } }), maxTokens: 150 },
      async ({ proxy, send }) => {
        // Each declares far more than the cap; only what was used is counted.
        const request = { ...TURN, max_tokens: 5000 };
        for (const [status, counted] of [
          [200, 100],
          [200, 200],
          [403, 200],
        ]) {
          const res = await send({ request });
          await res.text();
          assert.deepEqual([res.status, proxy.tokens()], [status, counted]);
        }
      },
    ));
});
