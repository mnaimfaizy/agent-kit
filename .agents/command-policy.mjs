#!/usr/bin/env node
// Antigravity PreToolUse hook for `run_command`.
//
// Evaluates proposed shell commands against a three-tier policy:
//   - deny: catastrophic or secret-exfiltrating commands (hard block)
//   - force_ask / ask: risky, destructive, or external-write commands (prompt)
//   - auto_approve: verified read-only or reversible dev commands (skip prompt
//     in Auto/Default mode while still honoring user ask/deny rules)
//   - allow: unclassified commands fall through to Antigravity's default policy
//
// Contract: https://antigravity.google/docs/hooks (PreToolUse, camelCase JSON).
// Stdin:  { toolCall: { name: "run_command", args: { CommandLine, ... } }, ... }
// Stdout: { decision: "deny" | "force_ask" | "ask" | "auto_approve" | "allow", reason?: string }
import { pathToFileURL } from "node:url";

const RANK = Object.freeze({
  auto_approve: 0,
  allow: 1,
  ask: 2,
  force_ask: 3,
  deny: 4,
});

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const RCE_PIPE =
  /(?:^|[;&|\s])(?:curl|curl\.exe|wget|wget\.exe|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|pwsh|powershell|cmd|cmd\.exe|iex|invoke-expression|python3?|node|perl|ruby)\b/i;

const SENSITIVE_PATH =
  /(?:^|[\\/\s"':=])(?:\.ssh(?:$|[\\/])|\.aws(?:$|[\\/])|\.gnupg(?:$|[\\/])|\.config[\\/]gh(?:$|[\\/])|gh[\\/]hosts\.yml$|id_rsa(?:\.pub)?$|id_ed25519(?:\.pub)?$|\.env(?:\.(?!example$|sample$|template$)[A-Za-z0-9_-]+)?$)/i;

const ENV_DRIVE = /^env:/i;

const CATASTROPHIC_TARGET =
  /^(?:\/+|\\+|[a-z]:[\\/]*|~(?:[\\/]\*?)?|\$home(?:[\\/]\*?)?|\.\.(?:[\\/]\.\.)*|\*|\.git(?:[\\/].*)?)$/i;

const DENY_BINARIES = new Set([
  "sudo",
  "su",
  "runas",
  "doas",
  "dd",
  "fdisk",
  "diskpart",
  "bcdedit",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "iex",
  "invoke-expression",
  "stop-computer",
  "restart-computer",
  "format-volume",
  "clear-disk",
  "format",
]);

const FORCE_ASK_BINARIES = new Set([
  "curl",
  "wget",
  "iwr",
  "irm",
  "invoke-webrequest",
  "invoke-restmethod",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "docker",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "aws",
  "gcloud",
  "az",
  "chmod",
  "chown",
  "icacls",
  "takeown",
  "kill",
  "pkill",
  "killall",
  "taskkill",
  "stop-process",
  "set-executionpolicy",
  "start-process",
]);

const DELETE_BINARIES = new Set(["rm", "remove-item", "ri", "del", "erase", "rmdir", "rd"]);

const FILE_READ_BINARIES = new Set([
  "cat",
  "type",
  "get-content",
  "gc",
  "head",
  "tail",
  "sed",
  "awk",
  "less",
  "more",
]);

const SAFE_PIPE_HELPERS = new Set([
  "select-object",
  "select-string",
  "sort-object",
  "measure-object",
  "where-object",
  "format-table",
  "format-list",
  "convertfrom-json",
  "convertto-json",
  "out-string",
  "grep",
  "rg",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "echo",
  "printf",
  "pwd",
  "which",
  "where",
  "get-location",
  "test-path",
]);

const SAFE_GIT_READONLY = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "rev-list",
  "merge-base",
  "merge-tree",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "describe",
  "shortlog",
  "blame",
  "grep",
  "cat-file",
  "check-ignore",
  "check-attr",
  "symbolic-ref",
  "for-each-ref",
  "name-rev",
  "show-ref",
  "fetch",
  "add",
  "version",
  "--version",
]);

