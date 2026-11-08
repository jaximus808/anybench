// TDM-44: the frozen outputs bundle (`out.tar.gz`, the runner's freeze) as an in-memory file map,
// so the proof suite can read the oracle's output (reference capture) and plant a mutant into
// it (mutation kill rate) without a `tar` binary on the worker.
//
// Reads ustar + PAX (`path`, `size`), GNU long names (`L`) and plain v7 headers; keeps regular
// files only (links, devices and directories are dropped: the gate runner drops special files
// too, and directories are implied by the paths). Writes ustar with PAX headers for long names.
import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;

/** Path (relative, `/`-separated, no leading `./`) → bytes. */
export type BundleFiles = Map<string, Uint8Array>;

export class BundleError extends Error {
  override readonly name = "BundleError";
}

function cstr(buf: Buffer, off: number, len: number): string {
  const end = buf.indexOf(0, off);
  return buf.toString("utf8", off, end < 0 || end > off + len ? off + len : end);
}

function octal(buf: Buffer, off: number, len: number): number {
  const s = cstr(buf, off, len).trim();
  if (s === "") return 0;
  const n = Number.parseInt(s, 8);
  if (!Number.isFinite(n) || n < 0) throw new BundleError(`bad tar number '${s}'`);
  return n;
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

/** Normalise an entry name; null for anything that would escape the bundle root. */
export function normalizeBundlePath(name: string): string | null {
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

/** Read a tar.gz (or plain tar) into a file map. */
export function readBundle(data: Uint8Array): BundleFiles {
  const raw = Buffer.from(data);
  const tar = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const files: BundleFiles = new Map();
  let off = 0;
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const type = String.fromCharCode(h[156] || 0x30);
    let size = octal(h, 124, 12);
    if (pax.size !== undefined) size = Number.parseInt(pax.size, 10);
    const bodyStart = off + BLOCK;
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
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    pax = {};
    longName = undefined;
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    const p = normalizeBundlePath(name);
    if (p === null) continue;
    files.set(p, new Uint8Array(body));
  }
  return files;
}

function header(name: string, size: number, type: "0" | "x", mode: number): Buffer {
  const b = Buffer.alloc(BLOCK);
  const field = (s: string, off: number, len: number) => b.write(s, off, len, "utf8");
  const num = (n: number, off: number, len: number) =>
    field(`${n.toString(8).padStart(len - 1, "0")}\0`, off, len);
  field(name.slice(0, 100), 0, 100);
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

/** Write a file map as tar.gz (sorted paths, mode 0644, mtime 0: byte-identical for equal maps). */
export function writeBundle(files: BundleFiles): Uint8Array {
  const parts: Buffer[] = [];
  for (const p of [...files.keys()].sort()) {
    const data = Buffer.from(files.get(p)!);
    if (Buffer.byteLength(p) > 100) {
      const rec = Buffer.from(paxRecord("path", p));
      parts.push(header("pax-header", rec.length, "x", 0o644), rec, pad(rec.length));
    }
    parts.push(header(p, data.length, "0", 0o644), data, pad(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}
