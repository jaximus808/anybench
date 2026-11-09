// TDM-219 [19.3]: the kit tarball `anybench kit push` uploads (and the MCP server's push, TDM-220).
//
//   packKit(dir)                 the kit folder → a deterministic .tar.gz (sorted paths, mtime 0,
//                                uid/gid 0, mode 0755 for executables and dirs, 0644 otherwise)
//   inspectKitArchive(bytes)     the rules an uploaded tarball must satisfy, on its bytes alone:
//                                gzip, size caps, a file-count cap, relative paths with no `..`,
//                                regular files and directories only (no symlinks, hard links or
//                                devices), no duplicate paths, anybench.yaml at the root
//
// packKit checks its own output with inspectKitArchive, so a tarball it returns is one the server
// accepts on these rules (the server then runs validateKitDir on the extracted folder, and reruns
// the proof). Symlinks in the folder that resolve to a regular file inside the kit are packed as
// that file; any other symlink is refused, since the archive never carries links.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { KIT_UPLOAD_CONTENT_TYPE, KIT_UPLOAD_LIMITS } from "@anybench/core";
import { HASH_IGNORED_NAMES, isInsideDir } from "./hash.js";
import { KIT_LAYOUT } from "./layout.js";

/**
 * What an uploaded kit tarball may be: core's KIT_UPLOAD_LIMITS, the numbers the upload API
 * (TDM-217) enforces, renamed only where this module is more specific (`maxArchiveBytes`).
 */
export const KIT_ARCHIVE_LIMITS = {
  /** The .tar.gz as uploaded. */
  maxArchiveBytes: KIT_UPLOAD_LIMITS.maxBytes,
  /** Sum of the regular files' sizes once extracted. */
  maxUnpackedBytes: KIT_UPLOAD_LIMITS.maxUnpackedBytes,
  /** Entries (files and directories). */
  maxEntries: KIT_UPLOAD_LIMITS.maxEntries,
  /** One path, in UTF-8 bytes. */
  maxPathBytes: KIT_UPLOAD_LIMITS.maxPathBytes,
  /** Path segments in one entry. */
  maxDepth: KIT_UPLOAD_LIMITS.maxDepth,
} as const;
export type KitArchiveLimits = { [K in keyof typeof KIT_ARCHIVE_LIMITS]: number };

export const KIT_ARCHIVE_CONTENT_TYPE = KIT_UPLOAD_CONTENT_TYPE;

/** Directory names never packed (VCS metadata). HASH_IGNORED_NAMES files are skipped too. */
export const KIT_ARCHIVE_SKIPPED_DIRS: ReadonlySet<string> = new Set([".git", ".hg", ".svn"]);

export type KitArchiveProblemCode =
  | "not_gzip"
  | "bad_tar"
  | "archive_too_large"
  | "unpacked_too_large"
  | "too_many_entries"
  | "absolute_path"
  | "parent_path"
  | "path_too_long"
  | "bad_path"
  | "link_entry"
  | "special_entry"
  | "duplicate_path"
  | "manifest_missing";

export interface KitArchiveProblem {
  code: KitArchiveProblemCode;
  /** The entry's path as written in the archive, when the problem is about one entry. */
  path?: string;
  message: string;
}

export interface KitArchiveEntry {
  /** Normalised, `/`-separated, relative. */
  path: string;
  type: "file" | "dir";
  size: number;
  mode: number;
}

export interface KitArchiveInspection {
  ok: boolean;
  problems: KitArchiveProblem[];
  entries: KitArchiveEntry[];
  files: number;
  unpackedBytes: number;
  archiveBytes: number;
}

export class KitArchiveError extends Error {
  override readonly name = "KitArchiveError";
  constructor(
    message: string,
    readonly problems: readonly KitArchiveProblem[],
  ) {
    super(message);
  }
}

export interface PackedKit {
  /** The .tar.gz. */
  bytes: Uint8Array;
  /** sha256 hex of `bytes`. */
  sha256: string;
  /** Regular files packed. */
  files: number;
  unpackedBytes: number;
  /** Kit-relative paths of the files, sorted. */
  paths: string[];
}

