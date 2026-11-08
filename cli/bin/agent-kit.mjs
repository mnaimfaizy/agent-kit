#!/usr/bin/env node
// @mnaimfaizy/agent-kit: adopt, upgrade and check Agent-kit in a Consumer
// repository. It writes only local files and never changes GitHub settings.

import { main } from "../src/cli.mjs";

process.exitCode = main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (s) => process.stdout.write(`${s}\n`),
  stderr: (s) => process.stderr.write(`${s}\n`),
});