const FORCE_ASK_GIT_SUBCOMMANDS = new Set([
  "clean",
  "rebase",
  "restore",
  "filter-branch",
  "filter-repo",
  "cherry-pick",
  "revert",
  "am",
  "apply",
  "submodule",
  "gc",
  "prune",
]);

const SAFE_GH_READONLY = {
  issue: new Set(["view", "list", "status"]),
  pr: new Set(["view", "list", "diff", "checks", "status"]),
  repo: new Set(["view", "list"]),
  label: new Set(["list"]),
  run: new Set(["view", "list", "watch"]),
  workflow: new Set(["list", "view"]),
  release: new Set(["list", "view"]),
  auth: new Set(["status"]),
};

const ASK_GH_WRITES = {
  issue: new Set(["create", "comment"]),
  pr: new Set(["create", "comment", "review"]),
};

const SAFE_RECORDS_SUBCOMMANDS = new Set(["event", "derive", "board", "dashboard"]);
const FORCE_ASK_RECORDS_SUBCOMMANDS = new Set(["upload", "upload-raw", "prune"]);

const SAFE_PYTHON_SCRIPTS = new Set([
  "scripts/verify_release_snapshot.py",
  "scripts/gen_workflow_reference.py",
  "scripts/gen_doc_blocks.py",
]);

const SAFE_NODE_SCRIPTS = new Set([
  "scripts/doc-facts.mjs",
  ".claude/skills/orchestrate/config.mjs",
  ".claude/skills/qa-plan/adapter.mjs",
  ".claude/skills/manual-qa/adapter.mjs",
  ".claude/skills/address-pr-review/adapter.mjs",
]);

const RELEASE_SCRIPTS = /(?:^|[\\/])(?:cut-release|prepare-release)\.sh$/i;

/** Normalize a binary path/name across Unix and Windows (strips path and .exe/.cmd/.bat). */
function normalizeBin(token) {
  const base = token.replace(/^.*[\\/]/, "").toLowerCase();
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/, "");
}

/** Normalize a relative script path for comparison across Windows and Unix. */
function normalizePath(token) {
  return token.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

/**
 * Tokenize a shell command line into operator-delimited segments while tracking
 * quotes and unsafe shell metacharacters.
 */
export function parseCommand(command) {
  const raw = String(command ?? "");
  const segments = [];
  let words = [];
  let word = null;
  let hasDynamicExpansion = false;
  let hasSubshell = false;
  let hasRedirection = false;

  const pushWord = () => {
    if (word !== null) {
      words.push(word);
      word = null;
    }
  };
  const endSegment = () => {
    pushWord();
    if (words.length > 0) {
      segments.push(words);
      words = [];
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1] ?? "";

    if (c === "'") {
      const close = raw.indexOf("'", i + 1);
      if (close < 0) return { error: "unclosed single quote" };
      word = (word ?? "") + raw.slice(i + 1, close);
      i = close;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let text = "";
      for (; j < raw.length && raw[j] !== '"'; j++) {
        if (raw[j] === "`") {
          hasSubshell = true;
          hasDynamicExpansion = true;
        } else if (raw[j] === "$") {
          if (raw[j + 1] === "(") hasSubshell = true;
          hasDynamicExpansion = true;
        }
        if (raw[j] === "\\" && j + 1 < raw.length && (raw[j + 1] === '"' || raw[j + 1] === "\\")) {
          j++;
        }
        text += raw[j];
      }
      if (j >= raw.length) return { error: "unclosed double quote" };
      word = (word ?? "") + text;
      i = j;
      continue;
    }

    // Harmless null/stderr redirections (2>&1, 2>/dev/null, 2>$null, >/dev/null, >$null).
    if (
      (c === "2" && next === ">") ||
      (c === ">" && (raw.slice(i).startsWith(">$null") || raw.slice(i).startsWith(">/dev/null")))
    ) {
      const rest = raw.slice(i);
      const nullMatch = /^(?:2?>&1|2?>(?:\/dev\/null|\$null))(?=$|[\s;&|])/.exec(rest);
      if (nullMatch) {
        pushWord();
        i += nullMatch[0].length - 1;
        continue;
      }
    }

    if (c === "`") {
      hasSubshell = true;
      hasDynamicExpansion = true;
      word = (word ?? "") + c;
      continue;
    }

    if (c === "$") {
      if (next === "(") hasSubshell = true;
      hasDynamicExpansion = true;
      word = (word ?? "") + c;
      continue;
    }

    if (c === "<" || c === ">") {
      if (next === "(") hasSubshell = true;
      hasRedirection = true;
      pushWord();
      if (next === ">" || next === "<" || next === "&") i++;
      continue;
    }

    if (c === "(" || c === ")") {
      hasSubshell = true;
      endSegment();
      continue;
    }

    if (c === ";" || c === "\n") {
      endSegment();
      continue;
    }

    if (c === "&" || c === "|") {
      endSegment();
      if (next === c) i++;
      continue;
    }

    if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      continue;
    }

    word = (word ?? "") + c;
  }

  endSegment();
  return { segments, hasDynamicExpansion, hasSubshell, hasRedirection };
}

