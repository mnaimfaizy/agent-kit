// The Claude GitHub App must be installed on the repository. GitHub only shows
// app installations to an organization admin (`orgs/<org>/installations`) or
// to a GitHub App user token; a `gh` login on a personal account cannot see
// them, so there the check is skipped rather than guessed.

import { result } from "./result.mjs";

const ID = "claude-app";
const TITLE = "Claude GitHub App installed";
const APP_SLUG = "claude";
const APP_URL = "https://github.com/apps/claude";

export function checkClaudeApp({ github, repo, owner, ownerType }) {
  if (ownerType !== "Organization") {
    return result(
      ID,
      TITLE,
      "skip",
      "GitHub does not show a personal account's app installations to a gh login.",
      {
        details: [
          `Check https://github.com/settings/installations, or install it from ${APP_URL}.`,
        ],
      },
    );
  }
  let rows;
  try {
    rows = github.getLines(
      `orgs/${owner}/installations`,
      '.installations[] | [.app_slug, .repository_selection] | join(" ")',
    );
  } catch (err) {
    return result(ID, TITLE, "skip", `Could not list ${owner}'s app installations: ${err.message}`);
  }
  const app = rows.map((r) => r.split(" ")).find(([slug]) => slug === APP_SLUG);
  if (!app) {
    return result(ID, TITLE, "fail", `The Claude GitHub App is not installed on ${owner}.`, {
      details: [`Install it on ${repo} from ${APP_URL}.`],
    });
  }
  if (app[1] === "all")
    return result(ID, TITLE, "pass", `Installed on all of ${owner}'s repositories.`);
  return result(
    ID,
    TITLE,
    "skip",
    `Installed on selected ${owner} repositories; gh cannot see which.`,
    {
      details: [
        `Check that ${repo} is selected: https://github.com/organizations/${owner}/settings/installations`,
      ],
    },
  );
}
