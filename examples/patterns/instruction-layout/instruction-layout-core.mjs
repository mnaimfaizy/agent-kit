// Pattern guide skeleton: docs/patterns/instruction-layout.md in Agent-kit.
//
// The instruction-layout check's core. Every decision lives here: whether each
// harness adapter imports the shared file and adds only its own notes, whether
// the shared file's skill lines are choosers and name skills that exist,
// whether each reference document has a trigger and a file behind it, and
// whether each harness's skill folder is a link to the one tree. Nothing here
// reads a file; the shell (check-instruction-layout.mjs) does that and hands
// this module strings and facts, so the contract suite
// (instruction-layout-core.test.mjs) can drive every branch.
//
// Copy it into your repository, fill in each TODO(adopt), and delete the
// Pattern guide line above.

// TODO(adopt): the headings of the two sections the check reads in your
// shared file.
export const SKILLS_HEADING = "## Skills";
export const REFERENCES_HEADING = "## Reference documents";
// A sentence this long, found word for word in two files, is a copy. Shorter
// ones ("Run the tests.") repeat by accident.
export const MIN_WORDS = 8;
// A trigger shorter than this says nothing about when to open the document.
const MIN_TRIGGER_WORDS = 3;

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
// A skill named by its path, `<tree>/<name>/SKILL.md`. A name may be a
// placeholder, so `<` and `>` are allowed in it.
const SKILL_PATH = /([\w.<>-]+)\/SKILL\.md\b/g;
const LEADING_LINK = /^\[([^\]]+)\]\(([^)\s]+)\)\s*(.*)$/;

/** The text, with a leading frontmatter block removed and line ends unified. */
function body(text) {
  const unified = text.replace(/\r\n/g, "\n");
  const match = unified.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
  return match ? unified.slice(match[0].length) : unified;
}

/** Each line outside a code fence and an HTML comment, as { index, line }. */
function proseLines(text) {
  const found = [];
  let fenced = false;
  let comment = false;
  body(text)
    .split("\n")
    .forEach((line, index) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      let rest = line;
      if (comment) {
        const end = rest.indexOf("-->");
        if (end === -1) return;
        rest = rest.slice(end + 3);
        comment = false;
      }
      rest = rest.replace(/<!--[\s\S]*?-->/g, "");
      const open = rest.indexOf("<!--");
      if (open !== -1) {
        rest = rest.slice(0, open);
        comment = true;
      }
      found.push({ index, line: rest });
    });
  return found;
}

/**
 * The lines of one section: from its heading to the next heading at the same
 * level or higher. Null when the text has no such heading.
 */
function section(text, heading) {
  const want = heading.match(HEADING);
  if (!want) throw new Error(`${heading} is not a Markdown heading`);
  const level = want[1].length;
  const lines = proseLines(text);
  const start = lines.findIndex(({ line }) => {
    const match = line.match(HEADING);
    return match && match[1].length === level && match[2] === want[2];
  });
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(({ line }) => {
    const match = line.match(HEADING);
    return match && match[1].length <= level;
  });
  return end === -1 ? rest : rest.slice(0, end);
}

/** A section's list items, each joined with its wrapped lines. */
// An indented line belongs to the item above it, after a blank line too (a
// loose list item's second paragraph). An unindented line that is not an item
// ends the list, so a paragraph after it is not read into the last item.
function items(lines) {
  const found = [];
  let open = false;
  for (const { line } of lines) {
    if (!line.trim()) continue;
    if (ITEM.test(line) && !/^\s{2,}/.test(line)) {
      found.push(line.replace(ITEM, "").trim());
      open = true;
    } else if (open && /^\s/.test(line)) {
      found[found.length - 1] += ` ${line.trim()}`;
    } else {
      open = false;
    }
  }
  return found;
}

/** Text as a reader sees it: link text kept, URLs, code marks and emphasis gone. */
function plain(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1");
}

/**
 * Every sentence of at least MIN_WORDS words, lowercased with its spacing and
 * final punctuation removed. A list item or a heading ends a sentence, so the
 * last sentence of an item is not run into the next item.
 */
export function sentences(text) {
  const blocks = [];
  let current = [];
  const flush = () => {
    if (current.length) blocks.push(current.join(" "));
    current = [];
  };
  for (const { line } of proseLines(text)) {
    if (!line.trim() || HEADING.test(line)) {
      flush();
      continue;
    }
    if (ITEM.test(line)) flush();
    current.push(
      line
        .replace(ITEM, "")
        .replace(/^\s*>\s?/, "")
        .trim(),
    );
  }
  flush();
  const found = new Set();
  for (const block of blocks) {
    for (const piece of plain(block).split(/(?<=[.!?])\s+/)) {
      const sentence = piece
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[\s.!?:;,]+$/, "")
        .trim();
      if (sentence.split(" ").filter(Boolean).length >= MIN_WORDS) found.add(sentence);
    }
  }
  return found;
}