function decision(kind, reason) {
  return reason ? { decision: kind, reason } : { decision: kind };
}

/** Check if any argument references a sensitive secret/credential path. */
function hasSensitivePath(args) {
  return args.some((arg) => SENSITIVE_PATH.test(arg) || ENV_DRIVE.test(arg));
}

/** Classify `gh api ...` into auto_approve (read-only GET/HEAD) or force_ask (mutation/graphql). */
function judgeGhApi(args) {
  // Flags that consume the next argument as a value (so the value isn't parsed as flags/endpoint).
  const valueLong = new Set([
    "jq",
    "template",
    "header",
    "cache",
    "hostname",
    "preview",
    "method",
    "field",
    "raw-field",
    "input",
  ]);
  const valueShort = new Set(["q", "t", "H", "p", "X", "f", "F"]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      const rest = args.slice(i + 1);
      if (rest.some((p) => /^\/?graphql(?:$|\?)/i.test(p))) {
        return decision("force_ask", "`gh api graphql` requires approval");
      }
      break;
    }

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).toLowerCase();
      const value = eq >= 0 ? arg.slice(eq + 1) : args[i + 1];

      if (name === "field" || name === "raw-field" || name === "input") {
        return decision(
          "force_ask",
          `\`gh api --${name}\` mutates remote state and requires approval`,
        );
      }
      if (name === "method") {
        const method = String(value ?? "").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          return decision(
            "force_ask",
            `mutating \`gh api --method ${method || "<unknown>"}\` requires approval`,
          );
        }
        if (eq < 0) i++;
        continue;
      }
      if (eq < 0 && valueLong.has(name)) i++;
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      for (let k = 1; k < arg.length; k++) {
        const ch = arg[k];
        if (ch === "f" || ch === "F") {
          return decision(
            "force_ask",
            `\`gh api -${ch}\` sends fields (POST) and requires approval`,
          );
        }
        if (ch === "X") {
          const attached = arg.slice(k + 1);
          const method = String(attached || args[i + 1] || "").toUpperCase();
          if (method !== "GET" && method !== "HEAD") {
            return decision(
              "force_ask",
              `mutating \`gh api -X ${method || "<unknown>"}\` requires approval`,
            );
          }
          if (!attached) i++;
          break;
        }
        if (valueShort.has(ch)) {
          if (k === arg.length - 1) i++;
          break;
        }
      }
      continue;
    }

    if (/^\/?graphql(?:$|\?)/i.test(arg)) {
      return decision("force_ask", "`gh api graphql` requires approval");
    }
  }

  return decision("auto_approve", "read-only `gh api` GET request");
}

