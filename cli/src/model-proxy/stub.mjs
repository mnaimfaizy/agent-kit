// The stub model (ADR 0031): a kit-owned scripted server that stands in for
// a model API behind the real model proxy, as the proxy's upstream. It
// answers a harness with a fixed list of shell commands, one tool call per
// turn, calling the shell tool it picks from the tools the request declares,
// and ends once each has its result. So the live suite can make a real,
// pinned harness attempt exactly what it wants attempted, with no key, no
// spend and the same answers on every run.
//
// It also records every request that reached it, which is everything the
// harness sent past the proxy: the live suite's host-side evidence. It speaks
// one provider's wire shapes per dialect (stub-dialects/). It holds no
// credential and is not part of any Consumer's run. Node core only (ADR 0001).

import { createServer } from "node:http";
import { anthropicDialect } from "./stub-dialects/anthropic.mjs";

/** The names harnesses give their shell tool, preferred over any other tool that takes a command. */
const SHELL_NAMES = /^(bash|shell|local_shell|exec_command|run_shell_command|run_terminal_cmd)$/i;

/** The largest request the stub reads: the proxy forwards no larger one. */
const MAX_REQUEST = 32 * 1024 * 1024;

/** How long a tool call may run, for a shell tool that takes a timeout. */
const COMMAND_TIMEOUT_MS = 120_000;

/** How much of each result the closing answer repeats, so the harness's own output holds it. */
const MAX_ECHO = 4000;

/**
 * @typedef {{
 *   tools: (request: any) => unknown,
 *   shellInput: (tool: any, command: string, timeoutMs: number) => object,
 *   toolResults: (request: any) => Array<{ id: string, text: string, isError: boolean }>,
 *   answer: (opts: { path: string, request: any, id: string, turn: () => Turn }) =>
 *     { type: string, body: string } | null,
 * }} StubDialect
 * @typedef {{ call?: { id: string, name: string, input: object }, text?: string }} Turn
 *   One turn of the script: a tool call, or the closing text.
 */

/**
 * The shell tool among `tools`, or null: the one named `preferred` when a
 * name is given, else a tool with a shell's name, else the first whose input
 * takes a `command` string.
 * @param {unknown} tools
 * @param {string} [preferred]  a Custom harness file's `probe_shell_tool`
 * @returns {any}
 */
export function pickShellTool(tools, preferred) {
  if (!Array.isArray(tools)) return null;
  const declared = tools.filter((t) => typeof t?.name === "string");
  if (preferred !== undefined) return declared.find((t) => t.name === preferred) ?? null;
  const runs = declared.filter((t) => t.input_schema?.properties?.command?.type === "string");
  return runs.find((t) => SHELL_NAMES.test(t.name)) ?? runs[0] ?? null;
}

/**
 * Start the stub model.
 * @param {{ commands?: string[], shellTool?: string, bind?: string, dialect?: StubDialect }} [opts]
 *   `commands` is the script. `shellTool` names the tool to call, for a
 *   harness whose shell tool the request does not make plain.
 * @returns {Promise<{
 *   url: string,
 *   requests: Array<{ method: string, path: string, headers: Record<string, unknown>, body: string }>,
 *   results: () => Array<{ index: number, text: string, isError: boolean }>,
 *   shellTool: () => string | null,
 *   script: (commands: string[]) => void,
 *   close: () => Promise<void>,
 * }>}  `results` are the current script's tool results, by command, as the
 *   harness last sent them. `shellTool` is the tool the stub called, or null
 *   if no request declared one. `script` replaces the script.
 */
export async function startStubModel({
  commands = [],
  shellTool,
  bind = "127.0.0.1",
  dialect = anthropicDialect,
} = {}) {
  const requests = [];
  let generation = 0;
  let script = [...commands];
  let answers = 0;
  let called = null;
  /** @type {Map<number, { index: number, text: string, isError: boolean }>} */
  const results = new Map();

  /** The id of the current script's call `index`, so no other script's result counts as its. */
  const callId = (index) => `toolu_stub_${generation}_${index}`;
  const indexOf = (id) => {
    const prefix = `toolu_stub_${generation}_`;
    return id.startsWith(prefix) ? Number(id.slice(prefix.length)) : -1;
  };

  /** The next turn: the command after the last one the conversation has a result for. */
  function turnFor(request) {
    let next = 0;
    for (const result of dialect.toolResults(request)) {
      const index = indexOf(result.id);
      if (!Number.isInteger(index) || index < 0 || index >= script.length) continue;
      results.set(index, { index, text: result.text, isError: result.isError });
      next = Math.max(next, index + 1);
    }
    const tool = pickShellTool(dialect.tools(request), shellTool);
    // A request with no shell tool (a harness's own side calls) runs nothing.
    if (!tool) return { text: "stub model: no shell tool was declared." };
    if (next < script.length) {
      called = tool.name;
      return {
        call: {
          id: callId(next),
          name: tool.name,
          input: dialect.shellInput(tool, script[next], COMMAND_TIMEOUT_MS),
        },
      };
    }
    const echo = [...results.values()].map((r) => r.text.slice(0, MAX_ECHO));
    return { text: ["stub model: the script is done.", ...echo].join("\n") };
  }

  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_REQUEST) chunks.push(chunk);
    });
    req.on("error", () => res.destroy());
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "";
      requests.push({ method: req.method ?? "", path: url, headers: { ...req.headers }, body });
      let request = null;
      try {
        request = JSON.parse(body);
      } catch {
        request = null;
      }
      const answer =
        req.method === "POST" && request && typeof request === "object"
          ? dialect.answer({
              path: url.split("?")[0],
              request,
              id: `msg_stub_${(answers += 1)}`,
              turn: () => turnFor(request),
            })
          : null;
      if (!answer) {
        res.writeHead(404).end("stub model: not a route it speaks\n");
        return;
      }
      res.writeHead(200, { "content-type": answer.type }).end(answer.body);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bind, () => resolve(undefined));
  });
  const address = server.address();
  return {
    url: `http://${bind}:${typeof address === "object" && address ? address.port : 0}`,
    requests,
    results: () => [...results.values()].sort((a, b) => a.index - b.index),
    shellTool: () => called,
    script(next) {
      generation += 1;
      script = [...next];
      results.clear();
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