export interface PackKitOptions {
  limits?: Partial<KitArchiveLimits>;
}

// ---------------------------------------------------------------------------------------------
// tar reading (just enough to inspect: ustar, PAX path/size, GNU long names)

const BLOCK = 512;

function cstr(buf: Buffer, off: number, len: number): string {
  const end = buf.indexOf(0, off);
  return buf.toString("utf8", off, end < 0 || end > off + len ? off + len : end);
}

function octal(buf: Buffer, off: number, len: number): number {
  const s = cstr(buf, off, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error(`bad tar number '${s}'`);
  return Number.parseInt(s, 8);
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number.parseInt(body.toString("ascii", i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = body.toString("utf8", sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Check an uploaded kit tarball against the archive rules without extracting it. Never throws:
 * a malformed archive is a `bad_tar` / `not_gzip` problem.
 */
export function inspectKitArchive(
  data: Uint8Array,
  limits: Partial<KitArchiveLimits> = {},
): KitArchiveInspection {
  const L = { ...KIT_ARCHIVE_LIMITS, ...limits };
  const problems: KitArchiveProblem[] = [];
  const entries: KitArchiveEntry[] = [];
  let unpackedBytes = 0;
  const done = (): KitArchiveInspection => ({
    ok: problems.length === 0,
    problems,
    entries,
    files: entries.filter((e) => e.type === "file").length,
    unpackedBytes,
    archiveBytes: data.length,
  });

  if (data.length > L.maxArchiveBytes) {
    problems.push({
      code: "archive_too_large",
      message: `the archive is ${data.length} bytes, over the ${L.maxArchiveBytes}-byte cap`,
    });
    return done();
  }
  if (data[0] !== 0x1f || data[1] !== 0x8b) {
    problems.push({ code: "not_gzip", message: "the archive is not gzip-compressed (.tar.gz)" });
    return done();
  }
  let tar: Buffer;
  try {
    // The gunzip output is capped too, so a gzip bomb stops at the unpacked cap plus headers.
    tar = gunzipSync(data, {
      maxOutputLength: L.maxUnpackedBytes + (L.maxEntries + 8) * 3 * BLOCK,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    problems.push(
      /maxOutputLength|buffer|too large/i.test(msg)
        ? {
            code: "unpacked_too_large",
            message: `the archive unpacks to more than the cap (${msg})`,
          }
        : { code: "not_gzip", message: `gunzip failed: ${msg}` },
    );
    return done();
  }

  const seen = new Set<string>();
  let off = 0;
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let count = 0;
  try {
    while (off + BLOCK <= tar.length) {
      const h = tar.subarray(off, off + BLOCK);
      if (h.every((b) => b === 0)) break;
      const type = String.fromCharCode(h[156] || 0x30);
      let size = octal(h, 124, 12);
      if (pax.size !== undefined) size = Number.parseInt(pax.size, 10);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`bad entry size ${pax.size}`);
      const bodyStart = off + BLOCK;
      if (bodyStart + size > tar.length) throw new Error("truncated entry");
      const body = tar.subarray(bodyStart, bodyStart + size);
      off = bodyStart + Math.ceil(size / BLOCK) * BLOCK;
      if (type === "x") {
        pax = parsePax(body);
        continue;
      }
      if (type === "g") continue;
      if (type === "L") {
        longName = cstr(body, 0, body.length);
        continue;
      }
      const prefix = h.toString("utf8", 257, 263).startsWith("ustar") ? cstr(h, 345, 155) : "";
      const base = cstr(h, 0, 100);
      const raw = pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
      pax = {};
      longName = undefined;
      count++;
      if (count > L.maxEntries) {
        problems.push({
          code: "too_many_entries",
          message: `the archive has more than ${L.maxEntries} entries`,
        });
        break;
      }
      const at = { path: raw };
      if (type === "1" || type === "2") {
        problems.push({
          code: "link_entry",
          ...at,
          message: `${raw} is a ${type === "2" ? "symlink" : "hard link"}; kit archives carry regular files and directories only`,
        });
        continue;
      }
      const isFile = type === "0" || type === "\0" || type === "7";
      const isDir = type === "5";
      if (!isFile && !isDir) {
        problems.push({
          code: "special_entry",
          ...at,
          message: `${raw} is a special entry (tar type '${type}'); kit archives carry regular files and directories only`,
        });
        continue;
      }
      if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
        problems.push({ code: "absolute_path", ...at, message: `${raw} is an absolute path` });
        continue;
      }
      if (raw.includes("\\") || raw.includes("\0")) {
        problems.push({ code: "bad_path", ...at, message: `${raw} has a backslash or NUL in it` });
        continue;
      }
      const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
      if (parts.some((p) => p === "..")) {
        problems.push({ code: "parent_path", ...at, message: `${raw} has a '..' segment` });
        continue;
      }
      if (parts.length === 0) {
        if (isDir) continue; // `./` itself
        problems.push({ code: "bad_path", ...at, message: `an entry has an empty path` });
        continue;
      }
      const p = parts.join("/");
      if (Buffer.byteLength(p) > L.maxPathBytes || parts.length > L.maxDepth) {
        problems.push({
          code: "path_too_long",
          ...at,
          message: `${p.slice(0, 80)}… is longer than ${L.maxPathBytes} bytes or ${L.maxDepth} directories deep`,
        });
        continue;
      }
      if (seen.has(p)) {
        problems.push({ code: "duplicate_path", ...at, message: `${p} appears twice` });
        continue;
      }
      seen.add(p);
      const mode = octal(h, 100, 8) & 0o7777;
      entries.push({ path: p, type: isDir ? "dir" : "file", size: isDir ? 0 : size, mode });
      if (isFile) unpackedBytes += size;
    }
  } catch (e) {
    problems.push({
      code: "bad_tar",
      message: `not a readable tar: ${e instanceof Error ? e.message : String(e)}`,
    });
    return done();
  }
  if (unpackedBytes > L.maxUnpackedBytes) {
    problems.push({
      code: "unpacked_too_large",
      message: `the files add up to ${unpackedBytes} bytes, over the ${L.maxUnpackedBytes}-byte cap`,
    });
  }
  if (!entries.some((e) => e.type === "file" && e.path === KIT_LAYOUT.manifest)) {
    problems.push({
      code: "manifest_missing",
      message: `no ${KIT_LAYOUT.manifest} at the root of the archive`,
    });
  }
  return done();
}

// ---------------------------------------------------------------------------------------------
// tar writing

function header(name: string, size: number, type: "0" | "5" | "x", mode: number): Buffer {
  const b = Buffer.alloc(BLOCK);
  const field = (s: string, o: number, len: number) => b.write(s, o, len, "utf8");
  const num = (n: number, o: number, len: number) =>
    field(`${n.toString(8).padStart(len - 1, "0")}\0`, o, len);
  field(name, 0, 100);
  num(mode, 100, 8);
  num(0, 108, 8);
  num(0, 116, 8);
  num(size, 124, 12);
  num(0, 136, 12);
  b.fill(0x20, 148, 156);
  field(type, 156, 1);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  let sum = 0;
  for (const x of b) sum += x;
  field(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return b;
}

function pad(len: number): Buffer {
  const r = len % BLOCK;
  return Buffer.alloc(r === 0 ? 0 : BLOCK - r);
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) {
    len = String(len).length + Buffer.byteLength(body);
  }
  return `${len}${body}`;
}

interface PackEntry {
  path: string;
  type: "file" | "dir";
  mode: number;
  data?: Buffer;
}

function writeTarGz(entries: readonly PackEntry[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const name = e.type === "dir" ? `${e.path}/` : e.path;
    const data = e.data ?? Buffer.alloc(0);
    if (Buffer.byteLength(name) > 100) {
      const rec = Buffer.from(paxRecord("path", name));
      parts.push(header("pax-header", rec.length, "x", 0o644), rec, pad(rec.length));
    }
    parts.push(
      header(name, data.length, e.type === "dir" ? "5" : "0", e.mode),
      data,
      pad(data.length),
    );
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return new Uint8Array(gzipSync(Buffer.concat(parts), { level: 9 }));
}

// ---------------------------------------------------------------------------------------------

/**
 * Pack the kit folder at `dir` into the upload tarball. Skips `.git/` (and `.hg/`, `.svn/`) and
 * HASH_IGNORED_NAMES; refuses symlinks that dangle, leave the kit or point at a directory.
 * Byte-identical for identical folders. Does NOT validate anybench.yaml: call validateKitDir
 * first (the CLI's push does). Throws KitArchiveError.
 */
export async function packKit(dir: string, opts: PackKitOptions = {}): Promise<PackedKit> {
  const L = { ...KIT_ARCHIVE_LIMITS, ...opts.limits };
  const root = path.resolve(dir);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new KitArchiveError(`kit directory not found: ${root}`, []);
  }
  const problems: KitArchiveProblem[] = [];
  const entries: PackEntry[] = [];
  let unpacked = 0;

  const walk = async (rel: string): Promise<void> => {
    for (const name of (await readdir(path.join(root, rel))).sort()) {
      if (HASH_IGNORED_NAMES.has(name)) continue;
      const r = rel === "" ? name : `${rel}/${name}`;
      const abs = path.join(root, r);
      const st = await lstat(abs);
      if (st.isDirectory()) {
        if (KIT_ARCHIVE_SKIPPED_DIRS.has(name)) continue;
        entries.push({ path: r, type: "dir", mode: 0o755 });
        await walk(r);
        continue;
      }
      let fileAbs = abs;
      let fst = st;
      if (st.isSymbolicLink()) {
        let real: string | undefined;
        try {
          real = await realpath(abs);
        } catch {
          real = undefined;
        }
        if (real === undefined || !isInsideDir(realRoot, real)) {
          problems.push({
            code: "link_entry",
            path: r,
            message: `${r} is a symlink that dangles or resolves outside the kit`,
          });
          continue;
        }
        fst = await stat(real);
        if (!fst.isFile()) {
          problems.push({
            code: "link_entry",
            path: r,
            message: `${r} is a symlink to a directory; replace it with the directory itself`,
          });
          continue;
        }
        fileAbs = real;
      }
      if (!fst.isFile()) {
        problems.push({
          code: "special_entry",
          path: r,
          message: `${r} is not a regular file (socket, FIFO or device)`,
        });
        continue;
      }
      if (Buffer.byteLength(r) > L.maxPathBytes || r.split("/").length > L.maxDepth) {
        problems.push({
          code: "path_too_long",
          path: r,
          message: `${r} is longer than ${L.maxPathBytes} bytes or ${L.maxDepth} directories deep`,
        });
        continue;
      }
      unpacked += fst.size;
      if (unpacked > L.maxUnpackedBytes) {
        throw new KitArchiveError(
          `the kit's files add up to more than ${L.maxUnpackedBytes} bytes (at ${r})`,
          [{ code: "unpacked_too_large", path: r, message: `over ${L.maxUnpackedBytes} bytes` }],
        );
      }
      entries.push({
        path: r,
        type: "file",
        mode: (fst.mode & 0o111) !== 0 ? 0o755 : 0o644,
        data: await readFile(fileAbs),
      });
      if (entries.length > L.maxEntries) {
        throw new KitArchiveError(`the kit has more than ${L.maxEntries} files and directories`, [
          { code: "too_many_entries", message: `over ${L.maxEntries} entries` },
        ]);
      }
    }
  };
  await walk("");
  if (problems.length > 0) {
    throw new KitArchiveError(
      `cannot pack ${root}: ${problems.map((p) => p.message).join("; ")}`,
      problems,
    );
  }

  const bytes = writeTarGz(entries);
  const check = inspectKitArchive(bytes, L);
  if (!check.ok) {
    throw new KitArchiveError(
      `cannot pack ${root}: ${check.problems.map((p) => p.message).join("; ")}`,
      check.problems,
    );
  }
  const files = entries.filter((e) => e.type === "file");
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    files: files.length,
    unpackedBytes: unpacked,
    paths: files.map((f) => f.path),
  };
}
