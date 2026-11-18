// Pattern guide skeleton: docs/patterns/sub-agent-sync.md in Agent-kit.
//
// The sub-agent generator's core. Every decision lives here: how a canonical
// agent file is read, what each harness's copy of it looks like, which copies
// are missing, stale or extra, and which pinned model names a catalog no
// longer lists. Nothing here reads or writes a file or the network; the shells
// (sync-agents.mjs, audit-models.mjs) do that and hand this module strings, so
// the contract suite (sync-agents-core.test.mjs) can drive every branch.
//
// Copy it into your repository, fill in each TODO(adopt), and delete the
// Pattern guide line above.

// TODO(adopt): the one folder that holds the canonical agent bodies. A harness
// that reads this folder itself is not a target below; it uses the file as is.
export const CANONICAL_DIR = "<canonical agents folder>";
export const CANONICAL_SUFFIX = ".agent.md";

// TODO(adopt): the capability roles a canonical body may declare in `tools:`.
// A role is a word for what the agent may do, not a harness's tool name.
export const ROLES = ["read", "search", "edit", "execute", "web"];

// TODO(adopt): one entry per harness that gets a generated copy. `tools` maps
// each role to that harness's tool names; a harness without per-agent tool
// lists gets `readonly` instead. Check each harness's own docs for its
// frontmatter keys and tool names before you trust these.
export const HARNESSES = {
  claude: {
    dir: ".claude/agents",
    fileName: (slug) => `${slug}.md`,
    tools: {
      read: ["Read"],
      search: ["Glob", "Grep"],
      edit: ["Edit", "Write"],
      execute: ["Bash"],
      web: ["WebFetch", "WebSearch"],
    },
  },
  cursor: {
    dir: ".cursor/agents",
    fileName: (slug) => `${slug}.md`,
    // No per-agent tool list: an agent is read-only unless it may edit or execute.
    readonly: (roles) => !roles.includes("edit") && !roles.includes("execute"),
  },
  // TODO(adopt): add or remove harnesses, for example a Gemini or Copilot copy.
};

const GENERATED_NOTE =
  "<!-- Generated from the canonical agent body. Edit that file and run the generator; edits here are overwritten. -->";

/** Splits `---` frontmatter from the body. Line endings are normalised first. */
export function splitFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: null, body: normalized };
  const close = normalized.indexOf("\n---\n", 3);
  if (close === -1) return { frontmatter: null, body: normalized };
  return {
    frontmatter: normalized.slice(4, close),
    body: normalized.slice(close + 5),
  };
}

function scalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  if (!match) return null;
  const value = match[1].trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return JSON.parse(value);
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/**
 * Reads one canonical agent file. A missing name or description, a `tools:`
 * line that is not a flat list, or an unknown role is an error, not a default:
 * a guessed grant is a grant nobody reviewed.
 */
