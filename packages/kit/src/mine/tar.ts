// TDM-186 [16.15]: a minimal POSIX tar writer (ustar + pax long names), so the miner ships a tree
// to an eval computer as one putFile without depending on the host's tar flavour (bsdtar on macOS
// adds xattr/AppleDouble entries GNU tar then warns about). Regular files and symlinks only.
import type { TreeFile } from "./git.js";

const BLOCK = 512;
/** 2000-01-01T00:00:00Z. */
const FIXED_MTIME = 946_684_800;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number, mode: number, type: string, link: string): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, "utf8");
  h.write(octal(mode, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii"); // uid
  h.write(octal(0, 8), 116, 8, "ascii"); // gid
  h.write(octal(size, 12), 124, 12, "ascii");
  // mtime: fixed (reproducible bytes) and after 1980, since ZIP-based tools (wheel builds) refuse
  // older timestamps. Extract with `tar -m` so build tools see fresh mtimes.
  h.write(octal(FIXED_MTIME, 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii"); // checksum placeholder
  h.write(type, 156, 1, "ascii");
  h.write(link, 157, 100, "utf8");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return h;
}

function pad(buf: Buffer): Buffer[] {
  const rest = buf.length % BLOCK;
  return rest === 0 ? [buf] : [buf, Buffer.alloc(BLOCK - rest, 0)];
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) {
    len = String(len).length + Buffer.byteLength(body);
  }
  return Buffer.from(`${len}${body}`, "utf8");
}

/** A tar of `files` at their relative paths. */
export function buildTar(files: readonly TreeFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const symlink = f.mode === "120000";
    const link = symlink ? f.content.toString("utf8") : "";
    const pax: Buffer[] = [];
    if (Buffer.byteLength(f.path) > 99) pax.push(paxRecord("path", f.path));
    if (Buffer.byteLength(link) > 99) pax.push(paxRecord("linkpath", link));
    if (pax.length > 0) {
      const body = Buffer.concat(pax);
      parts.push(header("././@PaxHeader", body.length, 0o644, "x", ""), ...pad(body));
    }
    const name = Buffer.byteLength(f.path) > 99 ? f.path.slice(0, 99) : f.path;
    const mode = f.mode === "100755" ? 0o755 : 0o644;
    if (symlink) {
      parts.push(header(name, 0, 0o777, "2", link.slice(0, 99)));
    } else {
      parts.push(header(name, f.content.length, mode, "0", ""), ...pad(f.content));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}
