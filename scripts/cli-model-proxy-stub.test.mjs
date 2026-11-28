// Contract for the stub model (cli/src/model-proxy/stub.mjs, ADR 0031): a
// kit-owned scripted upstream that answers behind the real model proxy with
// shell tool calls, picking the shell tool from the tools the request
// declares. Tested as the live suite uses it: every request goes through the
// real proxy with the `anthropic` profile, offline, on loopback.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startProxy } from "../cli/src/model-proxy/core.mjs";
import { anthropic } from "../cli/src/model-proxy/profiles/anthropic.mjs";
import { pickShellTool, startStubModel } from "../cli/src/model-proxy/stub.mjs";

const REAL = "sk-ant-api03-real-key-held-by-the-proxy";
const CALLER = "agent-kit-deep-scan-placeholder-0123456789abcdef";

const BASH = {
  name: "Bash",
  description: "Runs a command",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" }, timeout: { type: "number" } },
    required: ["command"],
  },
};
const READ = {
  name: "Read",
  description: "Reads a file",
  input_schema: { type: "object", properties: { file_path: { type: "string" } } },
};

/** The stub behind the real proxy; `send` posts a Messages API request as a harness would. */
async function withStub(opts, body) {
  const stub = await startStubModel(opts);
  const proxy = await startProxy(anthropic, {
    credential: REAL,
    kind: "api-key",
    bind: "127.0.0.1",
    upstream: stub.url,
    callerKey: CALLER,
  });
  const send = async (request, path = "/v1/messages?beta=true") => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
      method: "POST",
      headers: { "x-api-key": CALLER, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
  };
  try {
    await body({ stub, proxy, send });
  } finally {
    await proxy.close();
    await stub.close();
  }
}

const ask = (extra = {}) => ({
  model: "claude-stub",
  max_tokens: 100,
  tools: [READ, BASH],
  messages: [{ role: "user", content: "Read your brief." }],
  ...extra,
});

/** The request that follows `answer`, with the tool's output as its result. */
const after = (request, answer, output) => ({
  ...request,
  messages: [
    ...request.messages,
    { role: "assistant", content: answer.content },
    {
      role: "user",
      content: answer.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({ type: "tool_result", tool_use_id: block.id, content: output })),
    },
  ],
});

/** The events of a streamed answer, in order. */
const events = (text) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const [name, data] = block.split("\n");
      return { event: name.slice("event: ".length), data: JSON.parse(data.slice("data: ".length)) };
    });

describe("the stub model picks the shell tool from the tools a request declares", () => {
  it("takes the declared tool that runs a command line", () => {
    assert.equal(pickShellTool([READ, BASH]).name, "Bash");
    const odd = { name: "run_it", input_schema: { properties: { command: { type: "string" } } } };
    assert.equal(pickShellTool([READ, odd]).name, "run_it");
    assert.equal(pickShellTool([READ, odd, BASH]).name, "Bash", "a shell's name comes first");
  });

  it("takes the named tool when one is named, and none that is not declared", () => {
    const odd = { name: "run_it", input_schema: { properties: { command: { type: "string" } } } };
    assert.equal(pickShellTool([BASH, odd], "run_it").name, "run_it");
    assert.equal(pickShellTool([BASH], "run_it"), null);
    assert.equal(pickShellTool([READ]), null);
    assert.equal(pickShellTool(undefined), null);
  });
});

describe("the stub model answers behind the real model proxy with its scripted calls", () => {
  it("calls the shell tool with each command in turn, then ends, reading each result", () =>
    withStub({ commands: ["echo one", "echo two"] }, async ({ stub, send }) => {
      let request = ask();
      for (const [i, command] of ["echo one", "echo two"].entries()) {
        const res = await send(request);
        assert.equal(res.status, 200, res.text);
        const answer = JSON.parse(res.text);
        assert.equal(answer.stop_reason, "tool_use");
        const [call] = answer.content;
        assert.deepEqual([call.type, call.name, call.input.command], ["tool_use", "Bash", command]);
        request = after(request, answer, `output ${i}`);
      }
      const last = JSON.parse((await send(request)).text);
      assert.equal(last.stop_reason, "end_turn");
      assert.match(last.content[0].text, /output 0[\s\S]*output 1/);
      assert.deepEqual(
        stub.results().map((r) => r.text),
        ["output 0", "output 1"],
      );
    }));

  it("streams the call as the Messages API does, when asked to stream", () =>
    withStub({ commands: ["id"] }, async ({ proxy, send }) => {
      const res = await send(ask({ stream: true }));
      assert.match(res.type, /text\/event-stream/);
      const seen = events(res.text);
      assert.deepEqual(
        seen.map((e) => e.event),
        [
          "message_start",
          "content_block_start",
          "content_block_delta",
          "content_block_stop",
          "message_delta",
          "message_stop",
        ],
      );
      assert.equal(seen[1].data.content_block.name, "Bash");
      assert.deepEqual(JSON.parse(seen[2].data.delta.partial_json), {
        command: "id",
        timeout: 120000,
      });
      assert.equal(seen[4].data.delta.stop_reason, "tool_use");
      // The proxy counts the stub's usage and names its model.
      assert.ok(proxy.tokens() > 0);
      assert.deepEqual(proxy.models(), ["claude-stub"]);
    }));

  it("reads a result given as text blocks, and says when the tool reported an error", () =>
    withStub({ commands: ["false"] }, async ({ stub, send }) => {
      const answer = JSON.parse((await send(ask())).text);
      const request = after(ask(), answer, [{ type: "text", text: "no" }]);
      request.messages.at(-1).content[0].is_error = true;
      await send(request);
      assert.deepEqual(stub.results(), [{ index: 0, text: "no", isError: true }]);
    }));

  it("answers a request with no shell tool with text, and runs nothing", () =>
    withStub({ commands: ["id"] }, async ({ stub, send }) => {
      const answer = JSON.parse((await send(ask({ tools: undefined }))).text);
      assert.equal(answer.stop_reason, "end_turn");
      assert.equal(answer.content[0].type, "text");
      assert.equal(stub.shellTool(), null);
      assert.equal(JSON.parse((await send(ask())).text).content[0].name, "Bash");
      assert.equal(stub.shellTool(), "Bash");
    }));

  it("counts tokens on the counting route", () =>
    withStub({}, async ({ send }) => {
      const res = await send(ask(), "/v1/messages/count_tokens");
      assert.equal(typeof JSON.parse(res.text).input_tokens, "number");
    }));

  it("records what reached it: the proxy's real key, and never the caller's", () =>
    withStub({}, async ({ stub, send }) => {
      await send(ask());
      const [got] = stub.requests;
      assert.equal(got.path, "/v1/messages?beta=true");
      assert.equal(got.headers["x-api-key"], REAL);
      assert.doesNotMatch(JSON.stringify(got), new RegExp(CALLER));
      assert.match(got.body, /Read your brief/);
    }));

  it("starts a new script without taking an earlier script's results for its own", () =>
    withStub({ commands: ["one"] }, async ({ stub, send }) => {
      const answer = JSON.parse((await send(ask())).text);
      const done = after(ask(), answer, "first");
      await send(done);
      stub.script(["two"]);
      const next = JSON.parse((await send(done)).text);
      assert.equal(next.content[0].input.command, "two");
      assert.deepEqual(stub.results(), []);
    }));
});
