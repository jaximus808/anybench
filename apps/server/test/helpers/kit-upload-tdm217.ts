// TDM-217 test helpers: a tiny tar writer that can also craft hostile entries (links, `..`,
// absolute paths, devices), a directory → .tar.gz packer that keeps exec bits, and an in-memory
// KitFileStore that behaves like the presigned R2 flow (a PUT must match the signed length and
// sha256).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ArtifactTransferError, kitFilesKey, kitUploadKey } from "@anybench/envs";
import type { KitFileStore } from "../../src/lib/kit-upload/store.js";

const BLOCK = 512;

export interface TarEntryTdm217 {
  name: string;
  /** '0' file (default), '5' dir, '1' hardlink, '2' symlink, '3' char device, 'x' pax, 'L' GNU long name. */
  type?: string;
  data?: Uint8Array | string;
  mode?: number;
  linkname?: string;
  /** Write the name into the ustar prefix field instead of the name field. */
  prefix?: string;
  /** Corrupt the header checksum. */
  badChecksum?: boolean;
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(e: TarEntryTdm217, size: number): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(e.name, 0, 100, "utf8");
  h.write(octal(e.mode ?? 0o644, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii");
  h.write(octal(0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(946_684_800, 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write(e.type ?? "0", 156, 1, "ascii");
  h.write(e.linkname ?? "", 157, 100, "utf8");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  if (e.prefix) h.write(e.prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  if (e.badChecksum) sum += 1;
  h.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return h;
}

export function paxBodyTdm217(records: Record<string, string>): Buffer {
  return Buffer.concat(
    Object.entries(records).map(([k, v]) => {
      const body = ` ${k}=${v}\n`;
      let len = Buffer.byteLength(body) + 1;
      while (String(len).length + Buffer.byteLength(body) !== len)
        len = String(len).length + Buffer.byteLength(body);
      return Buffer.from(`${len}${body}`, "utf8");
    }),
  );
}

/** A plain tar of `entries` (end-of-archive blocks included). */
export function tarTdm217(entries: readonly TarEntryTdm217[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data =
      e.data === undefined
        ? Buffer.alloc(0)
        : typeof e.data === "string"
          ? Buffer.from(e.data, "utf8")
          : Buffer.from(e.data);
    parts.push(header(e, data.length), data);
    const rest = data.length % BLOCK;
    if (rest) parts.push(Buffer.alloc(BLOCK - rest, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

export function tgzTdm217(entries: readonly TarEntryTdm217[]): Buffer {
  return gzipSync(tarTdm217(entries));
}

/** Every regular file under `dir` as tar entries (relative paths, exec bits kept), optionally under `prefix/`. */
export function dirEntriesTdm217(dir: string, prefix = ""): TarEntryTdm217[] {
  const out: TarEntryTdm217[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(path.join(dir, r));
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) {
        const name = prefix ? `${prefix}/${r}` : r;
        const data = readFileSync(path.join(dir, r));
        // Long names go in a pax header, as `tar` writes them.
        if (Buffer.byteLength(name) > 99) {
          out.push({ name: "././@PaxHeader", type: "x", data: paxBodyTdm217({ path: name }) });
          out.push({ name: name.slice(0, 99), data, mode: st.mode & 0o777 });
        } else out.push({ name, data, mode: st.mode & 0o777 });
      }
    }
  };
  walk("");
  return out;
}

export const sha256Tdm217 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** In-memory KitFileStore: `put(url, bytes)` plays the client's presigned PUT. */
export function fakeKitStoreTdm217(): KitFileStore & {
  objects: Map<string, Uint8Array>;
  put(url: string, headers: Record<string, string>, body: Uint8Array): number;
} {
  const objects = new Map<string, Uint8Array>();
  const signed = new Map<string, { size: number; sha256: string }>();
  const BASE = "https://r2.test/bucket/";
  return {
    objects,
    async createKitUpload(i) {
      if (i.sizeBytes > i.maxBytes) throw new ArtifactTransferError("too_large", "too large");
      const key = kitUploadKey(i.ownerId, i.uploadId);
      signed.set(key, { size: i.sizeBytes, sha256: i.sha256 });
      return {
        key,
        url: `${BASE}${key}?X-Amz-Signature=fake`,
        headers: {
          "content-length": String(i.sizeBytes),
          "x-amz-meta-sha256": i.sha256,
        },
        expiresAt: new Date(Date.now() + i.expiresInSec * 1000).toISOString(),
      };
    },
    put(url, headers, body) {
      const key = decodeURIComponent(new URL(url).pathname.slice("/bucket/".length));
      const s = signed.get(key);
      // R2: the signed content-length and checksum must match the body (else 403 / BadDigest).
      if (!s || s.size !== body.byteLength || headers["x-amz-meta-sha256"] !== s.sha256) return 403;
      if (sha256Tdm217(body) !== s.sha256) return 400;
      objects.set(key, new Uint8Array(body));
      return 200;
    },
    async getKitUpload(ownerId, uploadId, maxBytes) {
      const b = objects.get(kitUploadKey(ownerId, uploadId));
      if (!b) return null;
      if (b.byteLength > maxBytes) throw new ArtifactTransferError("too_large", "over the cap");
      return { bytes: b, sha256: sha256Tdm217(b) };
    },
    async deleteKitUpload(ownerId, uploadId) {
      objects.delete(kitUploadKey(ownerId, uploadId));
    },
    async putKitFiles(ownerId, kitId, body) {
      const key = kitFilesKey(ownerId, kitId);
      objects.set(key, new Uint8Array(body));
      return { key };
    },
    async createKitDownload(key, expiresInSec = 3600) {
      if (!objects.has(key)) throw new ArtifactTransferError("not_found", `${key} does not exist`);
      return {
        url: `${BASE}${key}?X-Amz-Signature=get`,
        expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      };
    },
  };
}
