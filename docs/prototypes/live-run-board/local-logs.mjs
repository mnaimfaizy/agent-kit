// PROTOTYPE, throwaway (#407). Inlines the spec-344 Activity Logs (the Chief of Staff's and each Delegation's) into
// local-logs.js, which board.html loads if present. The logs quote private text, so local-logs.js is gitignored:
// this is the "page generated on the machine" case, and the prose never leaves it.
//   node docs/prototypes/live-run-board/local-logs.mjs
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const main = resolve(execSync('git rev-parse --git-common-dir', { cwd: here }).toString().trim(), '..');
const run = join(main, 'tmp', 'orchestrate', '2026-11-19-spec-344');
const logs = {};
if (existsSync(join(run, 'activity.md'))) logs['chief-of-staff'] = readFileSync(join(run, 'activity.md'), 'utf8');
for (const d of existsSync(join(run, 'delegations')) ? readdirSync(join(run, 'delegations')) : []) {
  const p = join(run, 'delegations', d, 'activity.md');
  if (existsSync(p)) logs[d] = readFileSync(p, 'utf8');
}
writeFileSync(join(here, 'local-logs.js'), 'window.LOCAL_LOGS = ' + JSON.stringify(logs).replace(/</g, '\\u003c') + ';\n');
console.log(`local-logs.js: ${Object.keys(logs).length} Activity Logs (gitignored)`);
