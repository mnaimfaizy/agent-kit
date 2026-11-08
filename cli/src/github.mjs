// Read-only GitHub API calls through the adopter's own `gh` login. The CLI
// never changes GitHub settings: it only reads, and prints `gh` commands for
// the adopter to run.

import { REPO_PATTERN as REPO } from "./checks/result.mjs";
import { firstLine } from "./exec.mjs";

const HOST = /^[A-Za-z0-9.-]+(?::\d+)?$/;

export class GhError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.httpStatus = status ?? null;
  }
}

function fail(r, what) {
  const text = `${r.stderr}\n${r.stdout}`;
  const m = /HTTP (\d{3})/.exec(text);
  return new GhError(`${what}: ${firstLine(r.stderr) || firstLine(r.stdout) || "gh failed"}`, {
    status: m ? Number(m[1]) : null,
  });
}

export function checkRepoName(repo) {
  if (!REPO.test(repo)) throw new GhError(`not a GitHub repository name: ${JSON.stringify(repo)}`);
  return repo;
}

/**
 * @param {import("./exec.mjs").Runner} runner
 * @param {{ cwd?: string, hostname?: string | null }} [opts] hostname: a GitHub
 *   Enterprise Server host; gh api then targets it with --hostname.
 */
export function createGitHub(runner, { cwd, hostname = null } = {}) {
  if (hostname !== null && !HOST.test(hostname)) {
    throw new GhError(`not a host name: ${JSON.stringify(hostname)}`);
  }
  const gh = (args) => runner("gh", args, { cwd });
  const host = hostname && hostname !== "github.com" ? ["--hostname", hostname] : [];

  /** GET an endpoint and parse its JSON. */
  function getJson(endpoint) {
    const r = gh(["api", ...host, "--method", "GET", endpoint]);
    if (r.status !== 0) throw fail(r, `gh api ${endpoint}`);
    return JSON.parse(r.stdout);
  }

  /** GET every page of an endpoint and return one line per `jq` result. */
  function getLines(endpoint, jq) {
    const r = gh(["api", ...host, "--method", "GET", "--paginate", endpoint, "--jq", jq]);
    if (r.status !== 0) throw fail(r, `gh api ${endpoint}`);
    return r.stdout.split(/\r?\n/).filter(Boolean);
  }

  /** The repository doctor checks, and whether this login is an admin on it. */
  function repoInfo(repo) {
    const args = [
      "repo",
      "view",
      "--json",
      "nameWithOwner,isInOrganization,viewerPermission,defaultBranchRef,url",
    ];
    if (repo) args.splice(2, 0, checkRepoName(repo));
    const r = gh(args);
    if (r.status !== 0) throw fail(r, "gh repo view");
    const data = JSON.parse(r.stdout);
    // The host the repository lives on: github.com, or a GitHub Enterprise Server.
    let hostName = "github.com";
    try {
      if (data.url) hostName = new URL(data.url).host.toLowerCase();
    } catch {
      hostName = "github.com";
    }
    if (!HOST.test(hostName))
      throw new GhError(`unexpected repository URL ${JSON.stringify(data.url)}`);
    return {
      host: hostName,
      repo: checkRepoName(data.nameWithOwner),
      owner: data.nameWithOwner.split("/")[0],
      ownerType: data.isInOrganization ? "Organization" : "User",
      admin: data.viewerPermission === "ADMIN",
      defaultBranch: data.defaultBranchRef?.name ?? "main",
    };
  }

  return { getJson, getLines, repoInfo };
}