function judgeGh(args) {
  if (args.length === 0) return decision("auto_approve", "gh help");
  const sub = args[0].toLowerCase();
  const rest = args.slice(1);

  if (
    sub === "status" ||
    sub === "version" ||
    sub === "--version" ||
    sub === "-v" ||
    sub === "help"
  ) {
    return decision("auto_approve", `read-only \`gh ${sub}\``);
  }
  if (sub === "auth" && rest[0]?.toLowerCase() === "token") {
    return decision("deny", "`gh auth token` exposes GitHub credentials");
  }
  if (sub === "api") {
    return judgeGhApi(rest);
  }

  const action = rest[0]?.toLowerCase() ?? "";
  if (SAFE_GH_READONLY[sub]?.has(action)) {
    return decision("auto_approve", `read-only \`gh ${sub} ${action}\``);
  }
  if (ASK_GH_WRITES[sub]?.has(action)) {
    return decision("ask", `external GitHub write \`gh ${sub} ${action}\` requires approval`);
  }

  const highRiskGroups = new Set([
    "secret",
    "variable",
    "ruleset",
    "ssh-key",
    "gpg-key",
    "auth",
    "release",
    "workflow",
    "repo",
    "label",
    "pr",
    "issue",
    "run",
  ]);
  if (highRiskGroups.has(sub)) {
    return decision(
      "force_ask",
      `risky GitHub operation \`gh ${sub}${action ? ` ${action}` : ""}\` requires approval`,
    );
  }

  return decision("ask", `unclassified \`gh ${sub}\` requires approval`);
}

function isDestructiveGitPush(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (
      arg === "--force-with-lease" ||
      arg.startsWith("--force-with-lease=") ||
      arg === "--force-if-includes"
    ) {
      continue;
    }
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0].toLowerCase();
      if (
        name.startsWith("for") ||
        name.startsWith("de") ||
        name.startsWith("mi") ||
        name.startsWith("pru")
      ) {
        return true;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (/[fd]/.test(arg.slice(1))) return true;
      continue;
    }
    // Positional refspec starting with `+` (force update) or `:` (remote delete).
    if (arg.startsWith("+") || arg.startsWith(":")) return true;
  }
  return false;
}