function shared(a, b) {
  const other = sentences(b);
  return [...sentences(a)].filter((sentence) => other.has(sentence));
}

/** The skill names a chooser line routes to, in the order written. */
export function chosenSkills(item) {
  return [...item.matchAll(SKILL_PATH)].map((match) => match[1]);
}

function adapterProblems(sharedFile, adapter) {
  const problems = [];
  const imports = proseLines(adapter.text).some(({ line }) => line.trim() === adapter.importLine);
  if (!imports)
    problems.push(
      `${adapter.path} does not import ${sharedFile.path} with the line '${adapter.importLine}'`,
    );
  for (const sentence of shared(adapter.text, sharedFile.text)) {
    problems.push(`${adapter.path} restates ${sharedFile.path}: "${sentence}"`);
  }
  return problems;
}

function chooserProblems(sharedFile, skills) {
  const lines = section(sharedFile.text, SKILLS_HEADING);
  if (!lines) return [`${sharedFile.path} has no '${SKILLS_HEADING}' section`];
  const problems = [];
  if (lines.some(({ line }) => NUMBERED.test(line))) {
    problems.push(
      `${sharedFile.path} '${SKILLS_HEADING}' holds numbered steps; a skill's steps belong in the skill`,
    );
  }
  if (lines.some(({ line }) => ITEM.test(line) && /^\s{2,}/.test(line))) {
    problems.push(
      `${sharedFile.path} '${SKILLS_HEADING}' holds a nested list; a chooser is one line`,
    );
  }
  for (const item of items(lines)) {
    const names = chosenSkills(item);
    if (!names.length)
      problems.push(`${sharedFile.path} chooser names no <tree>/<skill>/SKILL.md: "${item}"`);
    for (const name of names) {
      if (!Object.hasOwn(skills, name))
        problems.push(`${sharedFile.path} chooses skill '${name}', which is not in the skill tree`);
    }
  }
  for (const [name, text] of Object.entries(skills)) {
    for (const sentence of shared(sharedFile.text, text)) {
      problems.push(`${sharedFile.path} restates skill '${name}': "${sentence}"`);
    }
  }
  return problems;
}

function referenceProblems(sharedFile, exists) {
  const lines = section(sharedFile.text, REFERENCES_HEADING);
  if (!lines) return [];
  const problems = [];
  for (const item of items(lines)) {
    const match = item.match(LEADING_LINK);
    if (!match) {
      problems.push(`${sharedFile.path} reference does not start with a link: "${item}"`);
      continue;
    }
    const [, title, target, rest] = match;
    const trigger = rest.replace(/^[\s:—–-]+/, "");
    if (trigger.split(/\s+/).filter(Boolean).length < MIN_TRIGGER_WORDS) {
      problems.push(
        `${sharedFile.path} reference '${title}' has no trigger saying when to open it`,
      );
    }
    const file = target.split("#")[0];
    if (file && !/^[a-z]+:/i.test(file) && !exists(file)) {
      problems.push(
        `${sharedFile.path} reference '${title}' points at ${file}, which does not exist`,
      );
    }
  }
  return problems;
}

/**
 * One harness's skill folder. `kind` is what the shell found at its path:
 * "link", "directory", "file" or "missing". `resolves` is the real path a link
 * leads to, or null; `tree` is the real path of the one skill tree.
 */
function linkProblems(link, tree) {
  if (link.kind === "missing") return [`${link.path} is missing; link it to the skill tree`];
  if (link.kind === "directory") {
    return [`${link.path} is a folder, not a link: a second skill tree that nothing keeps in step`];
  }
  if (link.kind === "file") {
    return [
      `${link.path} is a file, not a link; a checkout without symlink support writes the link as a text file`,
    ];
  }
  if (link.resolves === null) return [`${link.path} is a link that leads nowhere`];
  if (link.resolves !== tree)
    return [`${link.path} leads to ${link.resolves}, not the skill tree ${tree}`];
  return [];
}

/**
 * Every way the layout disagrees with itself.
 *
 * sharedFile: { path, text }: the one always-on file.
 * adapters:   [{ path, text, importLine }]: one per harness.
 * skills:     { <name>: <SKILL.md text> }: the skill tree.
 * links:      [{ path, kind, resolves }]: each harness's skill folder.
 * tree:       the real path of the skill tree.
 * exists:     (path) => boolean, for a reference document's file.
 */
export function layoutProblems({ sharedFile, adapters, skills, links, tree, exists }) {
  return [
    ...adapters.flatMap((adapter) => adapterProblems(sharedFile, adapter)),
    ...chooserProblems(sharedFile, skills),
    ...referenceProblems(sharedFile, exists),
    ...links.flatMap((link) => linkProblems(link, tree)),
  ];
}
