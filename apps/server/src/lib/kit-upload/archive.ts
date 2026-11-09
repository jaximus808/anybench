// TDM-217 [19.1]: a strict, pure reader for an uploaded kit tarball (.tar.gz).
//
// The tarball comes from a stranger, so this reader REFUSES (throws KitArchiveError) rather than
// skipping anything it does not like:
//   - not gzip, a bad header checksum, a truncated entry, base-256 sizes          → malformed (400)
//   - symlinks (2), hardlinks (1), GNU long link names (K), pax `linkpath`        → link (400)
//   - devices, FIFOs, sparse/multi-volume and every other entry type              → special_file (400)
//   - absolute paths, `..` or `.` segments, empty segments, backslashes, drive
//     letters, control characters, over-long paths or segments, too deep          → unsafe_path (400)
//   - the same path twice (case-insensitively, after NFC), or a file used as a
//     directory by another entry                                                  → duplicate (400)
//   - over KIT_UPLOAD_LIMITS: compressed bytes, gunzipped bytes, entries           → too_large (413)
// Nothing is written to disk here: extract.ts writes the returned files into a fresh temp dir.
// macOS archive litter (`__MACOSX/`, `._*` AppleDouble files, `.DS_Store`) is dropped after the
// path checks, so a `tar czf` on a Mac uploads cleanly.
import { gunzipSync } from "node:zlib";
import { KIT_UPLOAD_LIMITS } from "@anybench/core";

export type KitArchiveErrorCode =
  "malformed" | "link" | "special_file" | "unsafe_path" | "duplicate" | "too_large";

export class KitArchiveError extends Error {
  constructor(
    readonly code: KitArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KitArchiveError";
  }

  /** 413 for a limit, 400 for everything else. */
  get status(): 400 | 413 {
    return this.code === "too_large" ? 413 : 400;
  }
}

export interface KitArchiveLimits {
  maxBytes: number;
  maxUnpackedBytes: number;
  maxEntries: number;
  maxPathBytes: number;
  maxDepth: number;
}

export interface KitArchiveFile {
  /** Kit-relative, `/`-separated, already checked. */
  path: string;
  /** 0o755 when the archive marked it executable by anyone, else 0o644 (never setuid/setgid). */
  mode: 0o755 | 0o644;
  data: Uint8Array;
}

export interface KitArchive {
  files: KitArchiveFile[];
  /** Explicit directory entries (kit-relative); parents of files are implied. */
  dirs: string[];
  /** The single top-level directory that was stripped (`""` when the kit was at the root). */
  stripped: string;
  unpackedBytes: number;
}

const BLOCK = 512;
const MAX_SEGMENT_BYTES = 255;
/** Cap on one pax or GNU long-name header body. */
const MAX_META_BYTES = 64 * 1024;
const MANIFEST = "anybench.yaml";
const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

function cstr(buf: Uint8Array, start: number, len: number): string {
  let end = start;
  while (end < start + len && buf[end] !== 0) end++;
  return decoder.decode(buf.subarray(start, end));
}

function octal(buf: Uint8Array, start: number, len: number, what: string): number {
  if ((buf[start]! & 0x80) !== 0) throw new KitArchiveError("malformed", `base-256 ${what} field`);
  const s = cstr(buf, start, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new KitArchiveError("malformed", `bad octal ${what} field`);
  const n = parseInt(s, 8);
  if (!Number.isSafeInteger(n)) throw new KitArchiveError("malformed", `${what} field too large`);
  return n;
}

/** ustar checksum: header bytes summed with the checksum field read as spaces. */
function checksumOk(h: Uint8Array): boolean {
  const want = octal(h, 148, 8, "checksum");
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i]!;
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return want === unsigned || want === signed;
}

