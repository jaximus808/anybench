// A small streaming tar.gz writer (ustar + PAX headers for long paths and big files), so `freeze`
// does not depend on which `tar` the image ships and can bundle files that are still being
// appended to (events.jsonl): each file contributes exactly the bytes it had when it was opened.

import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const BLOCK = 512;
const MAX_USTAR_SIZE = 0o77777777777; // 11 octal digits

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, size: number, mtime: number, type: "0" | "x"): Buffer {
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 100, "utf8");
  b.write(octal(0o644, 8), 100, "ascii");
  b.write(octal(0, 8), 108, "ascii");
  b.write(octal(0, 8), 116, "ascii");
  b.write(octal(Math.min(size, MAX_USTAR_SIZE), 12), 124, "ascii");
  b.write(octal(mtime, 12), 136, "ascii");
  b.write("        ", 148, "ascii");
  b.write(type, 156, "ascii");
  b.write("ustar\0", 257, "ascii");
  b.write("00", 263, "ascii");
  b.write("anybench", 265, "ascii");
  b.write("anybench", 297, "ascii");
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return b;
}

function paxRecord(key: string, value: string): string {
  // "<len> key=value\n", where <len> counts the whole record including its own digits.
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body);
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return `${len}${body}`;
}

function pad(size: number): Buffer {
  const rem = size % BLOCK;
  return Buffer.alloc(rem === 0 ? 0 : BLOCK - rem);
}

async function* tarStream(baseDir: string, files: readonly string[]): AsyncGenerator<Buffer> {
  for (const rel of files) {
    const fh = await open(`${baseDir}/${rel}`, "r");
    try {
      const st = await fh.stat();
      const size = st.size;
      const mtime = Math.floor(st.mtimeMs / 1000);
      const nameBytes = Buffer.byteLength(rel);
      if (nameBytes > 100 || size > MAX_USTAR_SIZE) {
        let pax = "";
        if (nameBytes > 100) pax += paxRecord("path", rel);
        if (size > MAX_USTAR_SIZE) pax += paxRecord("size", String(size));
        const paxBuf = Buffer.from(pax, "utf8");
        yield header("././@PaxHeader", paxBuf.length, mtime, "x");
        yield paxBuf;
        yield pad(paxBuf.length);
      }
      yield header(nameBytes > 100 ? rel.slice(0, 100) : rel, size, mtime, "0");
      let offset = 0;
      const chunk = 1024 * 1024;
      while (offset < size) {
        const want = Math.min(chunk, size - offset);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, offset);
        if (bytesRead === 0) {
          // Shrank while reading: zero-fill so the archive stays well formed.
          yield Buffer.alloc(size - offset);
          offset = size;
          break;
        }
        yield bytesRead === want ? buf : buf.subarray(0, bytesRead);
        offset += bytesRead;
      }
      yield pad(size);
    } finally {
      await fh.close().catch(() => undefined);
    }
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** Write `files` (relative to `baseDir`, `/`-separated) into a gzipped tar at `dest`. */
export async function writeTarGz(
  baseDir: string,
  files: readonly string[],
  dest: string,
): Promise<void> {
  await pipeline(Readable.from(tarStream(baseDir, files)), createGzip(), createWriteStream(dest));
}
