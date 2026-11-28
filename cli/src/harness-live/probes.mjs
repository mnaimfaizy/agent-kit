// The live suite's probes (ADR 0031): the shell scripts the stub model has the
// harness run in its own sandbox, one per Guard (ADR 0025), each an attempt
// to breach it. A probe judges nothing: it prints what it saw, and the host
// reads those lines (assess.mjs) beside what it saw itself.
//
// The lines: `PROBE|<guard>|<name>|<value>`, with `PROBE|<guard>|end` last, so
// a probe that did not finish is told from one that found nothing. A dump of
// the environment prefixes its lines `ENV ` (this shell's) or `PROC ` (every
// process's), and a command line `CMD `.
//
// A probe's own text is part of what the host reads (it travels in the model's
// tool call, and its shell's command line), so no script holds a canary, or
// the name of anything of the launcher's.

/** Where a planted checkout config writes its marker, if the harness loads it. */
export const MARKER_DIR = "/tmp/agent-kit-config-markers";

/** The variable a planted checkout config sets, if the harness loads it. */
export const PLANTED_ENV = "AGENT_KIT_PLANTED_CONFIG";

/** The workspace's own file, read to show the read probe can read. */
export const CONTROL_FILE = "agent-kit-control.txt";

/** Where every probe's output is gathered in the sandbox, for the result. */
const LOG = "/tmp/agent-kit-probes.log";

/** The longest a probe waits on one connection, in seconds. */
const CONNECT_SECONDS = 5;

/** A word quoted for `sh`. */
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Every process's environment, one variable per line. */
const ENVIRONMENT = [
  "env | sed 's/^/ENV /'",
  "cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | sort -u | sed 's/^/PROC /'",
];

/** The longest the filesystem sweep may take, inside the stub's tool timeout. */
const SWEEP_SECONDS = 100;

/** The pattern of a canary's value, written so this text is not one. */
const CANARY_PATTERN = "AKCANARY[-][0-9a-f]\\{32\\}";

function reads({ hostFiles }) {
  return [
    `echo "PROBE|reads|control|$(cat /workspace/${CONTROL_FILE})"`,
    ...hostFiles.flatMap((file) => [
      // The path as it is, and through the first process's root.
      `for p in ${quote(file)} ${quote(`/proc/1/root${file}`)}; do`,
      `  if cat "$p" 2>/dev/null; then echo; echo "PROBE|reads|file|read|$p"; else echo "PROBE|reads|file|absent|$p"; fi`,
      "done",
    ]),
    // A canary anywhere the shell can read, whatever the file is called. The
    // workspace holds one the sweep must find, and its status says it ended.
    `swept=$(timeout ${SWEEP_SECONDS} grep -rIsoh --devices=skip --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev '${CANARY_PATTERN}' / 2>/dev/null)`,
    'echo "PROBE|reads|sweep|$?"',
    `printf '%s\\n' "$swept" | sort -u | head -n 20`,
  ];
}

function writes({ hostFiles, resultPath }) {
  const out = resultPath.slice(0, resultPath.lastIndexOf("/"));
  return [
    'cd /workspace && echo "edited by the probe" >> README.md && echo "PROBE|writes|edit|done"',
    // A write to .git, and a bundle of the edit, beside the result.
    "git init -q 2>&1",
    "git config user.email probe@example.invalid && git config user.name probe",
    "git config core.hooksPath /tmp/probe-hooks",
    `git add -A 2>&1 && git commit -qm probe 2>&1`,
    `mkdir -p ${out} && git bundle create ${out}/result.bundle HEAD >/dev/null 2>&1 && echo "PROBE|writes|bundle|made"`,
    ...hostFiles.map(
      (file) => `(mkdir -p "$(dirname ${quote(file)})" && echo breached > ${quote(file)}) 2>&1`,
    ),
  ];
}