function judgeGit(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const flag = args[i];
    if (flag === "-C") {
      i += 2;
      continue;
    }
    if (
      flag === "--no-pager" ||
      flag === "-P" ||
      flag === "--paginate" ||
      flag === "--no-optional-locks" ||
      flag === "--literal-pathspecs" ||
      flag === "--glob-pathspecs"
    ) {
      i++;
      continue;
    }
    if (flag === "--version" || flag === "-v") {
      return decision("auto_approve", "git version");
    }
    return decision(
      "force_ask",
      `git global option \`${flag}\` can alter repo config or execute hooks`,
    );
  }

  if (i >= args.length) return decision("auto_approve", "git help");
  const sub = args[i].toLowerCase();
  const rest = args.slice(i + 1);

  if (sub === "push") {
    if (isDestructiveGitPush(rest)) {
      return decision(
        "deny",
        "destructive `git push` (--force, --delete, --mirror, or +/- refspec) is blocked",
      );
    }
    return decision("force_ask", "`git push` modifies a remote repository and requires approval");
  }

  if (FORCE_ASK_GIT_SUBCOMMANDS.has(sub)) {
    return decision("force_ask", `potentially destructive \`git ${sub}\` requires approval`);
  }

  if (sub === "reset") {
    const hard = rest.some((a) => a === "--hard" || a === "--merge");
    return decision(
      hard ? "force_ask" : "ask",
      `\`git reset\`${hard ? " --hard" : ""} requires approval`,
    );
  }

  if (sub === "reflog") {
    if (rest.some((a) => a === "expire" || a === "delete")) {
      return decision("force_ask", "destructive `git reflog` requires approval");
    }
    return decision("auto_approve", "read-only `git reflog`");
  }

  if (sub === "branch") {
    const risky = rest.some(
      (a) =>
        a === "-D" ||
        a === "-d" ||
        a === "--delete" ||
        a === "-f" ||
        a === "--force" ||
        a === "-M" ||
        a === "-m" ||
        a === "--move" ||
        a === "-C" ||
        a === "-c" ||
        a === "--copy",
    );
    if (risky) return decision("force_ask", "branch deletion/move/force requires approval");
    const readFlags = new Set([
      "-a",
      "--all",
      "-r",
      "--remotes",
      "-l",
      "--list",
      "-v",
      "-vv",
      "--verbose",
      "--show-current",
      "--merged",
      "--no-merged",
      "--contains",
      "--no-contains",
      "--sort",
      "--format",
    ]);
    if (
      rest.length === 0 ||
      rest.every((a) => a.startsWith("-") && readFlags.has(a.split("=")[0]))
    ) {
      return decision("auto_approve", "read-only `git branch`");
    }
    return decision("allow");
  }

  if (sub === "tag") {
    const readOnly =
      rest.length === 0 ||
      rest.every((a) =>
        /^(-l|--list|-v|--verify|-n\d*|--sort=.*|--merged|--no-merged|--contains)$/.test(a),
      );
    if (readOnly) return decision("auto_approve", "read-only `git tag`");
    return decision("force_ask", "creating or deleting git tags requires approval");
  }

  if (sub === "config") {
    const writes = rest.some((a) =>
      /^(--unset|--unset-all|--remove-section|--rename-section|--replace-all|--add|--edit|-e)$/.test(
        a,
      ),
    );
    const reads = rest.some((a) =>
      /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope)$/.test(a),
    );
    if (!writes && reads) return decision("auto_approve", "read-only `git config`");
    return decision("force_ask", "modifying `git config` requires approval");
  }

  if (sub === "remote") {
    const first = rest[0]?.toLowerCase() ?? "";
    if (
      !first ||
      first === "-v" ||
      first === "--verbose" ||
      first === "show" ||
      first === "get-url"
    ) {
      return decision("auto_approve", "read-only `git remote`");
    }
    return decision(
      "force_ask",
      `modifying git remotes (\`git remote ${first}\`) requires approval`,
    );
  }

  if (sub === "worktree") {
    const first = rest[0]?.toLowerCase() ?? "";
    if (first === "list" || first === "add" || first === "prune") {
      return decision("auto_approve", `safe \`git worktree ${first}\``);
    }
    return decision("force_ask", `\`git worktree ${first || ""}\` requires approval`);
  }

  if (sub === "stash") {
    const first = rest[0]?.toLowerCase() ?? "";
    if (first === "drop" || first === "clear") {
      return decision("force_ask", `destructive \`git stash ${first}\` requires approval`);
    }
    return decision("auto_approve", "reversible `git stash`");
  }

  if (sub === "switch") {
    const risky = rest.some(
      (a) => a === "-f" || a === "--force" || a === "--discard-changes" || a === "-C",
    );
    if (risky)
      return decision("force_ask", "force `git switch` discards changes and requires approval");
    return decision("auto_approve", "reversible `git switch`");
  }

  if (sub === "checkout") {
    if (rest.includes("--") || rest.some((a) => a === "-f" || a === "--force" || a === "-B")) {
      return decision("force_ask", "`git checkout` can overwrite working tree or reset branch");
    }
    if (rest[0] === "-b" && rest.length >= 2) {
      return decision("auto_approve", "creating branch with `git checkout -b`");
    }
    return decision("allow");
  }

  if (sub === "commit") {
    if (rest.includes("--amend")) {
      return decision("ask", "`git commit --amend` rewrites history and requires approval");
    }
    return decision("auto_approve", "local `git commit`");
  }

  if (sub === "pull") {
    if (rest.includes("--ff-only"))
      return decision("auto_approve", "fast-forward `git pull --ff-only`");
    return decision("ask", "`git pull` without `--ff-only` requires approval");
  }

  if (sub === "merge") {
    if (rest.includes("--ff-only") || rest.includes("--abort")) {
      return decision("auto_approve", "safe `git merge`");
    }
    return decision("ask", "`git merge` requires approval");
  }

  if (SAFE_GIT_READONLY.has(sub)) {
    return decision("auto_approve", `read-only or local \`git ${sub}\``);
  }

  return decision("allow");
}

