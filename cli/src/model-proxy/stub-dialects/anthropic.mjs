// The stub model's `anthropic` dialect (ADR 0031): how a Messages API request
// reads and how an answer is written, whole or as a stream. The stub itself
// (../stub.mjs) holds the script; this holds the wire shapes. Node core only
// (ADR 0001).

/** The tokens every answer reports, so the proxy has usage to count. */
const USAGE = Object.freeze({ input_tokens: 10, output_tokens: 5 });

/** A tool result's text: a string, or its text blocks joined. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("");
}

/** The Messages API answer's body for one turn. */
function message({ id, model, turn }) {
  const content = turn.call
    ? [{ type: "tool_use", id: turn.call.id, name: turn.call.name, input: turn.call.input }]
    : [{ type: "text", text: turn.text }];
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: turn.call ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { ...USAGE },
  };
}

/** The same answer as the API's server-sent events. */
function stream(whole) {
  const [block] = whole.content;
  const isCall = block.type === "tool_use";
  const events = [
    [
      "message_start",
      {
        message: {
          ...whole,
          content: [],
          stop_reason: null,
          usage: { input_tokens: USAGE.input_tokens, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { index: 0, content_block: isCall ? { ...block, input: {} } : { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      {
        index: 0,
        delta: isCall
          ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          : { type: "text_delta", text: block.text },
      },
    ],
    ["content_block_stop", { index: 0 }],
    [
      "message_delta",
      {
        delta: { stop_reason: whole.stop_reason, stop_sequence: null },
        usage: { output_tokens: USAGE.output_tokens },
      },
    ],
    ["message_stop", {}],
  ];
  return events
    .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    .join("");
}

/** @type {Readonly<import("../stub.mjs").StubDialect>} */
export const anthropicDialect = Object.freeze({
  /** The tools a request declares. */
  tools: (request) => request.tools,
  /** The input a shell tool is called with: its command, and a timeout when it takes one. */
  shellInput: (tool, command, timeoutMs) => ({
    command,
    ...(tool.input_schema?.properties?.timeout ? { timeout: timeoutMs } : {}),
  }),
  /** Every tool result the conversation holds. */
  toolResults: (request) =>
    (Array.isArray(request.messages) ? request.messages : [])
      .flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
      .filter((block) => block?.type === "tool_result")
      .map((block) => ({
        id: String(block.tool_use_id),
        text: textOf(block.content),
        isError: block.is_error === true,
      })),
  /** The answer to a POST of `path`, or null for a path this dialect does not speak. */
  answer({ path, request, id, turn }) {
    if (path === "/v1/messages/count_tokens") {
      return json({ input_tokens: USAGE.input_tokens });
    }
    if (path !== "/v1/messages") return null;
    const whole = message({ id, model: String(request.model ?? "stub-model"), turn: turn() });
    if (request.stream !== true) return json(whole);
    return { type: "text/event-stream", body: stream(whole) };
  },
});

function json(body) {
  return { type: "application/json", body: JSON.stringify(body) };
}
