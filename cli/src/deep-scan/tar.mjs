// The tar streams the Deep scan launcher moves across the sandbox boundary,
// in Node core (ADR 0001). In: a ustar archive of files the launcher wrote
// itself (the grounding it fetched). Out: the one report file, read from the
// archive `docker cp <container>:<file> -` writes, refusing anything that is
// not exactly one regular file.

const BLOCK = 512;

/**
 * A ustar archive of `entries`, each a folder (`dir: true`) or a file with
 * its bytes. Paths are relative, use `/`, and fit in 100 bytes.
 * @param {Array<{ path: string, dir?: boolean, data?: Buffer }>} entries
 * @returns {Buffer}
 */
export function tarOf(entries) {
  const parts = [];
  for (const entry of entries) {
    const name = entry.dir ? `${entry.path.replace(/\/$/, "")}/` : entry.path;
    if (Buffer.byteLength(name) > 100 || name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`tar entry name not allowed: ${JSON.stringify(name)}`);
    }
    const data = entry.dir ? Buffer.alloc(0) : (entry.data ?? Buffer.alloc(0));
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 100, "utf8");
    header.write(octal(entry.dir ? 0o755 : 0o644, 8), 100, "ascii");
    header.write(octal(0, 8), 108, "ascii");
    header.write(octal(0, 8), 116, "ascii");
    header.write(octal(data.length, 12), 124, "ascii");
    header.write(octal(0, 12), 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write(entry.dir ? "5" : "0", 156, "ascii");
    header.write("ustar\u000000", 257, "binary");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, "binary");
    parts.push(header, data, Buffer.alloc(padding(data.length)));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/**
 * The one regular file in a tar archive, or why there is not exactly one.
 * PAX extended headers are skipped; a folder, a link or a second file is
 * refused, as is a file larger than `maxBytes`.
 * @param {Buffer} archive
 * @param {{ maxBytes: number }} opts
 * @returns {{ name: string, data: Buffer } | { error: string }}
 */
export function singleFileOf(archive, { maxBytes }) {
  const files = [];
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    const name = text(header, 0, 100);
    const size = parseInt(text(header, 124, 12).trim() || "0", 8);
    const type = text(header, 156, 1) || "0";
    if (!Number.isFinite(size) || size < 0) return { error: "the archive is not a tar archive" };
    offset += BLOCK;
    if (type === "x" || type === "g") {
      offset += size + padding(size);
      continue;
    }
    if (type !== "0") {
      return { error: `${name || "the entry"} is not a regular file (tar type ${type})` };
    }
    if (size > maxBytes) return { error: `it is larger than ${maxBytes / 1024 / 1024} MiB` };
    if (offset + size > archive.length) return { error: "the archive is cut short" };
    files.push({ name, data: Buffer.from(archive.subarray(offset, offset + size)) });
    offset += size + padding(size);
  }
  if (files.length === 0) return { error: "the archive holds no file" };
  if (files.length > 1) return { error: `the archive holds ${files.length} files, not one` };
  return files[0];
}

const octal = (n, width) => `${n.toString(8).padStart(width - 1, "0")}\u0000`;
const padding = (size) => (BLOCK - (size % BLOCK)) % BLOCK;
const text = (buf, start, length) => {
  const field = buf.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
};