export function parseCanonical(slug, text) {
  const { frontmatter, body } = splitFrontmatter(text);
  if (frontmatter === null) throw new Error(`${slug}: canonical file has no --- frontmatter`);
  const name = scalar(frontmatter, "name");
  const description = scalar(frontmatter, "description");
  if (!name) throw new Error(`${slug}: canonical frontmatter has no name`);
  if (!description) throw new Error(`${slug}: canonical frontmatter has no description`);
  const tools = scalar(frontmatter, "tools");
  if (tools === null) throw new Error(`${slug}: canonical frontmatter has no tools: [roles] line`);
  const list = tools.match(/^\[(.*)\]$/);
  if (!list) throw new Error(`${slug}: tools must be a one-line list such as [read, search]`);
  const roles = list[1]
    .split(",")
    .map((role) => role.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  for (const role of roles) {
    if (!ROLES.includes(role))
      throw new Error(`${slug}: unknown tool role ${JSON.stringify(role)}`);
  }
  return { slug, name, description: description.replace(/\s+/g, " ").trim(), roles, body };
}

const OPEN = /^<!-- harness:([a-z0-9,\s-]+) -->$/;
const CLOSE = /^<!-- \/harness -->$/;

/**
 * Keeps the parts of a canonical body meant for one harness. Unmarked lines go
 * to every harness. A marker block goes only to the harnesses it names:
 *
 *   <!-- harness:claude,cursor -->
 *   ...
 *   <!-- /harness -->
 *
 * An unknown harness name, a nested block or an unclosed one is an error: a
 * marker that silently fails to apply sends an instruction to the wrong agent.
 */
export function renderSections(body, harness, known, where = "body") {
  const out = [];
  let open = null;
  body.split("\n").forEach((line, index) => {
    const at = `${where}:${index + 1}`;
    const opening = line.trim().match(OPEN);
    if (opening) {
      if (open) throw new Error(`${at}: harness block opened inside another`);
      const names = opening[1].split(",").map((name) => name.trim());
      for (const name of names) {
        if (!known.includes(name))
          throw new Error(`${at}: unknown harness ${JSON.stringify(name)}`);
      }
      open = names;
      return;
    }
    if (CLOSE.test(line.trim())) {
      if (!open) throw new Error(`${at}: harness block closed but never opened`);
      open = null;
      return;
    }
    if (!open || open.includes(harness)) out.push(line);
  });
  if (open) throw new Error(`${where}: harness block never closed`);
  return out.join("\n");
}

/** Trailing spaces off each line, runs of blank lines folded, one final newline. */
export function normalizeBody(body) {
  return `${body
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/**
 * The model pinned for one agent in one harness, from the model policy. A
 * missing pin is an error: a copy without one runs on whatever the harness
 * defaults to that day.
 */
export function pinnedModel(models, slug, harness) {
  const model = models?.agents?.[slug]?.[harness];
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(`${slug}: no ${harness} model pinned in the model policy`);
  }
  return model.trim();
}

/** The whole generated file for one agent in one harness. */
export function renderTarget(agent, harness, models, harnesses = HARNESSES) {
  const config = harnesses[harness];
  if (!config) throw new Error(`unknown harness ${JSON.stringify(harness)}`);
  const lines = [
    "---",
    `name: ${JSON.stringify(agent.name)}`,
    // Quoted, so a colon in the description cannot make the frontmatter invalid YAML.
    `description: ${JSON.stringify(agent.description)}`,
    `model: ${JSON.stringify(pinnedModel(models, agent.slug, harness))}`,
  ];
  if (config.tools) {
    const names = agent.roles.flatMap((role) => config.tools[role] ?? []);
    lines.push(`tools: ${[...new Set(names)].join(", ")}`);
  } else if (config.readonly) {
    lines.push(`readonly: ${config.readonly(agent.roles)}`);
  }
  lines.push("---", "");
  const where = `${CANONICAL_DIR}/${agent.slug}${CANONICAL_SUFFIX}`;
  const body = renderSections(agent.body, harness, Object.keys(harnesses), where);
  return `${lines.join("\n")}\n${GENERATED_NOTE}\n\n${normalizeBody(body)}`;
}

/**
 * Every pin in the policy must name a canonical agent and a known harness, and
 * every canonical agent must have a pin for every harness. A pin left behind
 * for a deleted agent is how a policy stops describing the agents.
 */
export function policyProblems(agents, models, harnesses = HARNESSES) {
  const slugs = new Set(agents.map((agent) => agent.slug));
  const problems = [];
  for (const [slug, pins] of Object.entries(models?.agents ?? {})) {
    if (!slugs.has(slug)) problems.push(`model policy pins ${slug}, which has no canonical file`);
    for (const harness of Object.keys(pins ?? {})) {
      if (!harnesses[harness])
        problems.push(`model policy pins ${slug} for unknown harness ${harness}`);
    }
  }
  for (const agent of agents) {
    for (const harness of Object.keys(harnesses)) {
      try {
        pinnedModel(models, agent.slug, harness);
      } catch (error) {
        problems.push(error.message);
      }
    }
  }
  return problems;
}

/**
 * The plan for every harness. `existing` maps a harness to the files already
 * in its folder ({ fileName: content }). Each action is create, update,
 * unchanged or extra; the shell writes creates and updates on --apply, deletes
 * extras unless told to keep them, and fails on --check if any action is not
 * unchanged.
 */
export function planSync(agents, models, existing, harnesses = HARNESSES) {
  const problems = policyProblems(agents, models, harnesses);
  if (problems.length) throw new Error(problems.join("\n"));
  const actions = [];
  for (const [harness, config] of Object.entries(harnesses)) {
    const files = existing[harness] ?? {};
    const wanted = new Set();
    for (const agent of agents) {
      const fileName = config.fileName(agent.slug);
      wanted.add(fileName);
      const content = renderTarget(agent, harness, models, harnesses);
      const current = files[fileName];
      const action =
        current === undefined
          ? "create"
          : current.replace(/\r\n/g, "\n") === content
            ? "unchanged"
            : "update";
      actions.push({ harness, path: `${config.dir}/${fileName}`, action, content });
    }
    for (const fileName of Object.keys(files).sort()) {
      if (!wanted.has(fileName))
        actions.push({ harness, path: `${config.dir}/${fileName}`, action: "extra" });
    }
  }
  return actions;
}

/**
 * The periodic audit: is every pinned model name still listed by the harness
 * that runs it? `catalogs` maps a harness to the text of its model list, or to
 * null when the list could not be read. An unread catalog is NOT RUN, never a
 * pass: nothing was checked.
 */
export function auditPins(models, catalogs) {
  const missing = [];
  const notRun = [];
  const pins = new Map();
  for (const [slug, harnessPins] of Object.entries(models?.agents ?? {})) {
    for (const [harness, model] of Object.entries(harnessPins ?? {})) {
      if (!pins.has(harness)) pins.set(harness, new Map());
      const byModel = pins.get(harness);
      byModel.set(model, [...(byModel.get(model) ?? []), slug]);
    }
  }
  for (const [harness, byModel] of [...pins].sort()) {
    if (!(harness in catalogs)) {
      notRun.push(`${harness}: no catalog source configured`);
      continue;
    }
    const text = catalogs[harness];
    if (typeof text !== "string") {
      notRun.push(`${harness}: the catalog could not be read`);
      continue;
    }
    const haystack = text.toLowerCase();
    for (const [model, slugs] of [...byModel].sort()) {
      if (!haystack.includes(model.toLowerCase())) {
        missing.push(
          `${harness}: ${JSON.stringify(model)} (pinned for ${slugs.join(", ")}) is not in the catalog`,
        );
      }
    }
  }
  return { missing, notRun };
}
