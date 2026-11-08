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
  return async (question) => {
    const rl = createInterface({ input, output, terminal: true });
    try {
      return (await rl.question(sanitizeLine(question))).trim();
    } finally {
      rl.close();
    }
  };
}

/** Ask a yes/no question; anything but y or yes is no. */
export async function askYesNo(prompt, question) {
  return /^(?:y|yes)$/i.test(await prompt(question));
}
