// Deterministic workload hashing: sha256 per file, then sha256 of a sorted manifest (TDM-33 [4.1]).
//
// The manifest is one line per regular file, sorted by path (code-unit order, never locale):
//   <sha256 hex>  <size in bytes>  <path relative to the kit root, '/'-separated>\n
// and the workload's sha256 is the sha256 of that text. Only bytes and relative paths go in, never
// mtimes, modes or owners, so a copy of the kit on another machine hashes the same.
// File bytes are hashed raw: no newline or encoding conversion. The repo's .gitattributes marks
// the example kits and fixtures `-text` so a CRLF checkout cannot change their hashes.
// Symlinks and special files are rejected: their bytes depend on the host. Every walked path must
// resolve (realpath) inside the kit, so a symlinked parent such as `workloads -> /elsewhere`
// is refused rather than hashed.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
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
  | { kind: "outside"; path: string }
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

/**
 * Canonical kit-relative path: posix-normalized, no `./`, no `//`, no trailing `/`; `""` is the kit
 * root. Undefined when the path is absolute or escapes the kit with `..`.
 */
export function canonicalKitPath(p: string): string | undefined {
  if (p.startsWith("/") || p.includes("\\")) return undefined;
  const n = path.posix.normalize(p).replace(/\/+$/, "");
  if (n === "." || n === "") return "";
  if (n === ".." || n.startsWith("../")) return undefined;
  return n;
}

/** True when `real` is `realRoot` or inside it. Both must already be realpaths. */
export function isInsideDir(realRoot: string, real: string): boolean {
  return (
    real === realRoot ||
    real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)
  );
}

/** realpath, or undefined when the path (or a symlink target) does not exist. */
export async function realpathOrUndefined(abs: string): Promise<string | undefined> {
  try {
    return await realpath(abs);
  } catch {
    return undefined;
  }
}

export interface KitSymlink {
  /** Kit-relative path of the link. */
  path: string;
  /** False when the link resolves outside the kit, or dangles. */
  inside: boolean;
}

/**
 * Every symlink under a kit-relative file or directory (not followed). Used to refuse links that
 * escape the kit from declared folders such as `reference/`, `gates/<id>/reference/`, `proof/*`.
 */
export async function findKitSymlinks(kitDir: string, rel: string): Promise<KitSymlink[]> {
  const realRoot = await realpath(kitDir);
  const start = canonicalKitPath(rel);
  if (start === undefined) return [];
  const out: KitSymlink[] = [];
  const walk = async (r: string): Promise<void> => {
    const abs = path.join(kitDir, r);
    let st;
    try {
      st = await lstat(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      const real = await realpathOrUndefined(abs);
      out.push({ path: r, inside: real !== undefined && isInsideDir(realRoot, real) });
    } else if (st.isDirectory()) {
      for (const name of (await readdir(abs)).sort()) await walk(r === "" ? name : `${r}/${name}`);
    }
  };
  await walk(start);
  return out;
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * Hash every regular file under the given kit-relative paths (files or directories, recursively).
 * Paths are canonicalized first (`./workloads//w/` and `workloads/w` hash the same). Paths that do
 * not exist, resolve outside the kit, are symlinks or are special files come back as problems
 * (and are not hashed), so callers decide whether that is an error.
 */
export async function hashKitPaths(
  kitDir: string,
  relPaths: readonly string[],
): Promise<{ hash: TreeHash; problems: HashProblem[] }> {
  const seen = new Map<string, HashedFile>();
  const problems: HashProblem[] = [];
  const realRoot = await realpath(kitDir);

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

  for (const p of relPaths) {
    const rel = canonicalKitPath(p);
    if (rel === undefined) {
      problems.push({ kind: "outside", path: p });
      continue;
    }
    // lstat in walk() catches a symlink at `rel` or below it; realpath catches a symlinked parent.
    const real = await realpathOrUndefined(path.join(kitDir, rel));
    if (real !== undefined && !isInsideDir(realRoot, real)) {
      problems.push({ kind: "outside", path: rel });
      continue;
    }
    await walk(rel);
  }
  const files = [...seen.values()].sort(byPath);
  const manifest = buildManifest(files);
  return { hash: { files, manifest, sha256: sha256Hex(manifest) }, problems };
}
