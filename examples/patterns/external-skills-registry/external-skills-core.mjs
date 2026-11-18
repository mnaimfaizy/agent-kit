// Pattern guide skeleton: docs/patterns/external-skills-registry.md in Agent-kit.
//
// The external-skills check's core. Every decision lives here: what the lock
// file says is installed, what the approval list says is approved, and every
// way the two, the skills folder and the other docs can disagree. Nothing
// here reads a file; the shell (check-external-skills.mjs) does that and hands
// this module strings, so the contract suite (external-skills-core.test.mjs)
// can drive every branch.
//
// Copy it into your repository, fill in each TODO(adopt), and delete the
// Pattern guide line above.

// TODO(adopt): the heading of the one approved tier in your approval list.
export const APPROVED_HEADING = "## Approved: project scope, committed";
// A tier for skills installed on one person's machine is not an approval: no
// fresh clone and no CI run has the skill, so nothing may route to it. Any
// heading level, with or without the word "scope": "### Personal skills" is
// the same tier.
const PERSONAL_HEADING = /^#{1,6}\s+.*\b(?:personal|global|user[- ]scope)\b/im;
// An approval entry in the list: `owner/repo@skill`, in backticks.
const ENTRY = /`([\w.-]+\/[\w.-]+)@([\w.-]+)`/g;
// A restatement of one anywhere else, backticks or not: in an install command,
// plain text or link text.
const RESTATED = /(?<![\w.\/-])([\w.-]+\/[\w.-]+)@([\w.-]+)/g;

/**
 * What the lock file says is installed, as `source@skill` keys. The shape
 * below is what one installer writes (`{ skills: { <name>: { source } } }`);
 * TODO(adopt): change this function if yours writes another.
 */
export function lockedSkills(lockText) {
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch (error) {
    throw new Error(`the lock file is not valid JSON: ${error.message}`);
  }
  if (!lock || typeof lock.skills !== "object" || Array.isArray(lock.skills)) {
    throw new Error("the lock file has no skills object");
  }
  return Object.entries(lock.skills).map(([name, entry]) => {
    if (typeof entry?.source !== "string" || !entry.source) {
      throw new Error(`the lock file's ${name} entry has no source`);
    }
    return { name, source: entry.source, key: `${entry.source}@${name}` };
  });
}

/** The body of one section, up to the next heading of the same or a higher level. */
function section(text, heading) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const level = heading.match(/^#+/)[0].length;
  const rest = lines.slice(start + 1);
  // A `#` line inside a code fence is a shell comment, not a heading.
  let fenced = false;
  const end = rest.findIndex((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const hashes = !fenced && line.match(/^(#{1,6})\s/);
    return Boolean(hashes) && hashes[1].length <= level;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** What the approval list approves, as `source@skill` keys, in order. */
export function approvedSkills(listText) {
  const body = section(listText, APPROVED_HEADING);
  if (body === null) throw new Error(`the approval list has no "${APPROVED_HEADING}" section`);
  return [...body.matchAll(ENTRY)].map((match) => ({
    name: match[2],
    source: match[1],
    key: `${match[1]}@${match[2]}`,
  }));
}

/**
 * Every disagreement, as one line each. `skillDirs` is the list of folders in
 * the project-scope skills folder; `docs` maps every other doc's path to its text.
 */
export function registryProblems({ lockText, listText, skillDirs, docs = {} }) {
  const problems = [];
  const locked = lockedSkills(lockText);
  const approved = approvedSkills(listText);

  if (PERSONAL_HEADING.test(listText)) {
    problems.push(
      "the approval list has a personal-scope tier: approve a skill at project scope, committed, or not at all",
    );
  }

  const seen = new Set();
  for (const entry of approved) {
    if (seen.has(entry.key)) problems.push(`the approval list names ${entry.key} twice`);
    seen.add(entry.key);
  }

  // Both directions: the lock and the list are two records of one fact.
  const lockedKeys = new Set(locked.map((entry) => entry.key));
  const approvedKeys = new Set(approved.map((entry) => entry.key));
  for (const entry of approved) {
    if (!lockedKeys.has(entry.key)) {
      problems.push(
        `${entry.key} is approved but not in the lock file: install it, or remove the approval`,
      );
    }
  }
  for (const entry of locked) {
    if (!approvedKeys.has(entry.key)) {
      problems.push(
        `${entry.key} is in the lock file but not approved: approve it, or uninstall it`,
      );
    }
  }

  const dirs = new Set(skillDirs);
  for (const entry of locked) {
    if (!dirs.has(entry.name)) {
      problems.push(
        `${entry.key} is in the lock file but its folder is missing: reinstall it from the lock`,
      );
    }
  }

  // Every other doc links to the approval list. A copy of an entry is a
  // second list nothing keeps in step.
  const known = new Set([...lockedKeys, ...approvedKeys]);
  for (const [path, text] of Object.entries(docs).sort()) {
    text.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(RESTATED)) {
        const key = `${match[1]}@${match[2]}`;
        if (known.has(key)) {
          problems.push(`${path}:${index + 1} restates ${key}: link to the approval list instead`);
        }
      }
    });
  }
  return problems;
}
