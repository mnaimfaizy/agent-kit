// Questions on the terminal, with Node's built-in readline/promises (no
// dependency). Only used when stdin and stdout are both a terminal; without
// one, commands stop and name the flags to pass instead.

import { createInterface } from "node:readline/promises";
import { sanitizeLine } from "./checks/result.mjs";

/**
 * @param {{ input: NodeJS.ReadableStream & { isTTY?: boolean }, output: NodeJS.WritableStream & { isTTY?: boolean } }} streams
 * @returns {((question: string) => Promise<string>) | null} null when there is no terminal
 */
export function terminalPrompt({ input, output }) {
  if (!input.isTTY || !output.isTTY) return null;
  // Ctrl-D (end of input) and Ctrl-C answer "" rather than throwing or
  // ending the process, so the command stops cleanly ("Stopped. Nothing was
  // changed.") and still removes its temporary repository.
  return (question) =>
    new Promise((resolve) => {
      const rl = createInterface({ input, output, terminal: true });
      let done = false;
      const finish = (answer) => {
        if (done) return;
        done = true;
        rl.close();
        resolve(answer);
      };
      rl.on("close", () => finish(""));
      rl.on("SIGINT", () => {
        output.write("\n");
        finish("");
      });
      rl.question(sanitizeLine(question)).then(
        (answer) => finish(answer.trim()),
        () => finish(""),
      );
    });
}

/** Ask a yes/no question; anything but y or yes is no. */
export async function askYesNo(prompt, question) {
  return /^(?:y|yes)$/i.test(await prompt(question));
}