function judgeDelete(bin, args) {
  const joined = args.join(" ");
  const hasForce = args.some((a) =>
    /^-.*[rf]|^--force$|^--recursive$|^-recurse$|^-force$/i.test(a),
  );
  const targets = args.filter((a) => !a.startsWith("-"));

  if (targets.some((t) => CATASTROPHIC_TARGET.test(t.trim()) || SENSITIVE_PATH.test(t))) {
    return decision("deny", `catastrophic deletion target in \`${bin} ${joined}\` is blocked`);
  }
  if (hasForce && targets.some((t) => /^\/[^/]+$/.test(t.trim()))) {
    return decision("deny", `root-level recursive deletion in \`${bin}\` is blocked`);
  }
  return decision("force_ask", `file deletion (\`${bin}\`) requires approval`);
}

function judgeNpmLike(bin, args) {
  const sub = args[0]?.toLowerCase() ?? "";
  if (bin === "npx" || bin === "pnpx") {
    if (sub === "prettier") return decision("auto_approve", "prettier formatting/check");
    return decision("ask", `\`${bin} ${sub}\` runs an external package and requires approval`);
  }

  if (sub === "--version" || sub === "-v" || sub === "test" || sub === "t") {
    return decision("auto_approve", `safe \`${bin} ${sub}\``);
  }
  if (sub === "run" || sub === "run-script") {
    const script = args[1]?.toLowerCase() ?? "";
    if (script === "test" || script === "format" || script === "format:check") {
      return decision("auto_approve", `safe \`${bin} run ${script}\``);
    }
    return decision("allow");
  }
  if (
    [
      "publish",
      "unpublish",
      "deprecate",
      "token",
      "login",
      "logout",
      "adduser",
      "version",
    ].includes(sub)
  ) {
    return decision("force_ask", `registry/release command \`${bin} ${sub}\` requires approval`);
  }
  if (
    [
      "install",
      "i",
      "ci",
      "add",
      "remove",
      "uninstall",
      "rm",
      "update",
      "up",
      "dlx",
      "audit",
    ].includes(sub)
  ) {
    return decision("ask", `package mutation \`${bin} ${sub}\` requires approval`);
  }
  return decision("allow");
}

function judgeNode(args) {
  if (args.length === 0) return decision("allow");
  const first = args[0];
  if (first === "-v" || first === "--version" || first === "--test") {
    return decision("auto_approve", `safe \`node ${first}\``);
  }
  if (first === "-e" || first === "--eval" || first === "-p" || first === "--print") {
    return decision("allow");
  }

  const script = normalizePath(first);
  if (script.endsWith("records.mjs")) {
    const sub = args[1]?.toLowerCase() ?? "";
    if (SAFE_RECORDS_SUBCOMMANDS.has(sub)) {
      return decision("auto_approve", `safe \`records.mjs ${sub}\``);
    }
    if (FORCE_ASK_RECORDS_SUBCOMMANDS.has(sub)) {
      return decision("force_ask", `mutating/uploading \`records.mjs ${sub}\` requires approval`);
    }
    return decision("ask", `unclassified \`records.mjs ${sub}\` requires approval`);
  }
  if (SAFE_NODE_SCRIPTS.has(script)) {
    return decision("auto_approve", `safe repo script \`${script}\``);
  }
  return decision("allow");
}