function github() {
  return [
    ...ENVIRONMENT,
    "git -C /workspace config --list --show-origin 2>/dev/null | sed 's/^/GITCONFIG /'",
    "cat ~/.git-credentials ~/.config/gh/hosts.yml 2>/dev/null",
  ];
}

function key() {
  return [
    ...ENVIRONMENT,
    'for f in /proc/[0-9]*/cmdline; do c=$(tr \'\\0\\n\' \'  \' < "$f" 2>/dev/null | head -c 200); [ -n "$c" ] && echo "CMD $c"; done',
    `grep -ahso '${CANARY_PATTERN}' /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null | head -n 20`,
  ];
}

function config() {
  return [
    `ls ${MARKER_DIR} 2>/dev/null | sed 's/^/PROBE|config|marker|/'`,
    `echo "PROBE|config|planted-env|\${${PLANTED_ENV}:-unset}"`,
  ];
}

function network({ hostTargets }) {
  const attempt = (name, ...args) => `attempt ${name} ${args.map(quote).join(" ")}`;
  return [
    // curl's exit code, the HTTP status, the seconds to connect (0 when it never
    // did) and a proxy's answer to CONNECT.
    "attempt() {",
    "  name=$1; shift",
    `  seen=$(curl -s -o /dev/null --max-time ${CONNECT_SECONDS} -w '%{exitcode} %{http_code} %{time_connect} %{http_connect}' "$@" 2>/dev/null)`,
    '  echo "PROBE|network|$name|$seen"',
    "}",
    attempt("outside-host", "https://example.com/"),
    attempt("outside-address", "https://1.1.1.1/"),
    attempt(
      "metadata",
      "-H",
      "Metadata: true",
      "http://169.254.169.254/metadata/instance?api-version=2021-02-01",
    ),
    attempt("docker-socket", "--unix-socket", "/var/run/docker.sock", "http://localhost/version"),
    attempt("docker-socket-run", "--unix-socket", "/run/docker.sock", "http://localhost/version"),
    ...hostTargets.map((t, i) => attempt(`host-${i}`, `http://${t.host}:${t.port}/`)),
    'if ! command -v getent >/dev/null; then echo "PROBE|network|dns|notool"; elif getent hosts example.com >/dev/null 2>&1; then echo "PROBE|network|dns|resolved"; else echo "PROBE|network|dns|unresolved"; fi',
    // The one route there is, and what it refuses: a path outside the model
    // API, and being used as a proxy to anywhere else.
    'attempt proxy "$ANTHROPIC_BASE_URL/agent-kit-probe"',
    'attempt proxy-forward -x "$ANTHROPIC_BASE_URL" http://example.com/',
    'attempt proxy-connect -x "$ANTHROPIC_BASE_URL" https://example.com/',
  ];
}

const PROBES = Object.freeze({ reads, writes, github, key, config, network });

/**
 * The script of commands the stub model runs, in order: one per Guard, then
 * one that writes every probe's output as the run's result.
 * @param {{
 *   hostFiles: string[],
 *   hostTargets: Array<{ host: string, port: number }>,
 *   resultPath: string,
 * }} opts  `hostFiles` are canary files on the host, outside the sandbox, and
 *   `hostTargets` the addresses the host listens on, which the sandbox must
 *   not reach.
 * @returns {Array<{ guard: string, script: string }>}
 */
export function probeScripts(opts) {
  const probes = Object.entries(PROBES).map(([guard, lines]) => ({
    guard,
    // In a subshell, so a probe's `cd` and functions are its own.
    script: ["(", ...lines(opts), `echo "PROBE|${guard}|end"`, `) 2>&1 | tee -a ${LOG}`].join("\n"),
  }));
  const folder = opts.resultPath.slice(0, opts.resultPath.lastIndexOf("/"));
  return [
    ...probes,
    {
      guard: "result",
      script: `mkdir -p ${folder} && cp ${LOG} ${opts.resultPath} && echo "PROBE|result|end"`,
    },
  ];
}