/** PAX records `<len> <key>=<value>\n`. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    let sp = i;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    if (sp >= data.length) break;
    const len = Number(decoder.decode(data.subarray(i, sp)));
    if (!Number.isSafeInteger(len) || len <= sp - i + 1 || i + len > data.length) {
      throw new KitArchiveError("malformed", "bad pax header record");
    }
    const rec = decoder.decode(data.subarray(sp + 1, i + len - 1));
    const eq = rec.indexOf("=");
    if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return out;
}

/**
 * The checked kit-relative path of an entry, or "" for the archive root (`./`). Throws
 * unsafe_path for anything that could land outside the extraction directory or mean two things.
 */
export function checkEntryPath(raw: string, limits: KitArchiveLimits): string {
  const show = JSON.stringify(raw.slice(0, 200));
  const refuse = (why: string): never => {
    throw new KitArchiveError("unsafe_path", `entry ${show} ${why}`);
  };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) refuse("has a control character");
  if (raw.includes("\\")) refuse("has a backslash");
  if (raw.startsWith("/")) refuse("is an absolute path");
  if (/^[A-Za-z]:/.test(raw)) refuse("starts with a drive letter");
  let p = raw;
  while (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/")) p = p.replace(/\/+$/, "");
  if (p === "" || p === ".") return "";
  if (encoder.encode(p).byteLength > limits.maxPathBytes) {
    refuse(`is longer than ${limits.maxPathBytes} bytes`);
  }
  const segs = p.split("/");
  if (segs.length > limits.maxDepth) refuse(`is deeper than ${limits.maxDepth} directories`);
  for (const seg of segs) {
    if (seg === "") refuse("has an empty path segment");
    if (seg === "..") refuse("escapes the kit with ..");
    if (seg === ".") refuse("has a . segment");
    if (encoder.encode(seg).byteLength > MAX_SEGMENT_BYTES) {
      refuse(`has a segment longer than ${MAX_SEGMENT_BYTES} bytes`);
    }
  }
  return p;
}

function isLitter(p: string): boolean {
  const segs = p.split("/");
  const base = segs[segs.length - 1]!;
  return segs[0] === "__MACOSX" || base.startsWith("._") || base === ".DS_Store";
}

const foldKey = (p: string) => p.normalize("NFC").toLowerCase();

