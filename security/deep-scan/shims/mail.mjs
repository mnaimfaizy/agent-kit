#!/usr/bin/env node
// TEST-ONLY. A recording SMTP server on 127.0.0.1, standing in for the mail
// server notify-email.sh sends to (the "sendmail" role in Agent-kit's own Deep
// scan fixtures, security/deep-scan/README.md). It relays nothing and accepts
// no message: it records each SMTP command as one JSON line in the log, with
// any AUTH payload, AUTH continuation line and oversized line kept out, offers STARTTLS and AUTH so a client that would
// skip TLS shows up as an AUTH line, answers STARTTLS with 454 (no TLS here),
// and refuses MAIL, RCPT and DATA.
//
// Standalone: `node mail.mjs <log>` prints `listening 127.0.0.1:<port>` and
// runs until stopped. The fixture driver imports startMailShim instead.
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

const MAX_LINE = 4096;
const VERBS = new Set([
  "EHLO",
  "HELO",
  "STARTTLS",
  "AUTH",
  "MAIL",
  "RCPT",
  "DATA",
  "QUIT",
  "NOOP",
  "RSET",
  "VRFY",
  "EXPN",
  "HELP",
]);

const verbOf = (line) => (line.trim().split(/\s+/)[0] ?? "").toUpperCase();

function reply(verb) {
  switch (verb) {
    case "EHLO":
      return "250-recording-mail-shim\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n";
    case "HELO":
      return "250 recording-mail-shim\r\n";
    case "STARTTLS":
      return "454 TLS not available: this is a recording shim\r\n";
    case "AUTH":
      return "535 recording shim: authentication refused\r\n";
    case "QUIT":
      return "221 bye\r\n";
    case "NOOP":
    case "RSET":
      return "250 ok\r\n";
    default:
      return VERBS.has(verb)
        ? "554 recording shim: no mail is accepted\r\n"
        : "500 recording shim: command not recognized\r\n";
  }
}

/**
 * @param {{ log: string }} opts
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function startMailShim({ log }) {
  const record = (command) => appendFileSync(log, `${JSON.stringify({ shim: "mail", command })}\n`);
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.write("220 recording-mail-shim ESMTP (test-only, relays nothing)\r\n");
    let buffer = "";
    // After AUTH, every line that is not an SMTP verb is a credential (an
    // AUTH LOGIN user or password sent ahead of the reply): never logged.
    let inAuth = false;
    // Inside a line too long to keep: drop input up to its newline.
    let dropping = false;
    const handle = (line) => {
      const verb = verbOf(line);
      if (verb === "AUTH") {
        inAuth = true;
        const mechanism = line.trim().split(/\s+/)[1] ?? "";
        record(`AUTH ${/^[A-Za-z0-9_-]{1,20}$/.test(mechanism) ? `${mechanism} ` : ""}[redacted]`);
      } else if (inAuth && !VERBS.has(verb)) {
        record("[redacted: an AUTH continuation line]");
      } else {
        inAuth = false;
        record(line);
      }
      socket.write(reply(verb));
      if (verb === "QUIT") socket.end();
    };
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (dropping) {
          if (end < 0) {
            buffer = "";
            return;
          }
          buffer = buffer.slice(end + 1);
          dropping = false;
          continue;
        }
        if (end < 0 ? buffer.length > MAX_LINE : end > MAX_LINE) {
          record(`[an oversized line was dropped${inAuth ? ", inside AUTH" : ""}]`);
          socket.write(reply(""));
          dropping = true;
          continue;
        }
        if (end < 0) return;
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        handle(line);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  const log = process.argv[2];
  if (!log) {
    console.error("usage: mail.mjs <log file>");
    process.exit(2);
  }
  const { port } = await startMailShim({ log });
  console.log(`listening 127.0.0.1:${port}`);
}
