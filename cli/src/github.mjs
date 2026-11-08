// Read-only GitHub API calls through the adopter's own `gh` login. The CLI
// never changes GitHub settings: it only reads, and prints `gh` commands for
// the adopter to run.

import { firstLine } from "./exec.mjs";

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

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

export function createGitHub(runner, { cwd } = {}) {
  const gh = (args) => runner("gh", args, { cwd });

  /** GET an endpoint and parse its JSON. */
  function getJson(endpoint) {
    const r = gh(["api", "--method", "GET", endpoint]);
    if (r.status !== 0) throw fail(r, `gh api ${endpoint}`);
    return JSON.parse(r.stdout);
  }

  /** GET every page of an endpoint and return one line per `jq` result. */
  function getLines(endpoint, jq) {
    const r = gh(["api", "--method", "GET", "--paginate", endpoint, "--jq", jq]);
    if (r.status !== 0) throw fail(r, `gh api ${endpoint}`);
    return r.stdout.split(/\r?\n/).filter(Boolean);
  }

  /** The repository doctor checks, and whether this login is an admin on it. */
  function repoInfo(repo) {
    const args = [
      "repo",
      "view",
      "--json",
      "nameWithOwner,isInOrganization,viewerPermission,defaultBranchRef",
    ];
    if (repo) args.splice(2, 0, checkRepoName(repo));
    const r = gh(args);
    if (r.status !== 0) throw fail(r, "gh repo view");
    const data = JSON.parse(r.stdout);
    return {
      repo: checkRepoName(data.nameWithOwner),
      owner: data.nameWithOwner.split("/")[0],
      ownerType: data.isInOrganization ? "Organization" : "User",
      admin: data.viewerPermission === "ADMIN",
      defaultBranch: data.defaultBranchRef?.name ?? "main",
    };
  }

  return { getJson, getLines, repoInfo };
}