function judgeUv(args) {
  const sub = args[0]?.toLowerCase() ?? "";
  if (sub === "--version" || sub === "-v" || sub === "version") {
    return decision("auto_approve", "uv version");
  }
  if (sub === "publish") {
    return decision("force_ask", "`uv publish` requires approval");
  }
  if (sub === "sync" || sub === "add" || sub === "remove" || sub === "pip") {
    return decision("ask", `dependency change \`uv ${sub}\` requires approval`);
  }
  if (sub === "run") {
    const inner = args.slice(1);
    const innerBin = normalizeBin(inner[0] ?? "");
    if (innerBin === "pytest" || innerBin === "pre-commit") {
      return decision("auto_approve", `safe \`uv run ${innerBin}\``);
    }
    if (innerBin === "ruff" && (inner[1] === "check" || inner[1] === "format")) {
      return decision("auto_approve", `safe \`uv run ruff ${inner[1]}\``);
    }
    if (innerBin === "python" || innerBin === "python3") {
      const script = normalizePath(inner[1] ?? "");
      if (SAFE_PYTHON_SCRIPTS.has(script)) {
        return decision("auto_approve", `safe repo generator/check \`${script}\``);
      }
      if (script === "scripts/release.py") {
        return decision(
          "force_ask",
          "`scripts/release.py` modifies release state and requires approval",
        );
      }
    }
  }
  return decision("allow");
}

function judgeSegment(words) {
  let idx = 0;
  const envAssignments = [];
  while (idx < words.length && ASSIGNMENT.test(words[idx])) {
    envAssignments.push(words[idx]);
    idx++;
  }
  const rest = words.slice(idx);
  if (rest.length === 0) return { result: decision("allow"), hasEnv: envAssignments.length > 0 };

  const bin = normalizeBin(rest[0]);
  const args = rest.slice(1);

  if (DENY_BINARIES.has(bin) || bin.startsWith("mkfs")) {
    return {
      result: decision("deny", `privileged or destructive command \`${bin}\` is blocked`),
      hasEnv: false,
    };
  }

  if (bin === "reg") {
    const sub = args[0]?.toLowerCase() ?? "";
    if (sub === "add" || sub === "delete" || sub === "import" || sub === "restore") {
      return {
        result: decision("deny", `Windows registry modification \`reg ${sub}\` is blocked`),
        hasEnv: false,
      };
    }
    return { result: decision("force_ask", "`reg` requires approval"), hasEnv: false };
  }

  if (bin === "start-process") {
    const verbIdx = args.findIndex((a) => a.toLowerCase() === "-verb");
    if (verbIdx >= 0 && args[verbIdx + 1]?.toLowerCase() === "runas") {
      return {
        result: decision("deny", "elevated `Start-Process -Verb RunAs` is blocked"),
        hasEnv: false,
      };
    }
    return { result: decision("force_ask", "`Start-Process` requires approval"), hasEnv: false };
  }

  if (bin === "printenv" || (bin === "env" && args.length === 0)) {
    return {
      result: decision("deny", `\`${bin}\` dumps all environment secrets and is blocked`),
      hasEnv: false,
    };
  }

  if (
    (bin === "get-childitem" || bin === "gci" || bin === "dir" || bin === "ls") &&
    hasSensitivePath(args)
  ) {
    return {
      result: decision(
        "deny",
        "listing environment variables or sensitive credential directories is blocked",
      ),
      hasEnv: false,
    };
  }

  if (FILE_READ_BINARIES.has(bin) && hasSensitivePath(args)) {
    return {
      result: decision(
        "deny",
        `reading sensitive credential/secret file via \`${bin}\` is blocked`,
      ),
      hasEnv: false,
    };
  }

  if (DELETE_BINARIES.has(bin)) {
    return { result: judgeDelete(bin, args), hasEnv: false };
  }

  if (FORCE_ASK_BINARIES.has(bin)) {
    return {
      result: decision("force_ask", `risky network/host command \`${bin}\` requires approval`),
      hasEnv: false,
    };
  }

  if (bin === "bash" || bin === "sh" || bin === "pwsh" || bin === "powershell") {
    if (args.some((a) => RELEASE_SCRIPTS.test(a))) {
      return {
        result: decision("force_ask", "release script execution requires approval"),
        hasEnv: false,
      };
    }
    return { result: decision("allow"), hasEnv: envAssignments.length > 0 };
  }

  if (RELEASE_SCRIPTS.test(rest[0])) {
    return {
      result: decision("force_ask", "release script execution requires approval"),
      hasEnv: false,
    };
  }

  if (bin === "gh") return { result: judgeGh(args), hasEnv: envAssignments.length > 0 };
  if (bin === "git") return { result: judgeGit(args), hasEnv: envAssignments.length > 0 };
  if (bin === "npm" || bin === "npx" || bin === "pnpm" || bin === "pnpx" || bin === "yarn") {
    return { result: judgeNpmLike(bin, args), hasEnv: envAssignments.length > 0 };
  }
  if (bin === "node") return { result: judgeNode(args), hasEnv: envAssignments.length > 0 };
  if (bin === "uv") return { result: judgeUv(args), hasEnv: envAssignments.length > 0 };
  if (bin === "pip" || bin === "pip3") {
    const sub = args[0]?.toLowerCase() ?? "";
    if (sub === "install" || sub === "uninstall") {
      return {
        result: decision("ask", `\`${bin} ${sub}\` modifies packages and requires approval`),
        hasEnv: false,
      };
    }
  }
  if (bin === "pytest" || bin === "shellcheck" || bin === "actionlint") {
    return {
      result: decision("auto_approve", `safe check \`${bin}\``),
      hasEnv: envAssignments.length > 0,
    };
  }
  if (bin === "ruff" && (args[0] === "check" || args[0] === "format")) {
    return {
      result: decision("auto_approve", `safe \`ruff ${args[0]}\``),
      hasEnv: envAssignments.length > 0,
    };
  }
  if (bin === "get-childitem" || bin === "gci" || bin === "dir" || bin === "ls") {
    return {
      result: decision("auto_approve", `read-only directory listing \`${bin}\``),
      hasEnv: envAssignments.length > 0,
    };
  }
  if (SAFE_PIPE_HELPERS.has(bin) && !hasSensitivePath(args)) {
    return {
      result: decision("auto_approve", `read-only helper \`${bin}\``),
      hasEnv: envAssignments.length > 0,
    };
  }

  return { result: decision("allow"), hasEnv: envAssignments.length > 0 };
}

