// A small, dependency-free reader for the YAML that workflow files use: block
// mappings, plain and quoted scalars, block scalars (| and >), and sequences.
// It returns nested plain objects. Sequences come back as { $seq: rawLines }
// and block scalars as strings; flow collections ([a, b], {a: b}) stay as
// their raw text. That is enough to read a Caller's jobs and a reusable
// workflow's `on.workflow_call.secrets`, which is all the CLI needs.

/** Remove a trailing `# comment` that sits outside quotes. */
export function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

export function parseScalar(raw) {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

const KEY = /^("[^"]*"|'[^']*'|[^\s"'#:-][^:]*?|-[^\s:][^:]*?):(?:\s+(.*))?$/;

export function parseYamlSubset(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const indentOf = (l) => l.length - l.trimStart().length;
  const isBlank = (l) => stripComment(l).trim() === "";

  function nextContent(i) {
    while (i < lines.length && isBlank(lines[i])) i++;
    return i;
  }

  function parseMapping(start, parentIndent) {
    const obj = {};
    let i = start;
    let childIndent = null;
    while (i < lines.length) {
      if (isBlank(lines[i])) {
        i++;
        continue;
      }
      const ind = indentOf(lines[i]);
      if (ind <= parentIndent) break;
      if (childIndent === null) childIndent = ind;
      if (ind < childIndent) break;
      const content = stripComment(lines[i].slice(ind)).trimEnd();
      if (ind > childIndent || content.startsWith("- ") || content === "-") {
        i++;
        continue;
      }
      const m = KEY.exec(content);
      i++;
      if (!m) continue;
      const key = parseScalar(m[1]);
      const value = (m[2] ?? "").trim();
      if (value === "") {
        const j = nextContent(i);
        if (
          j < lines.length &&
          stripComment(lines[j]).trimStart().startsWith("-") &&
          indentOf(lines[j]) >= childIndent
        ) {
          const raw = [];
          while (i < lines.length) {
            const l = lines[i];
            if (!isBlank(l)) {
              const li = indentOf(l);
              const starts = l.trimStart().startsWith("-");
              if (li < childIndent || (li === childIndent && !starts)) break;
            }
            raw.push(l);
            i++;
          }
          obj[key] = { $seq: raw };
        } else if (j < lines.length && indentOf(lines[j]) > childIndent) {
          const [sub, next] = parseMapping(j, childIndent);
          obj[key] = sub;
          i = next;
        } else {
          obj[key] = null;
        }
      } else if (/^[|>][-+0-9]*$/.test(value)) {
        const raw = [];
        while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > childIndent)) {
          raw.push(lines[i]);
          i++;
        }
        obj[key] = raw.join("\n");
      } else {
        obj[key] = parseScalar(value);
      }
    }
    return [obj, i];
  }

  return parseMapping(0, -1)[0];
}