function gunzip(input: Uint8Array, limits: KitArchiveLimits): Uint8Array {
  if (input.byteLength > limits.maxBytes) {
    throw new KitArchiveError(
      "too_large",
      `the kit tarball is ${input.byteLength} bytes, over the ${limits.maxBytes} byte limit`,
    );
  }
  if (input[0] !== 0x1f || input[1] !== 0x8b) {
    throw new KitArchiveError("malformed", "the kit is not a gzip file (.tar.gz)");
  }
  // Headers and padding on top of the file bytes: at most 4 blocks per entry (pax + header + pad).
  const cap = limits.maxUnpackedBytes + (limits.maxEntries + 16) * 4 * BLOCK;
  try {
    return gunzipSync(input, { maxOutputLength: cap });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
      throw new KitArchiveError(
        "too_large",
        `the kit unpacks to more than ${limits.maxUnpackedBytes} bytes`,
      );
    }
    throw new KitArchiveError(
      "malformed",
      `gunzip failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Read and check an uploaded kit tarball. Throws KitArchiveError; never touches the disk. */
export function readKitArchive(
  input: Uint8Array,
  limits: KitArchiveLimits = KIT_UPLOAD_LIMITS,
): KitArchive {
  const tar = gunzip(input, limits);
  const files: KitArchiveFile[] = [];
  const dirs: string[] = [];
  const fileKeys = new Set<string>();
  const dirKeys = new Set<string>();
  let entries = 0;
  let unpacked = 0;
  let pax = new Map<string, string>();
  let longName: string | null = null;
  let off = 0;
  let ended = false;

  const countEntry = () => {
    if (++entries > limits.maxEntries) {
      throw new KitArchiveError(
        "too_large",
        `the kit has more than ${limits.maxEntries} files and directories`,
      );
    }
  };
  const addDir = (p: string) => {
    const k = foldKey(p);
    if (fileKeys.has(k))
      throw new KitArchiveError("duplicate", `${p} is both a file and a directory`);
    dirKeys.add(k);
  };

  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) {
      ended = true;
      break;
    }
    if (!checksumOk(h))
      throw new KitArchiveError("malformed", `bad tar header checksum at byte ${off}`);
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]!);
    let size = octal(h, 124, 12, "size");
    if (pax.has("size") && type !== "x" && type !== "g") {
      const n = Number(pax.get("size"));
      if (!Number.isSafeInteger(n) || n < 0) throw new KitArchiveError("malformed", "bad pax size");
      size = n;
    }
    const start = off + BLOCK;
    const end = start + size;
    if (end > tar.length)
      throw new KitArchiveError("malformed", "an entry runs past the end of the archive");
    const data = tar.subarray(start, end);
    off = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x" || type === "g" || type === "L") {
      if (size > MAX_META_BYTES)
        throw new KitArchiveError("malformed", "oversized tar metadata header");
      if (type === "x") {
        pax = paxRecords(data);
        if (pax.has("linkpath")) {
          throw new KitArchiveError(
            "link",
            "the kit has a link entry (pax linkpath); links are not allowed",
          );
        }
      } else if (type === "L") {
        longName = cstr(data, 0, data.length);
      }
      // `g` (global pax) carries only defaults such as mtime; nothing in it changes a path.
      continue;
    }

    const magic = cstr(h, 257, 6);
    const prefix = magic.startsWith("ustar") ? cstr(h, 345, 155) : "";
    const base = cstr(h, 0, 100);
    const rawName = pax.get("path") ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    const mode = octal(h, 100, 8, "mode");
    pax = new Map();
    longName = null;

    if (type === "1" || type === "2" || type === "K") {
      throw new KitArchiveError(
        "link",
        `entry ${JSON.stringify(rawName.slice(0, 200))} is a ${type === "1" ? "hard link" : "symlink"}; links are not allowed in a kit`,
      );
    }
    if (type !== "0" && type !== "7" && type !== "5") {
      throw new KitArchiveError(
        "special_file",
        `entry ${JSON.stringify(rawName.slice(0, 200))} has tar type '${type}'; only regular files and directories are allowed`,
      );
    }
    const p = checkEntryPath(rawName, limits);
    if (p === "" || isLitter(p)) continue;

    if (type === "5") {
      countEntry();
      addDir(p);
      dirs.push(p);
      continue;
    }
    countEntry();
    unpacked += size;
    if (unpacked > limits.maxUnpackedBytes) {
      throw new KitArchiveError(
        "too_large",
        `the kit unpacks to more than ${limits.maxUnpackedBytes} bytes`,
      );
    }
    const k = foldKey(p);
    if (fileKeys.has(k)) throw new KitArchiveError("duplicate", `${p} appears more than once`);
    if (dirKeys.has(k))
      throw new KitArchiveError("duplicate", `${p} is both a file and a directory`);
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) addDir(segs.slice(0, i).join("/"));
    fileKeys.add(k);
    files.push({ path: p, mode: (mode & 0o111) !== 0 ? 0o755 : 0o644, data });
  }
  if (!ended && off < tar.length) {
    throw new KitArchiveError("malformed", "the archive ends inside a header");
  }

  // One wrapping directory (`tar czf kit.tgz my-kit/`) is stripped when it holds the manifest.
  let stripped = "";
  if (!files.some((f) => f.path === MANIFEST)) {
    const tops = new Set([...files.map((f) => f.path), ...dirs].map((p) => p.split("/")[0]!));
    const [top] = tops;
    if (tops.size === 1 && top && files.some((f) => f.path === `${top}/${MANIFEST}`)) {
      stripped = top;
      const cut = (p: string) => p.slice(top.length + 1);
      for (const f of files) f.path = cut(f.path);
      const inner = dirs.filter((d) => d !== top).map(cut);
      dirs.length = 0;
      dirs.push(...inner);
    }
  }
  return { files, dirs, stripped, unpackedBytes: unpacked };
}
