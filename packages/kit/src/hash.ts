// Deterministic workload hashing: sha256 per file, then sha256 of a sorted manifest (TDM-33 [4.1]).
//
// The manifest is one line per regular file, sorted by path (code-unit order, never locale):
//   <sha256 hex>  <size in bytes>  <path relative to the kit root, '/'-separated>\n
// and the workload's sha256 is the sha256 of that text. Only bytes and relative paths go in, never
// mtimes, modes or owners, so a copy of the kit on another machine hashes the same.
// Symlinks and special files are rejected: their bytes depend on the host.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

/** Names never hashed (OS litter that is not part of the kit). */
export const HASH_IGNORED_NAMES: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db"]);

export interface HashedFile {
  /** Relative to the kit root, '/'-separated. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface TreeHash {
  files: HashedFile[];
  /** The manifest text that `sha256` hashes. */
  manifest: string;
  sha256: string;
}

export type HashProblem =
  | { kind: "symlink"; path: string }
  | { kind: "special"; path: string }
  | { kind: "missing"; path: string };

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256OfFile(abs: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export function buildManifest(files: readonly HashedFile[]): string {
  return files.map((f) => `${f.sha256}  ${f.bytes}  ${f.path}\n`).join("");
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * Hash every regular file under the given kit-relative paths (files or directories, recursively).
 * Paths that do not exist are reported as problems, so callers decide whether that is an error.
 */
export async function hashKitPaths(
  kitDir: string,
  relPaths: readonly string[],
): Promise<{ hash: TreeHash; problems: HashProblem[] }> {
  const seen = new Map<string, HashedFile>();
  const problems: HashProblem[] = [];

  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(kitDir, rel);
    let st;
    try {
      st = await lstat(abs);
    } catch {
      problems.push({ kind: "missing", path: rel });
      return;
    }
    if (st.isSymbolicLink()) {
      problems.push({ kind: "symlink", path: rel });
    } else if (st.isDirectory()) {
      const entries = (await readdir(abs)).filter((n) => !HASH_IGNORED_NAMES.has(n)).sort();
      for (const name of entries) await walk(rel === "" ? name : `${rel}/${name}`);
    } else if (st.isFile()) {
      if (!seen.has(rel))
        seen.set(rel, { path: rel, sha256: await sha256OfFile(abs), bytes: st.size });
    } else {
      problems.push({ kind: "special", path: rel });
    }
  };

  for (const p of relPaths) await walk(p.replace(/\/+$/, ""));
  const files = [...seen.values()].sort(byPath);
  const manifest = buildManifest(files);
  return { hash: { files, manifest, sha256: sha256Hex(manifest) }, problems };
}
