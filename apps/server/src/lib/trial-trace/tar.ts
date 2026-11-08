// A minimal, pure reader for the trial bundle (out.tar.gz): gunzip with an output cap, then the
// ustar headers (plus PAX `path` and GNU long names, which `tar` writes for long paths). Regular
// files only; links, devices and directories are skipped. The bundle came from the eval computer,
// so every size is checked against what is really there and nothing is written to disk.
import { gunzipSync } from "node:zlib";

export interface TarEntry {
  /** Path inside the bundle, without a leading `./`. */
  name: string;
  size: number;
  /** The bytes, or null when `want` declined the file (only its name and size are kept). */
  data: Uint8Array | null;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

const BLOCK = 512;
const decoder = new TextDecoder("utf-8");

function field(buf: Uint8Array, start: number, len: number): string {
  let end = start;
  while (end < start + len && buf[end] !== 0) end++;
  return decoder.decode(buf.subarray(start, end));
}

function octal(buf: Uint8Array, start: number, len: number): number {
  // GNU base-256 for sizes over 8 GiB: never valid for a trial bundle.
  if ((buf[start]! & 0x80) !== 0) throw new TarError("base-256 size field");
  const s = field(buf, start, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError(`bad octal field "${s.slice(0, 20)}"`);
  return parseInt(s, 8);
}

function cleanName(name: string): string {
  let n = name.replace(/\\/g, "/");
  while (n.startsWith("./")) n = n.slice(2);
  return n.replace(/^\/+/, "");
}

/** PAX extended header records: `<len> <key>=<value>\n`. */
function paxPath(data: Uint8Array): string | null {
  const text = decoder.decode(data);
  let i = 0;
  let path: string | null = null;
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp < 0) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0 && rec.slice(0, eq) === "path") path = rec.slice(eq + 1);
    i += len;
  }
  return path;
}

export interface ReadTarOptions {
  /** Cap on the gunzipped size (default 256 MiB). */
  maxBytes?: number;
  /** Keep this file's bytes? (default: every file). */
  want?: (name: string, size: number) => boolean;
}

/** Read a .tar.gz (or a plain .tar) into entries. Throws TarError on a malformed archive. */
export function readTarGz(input: Uint8Array, options: ReadTarOptions = {}): TarEntry[] {
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  let tar: Uint8Array;
  if (input[0] === 0x1f && input[1] === 0x8b) {
    try {
      tar = gunzipSync(input, { maxOutputLength: maxBytes });
    } catch (err) {
      throw new TarError(`gunzip failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    tar = input;
  }
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break; // end-of-archive marker
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const magic = field(h, 257, 6);
    const prefix = magic.startsWith("ustar") ? field(h, 345, 155) : "";
    const base = field(h, 0, 100);
    const start = off + BLOCK;
    const end = start + size;
    if (end > tar.length) throw new TarError("entry runs past the end of the archive");
    const data = tar.subarray(start, end);
    off = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === "g") continue;
    const name = cleanName(longName ?? (prefix ? `${prefix}/${base}` : base));
    longName = null;
    if (type !== "0" && type !== "\0" && type !== "7") continue; // regular files only
    if (!name || name.split("/").includes("..")) continue;
    const keep = options.want ? options.want(name, size) : true;
    out.push({ name, size, data: keep ? data : null });
  }
  return out;
}
