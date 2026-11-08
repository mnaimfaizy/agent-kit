// Every Agent-kit `uses:` pin must name the same repository and the same
// Release-line tag: the copied Kit-owned paths come from one tag.

import { isReleaseTag } from "../tags.mjs";
import { result } from "./result.mjs";

const ID = "pins";
const TITLE = "uses: pins agree";

/**
 * @param {{ path: string, pins: { repo: string, file: string, ref: string, line: number }[] }[]} files
 * @returns {{ result: object, repo: string | null, tag: string | null }}
 */
export function checkPins(files) {
  const all = files.flatMap((f) => f.pins.map((p) => ({ ...p, path: f.path })));
  if (all.length === 0) {
    return {
      result: result(
        ID,
        TITLE,
        "fail",
        "No Caller in .github/workflows/ pins an Agent-kit reusable workflow.",
        {
          details: [
            "Copy a Caller from the tag's examples/ (see docs/getting-started.md, step 5).",
          ],
        },
      ),
      repo: null,
      tag: null,
    };
  }
  const where = (p) => `${p.path}:${p.line} → ${p.repo}@${p.ref}`;
  const refs = new Set(all.map((p) => p.ref));
  // GitHub owner names are case-insensitive: MnaimFaizy/ and mnaimfaizy/ are one repository.
  const repos = new Set(all.map((p) => p.repo.toLowerCase()));
  const notTags = all.filter((p) => !isReleaseTag(p.ref));
  const details = [];
  if (repos.size > 1)
    details.push(`Pins name more than one kit repository: ${[...repos].join(", ")}.`);
  if (refs.size > 1) details.push(`Pins name more than one ref: ${[...refs].join(", ")}.`);
  if (notTags.length)
    details.push("Pin a Release-line tag (vX.Y.Z or vX.Y.Z-stage.N), not a branch or SHA.");
  if (details.length) {
    return {
      result: result(
        ID,
        TITLE,
        "fail",
        `${all.length} pins disagree or are not Release-line tags.`,
        {
          details: [...details, ...all.map(where)],
        },
      ),
      repo: null,
      tag: null,
    };
  }
  const { repo } = all[0];
  const [tag] = refs;
  return {
    result: result(
      ID,
      TITLE,
      "pass",
      `${all.length} pin${all.length === 1 ? "" : "s"} use ${repo}@${tag}.`,
    ),
    repo,
    tag,
  };
}
