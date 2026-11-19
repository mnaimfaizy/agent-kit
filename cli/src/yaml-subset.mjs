// A small, dependency-free reader for the YAML that workflow files and Scan
// recipes use: block mappings, block sequences, plain and quoted scalars, and
// block scalars (| and >). Mappings come back as plain objects, sequences as
// arrays (of scalars, mappings or sequences), and block scalars as strings;
// flow collections ([a, b], {a: b}) stay as their raw text. Anchors, aliases,
// merge keys and tags are not resolved.

const BOM = String.fromCharCode(0xfeff);

/** Drop a leading UTF-8 byte-order mark, which would otherwise hide the first key. */
export function stripBom(text) {
  const s = String(text);
  return s.startsWith(BOM) ? s.slice(1) : s;
}

/** True for a block mapping: a plain object, not a list, a string or null. */
export function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
  const indentOf = (l) => l.length - l.trimStart().length;
  const isBlank = (l) => stripComment(l).trim() === "";
  // A list item's marker: `-` alone or followed by a space, never `-foo:`.
  const isItem = (l) => {
    const c = stripComment(l).trim();
    return c === "-" || c.startsWith("- ");
  };

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
        if (j < lines.length && isItem(lines[j]) && indentOf(lines[j]) >= childIndent) {
          const [seq, next] = parseSequence(j, indentOf(lines[j]));
          obj[key] = seq;
          i = next;
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

  // A block sequence whose `-` markers sit at `seqIndent`.
  function parseSequence(start, seqIndent) {
    const list = [];
    let i = start;
    while (i < lines.length) {
      if (isBlank(lines[i])) {
        i++;
        continue;
      }
      const ind = indentOf(lines[i]);
      if (ind < seqIndent) break;
      const content = stripComment(lines[i].slice(ind)).trimEnd();
      if (ind > seqIndent) {
        i++;
        continue;
      }
      if (!isItem(content)) break;
      const rest = content.slice(1).trimStart();
      if (rest === "") {
        // A bare `-`: the item is the deeper block that follows, if any.
        const j = nextContent(i + 1);
        if (j < lines.length && indentOf(lines[j]) > seqIndent) {
          const nested = stripComment(lines[j]).trim();
          if (isItem(nested)) {
            const [item, next] = parseSequence(j, indentOf(lines[j]));
            list.push(item);
            i = next;
          } else if (KEY.test(nested) && !/^[[{]/.test(nested)) {
            const [item, next] = parseMapping(j, seqIndent);
            list.push(item);
            i = next;
          } else {
            const [item, next] = foldScalar(nested, j + 1, seqIndent);
            list.push(item);
            i = next;
          }
        } else {
          list.push(null);
          i++;
        }
        continue;
      }
      if (!/^[[{]/.test(rest) && KEY.test(rest)) {
        // `- key: value`: the item is a mapping whose first key sits where
        // `rest` starts. Re-indent that line so the mapping reader sees the
        // key column it shares with the item's later keys.
        lines[i] = " ".repeat(ind + content.length - rest.length) + rest;
        const [item, next] = parseMapping(i, seqIndent);
        list.push(item);
        i = next;
        continue;
      }
      i++;
      if (/^[|>][-+0-9]*$/.test(rest)) {
        const raw = [];
        while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > seqIndent)) {
          raw.push(lines[i]);
          i++;
        }
        list.push(raw.join("\n"));
      } else {
        const [item, next] = foldScalar(rest, i, seqIndent);
        list.push(item);
        i = next;
      }
    }
    return [list, i];
  }

  // A scalar item whose text starts with `first` and runs on over the
  // non-blank lines from `i` that sit deeper than the item's `-`. The lines
  // fold into one, joined by spaces.
  function foldScalar(first, i, seqIndent) {
    const parts = [first];
    while (i < lines.length && !isBlank(lines[i]) && indentOf(lines[i]) > seqIndent) {
      parts.push(stripComment(lines[i]).trim());
      i++;
    }
    return [parseScalar(parts.join(" ")), i];
  }

  return parseMapping(0, -1)[0];
}