/** Decide the Antigravity PreToolUse policy outcome for a shell command string. */
export function decideCommand(commandLine) {
  const raw = String(commandLine ?? "").trim();
  if (!raw) return decision("allow");

  if (RCE_PIPE.test(raw)) {
    return decision("deny", "piping remote download output into a shell/interpreter is blocked");
  }

  const parsed = parseCommand(raw);
  if (parsed.error) {
    return decision(
      "ask",
      `command could not be safely parsed (${parsed.error}); requires approval`,
    );
  }
  if (parsed.segments.length === 0) return decision("allow");

  let worst = null;
  let allAutoApprove = true;
  let anyEnv = false;

  for (const seg of parsed.segments) {
    const { result, hasEnv } = judgeSegment(seg);
    if (hasEnv) anyEnv = true;
    if (result.decision !== "auto_approve") allAutoApprove = false;
    if (!worst || RANK[result.decision] > RANK[worst.decision]) {
      worst = result;
    }
  }

  if (worst.decision === "deny" || worst.decision === "force_ask" || worst.decision === "ask") {
    return worst;
  }

  // Never auto-approve commands containing shell expansions, subshells, file
  // redirections, or inline environment overrides: delegate to Auto mode.
  if (parsed.hasDynamicExpansion || parsed.hasSubshell || parsed.hasRedirection || anyEnv) {
    return decision("allow");
  }

  return allAutoApprove ? worst : decision("allow");
}

/** Evaluate a full Antigravity PreToolUse stdin payload. */
export function decideToolCall(payload) {
  const toolName = payload?.toolCall?.name;
  if (toolName !== "run_command") return decision("allow");
  return decideCommand(payload?.toolCall?.args?.CommandLine ?? "");
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write(
      `${JSON.stringify(decision("ask", "command-policy hook received malformed JSON payload"))}\n`,
    );
    return;
  }

  const out = decideToolCall(payload);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  main().catch((err) => {
    process.stdout.write(
      `${JSON.stringify(decision("ask", `command-policy hook error: ${err?.message ?? err}`))}\n`,
    );
  });
}
