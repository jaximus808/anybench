// TDM-218 [19.2]: a kit's files as a directory on this worker, whatever `kits.files_url` says.
//
//   file://<dir>        a generated or curated kit on the worker host: the directory itself.
//   artifact:<key>      an uploaded kit (TDM-217): the validated tarball in the artifact store,
//                       read back and unpacked with the same checks the upload passed (no symlink,
//                       no path outside the kit, the size and entry caps), into a cache directory
//                       keyed by the artifact key. The tarball under kits/files/ is written once by
//                       the server and never changes, so a key that is already unpacked is reused.
//
// env_build, proof and the trial gate all read the kit from disk; they ask here first, so an
// uploaded kit goes through exactly the same env build, six proof checks and gates as ours.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_UPLOAD_LIMITS } from "@anybench/core";
import { readKitArchive } from "../lib/kit-upload/archive.js";
import { writeKitArchive } from "../lib/kit-upload/extract.js";
import { KIT_FILES_URL_SCHEME, kitFilesKeyOf, type KitFileStore } from "../lib/kit-upload/store.js";

export const ARTIFACT_KIT_SCHEME = KIT_FILES_URL_SCHEME;

export interface KitArtifactSource {
  /** The bytes stored at `key` (an uploaded kit's .tar.gz), or null when it is gone. */
  read(key: string): Promise<Uint8Array | null>;
  /** Unpack a kit tarball into `dir` (empty), refusing anything unsafe. Throws on a bad archive. */
  unpack(bytes: Uint8Array, dir: string): Promise<void>;
}

export interface KitDirOptions {
  /** Where uploaded kits are unpacked; default `<tmpdir>/anybench-kits`. */
  cacheDir?: string;
  /** How to fetch and unpack an `artifact:` kit; null when no artifact store is configured. */
  artifacts?: KitArtifactSource | null;
}

export type KitDirResult = { ok: true; dir: string } | { ok: false; reason: string };

const DONE_MARKER = ".anybench-unpacked";

/** The artifact-store key of an uploaded kit's `files_url` (kits/files/ only), or null. */
export function artifactKitKey(filesUrl: string | null | undefined): string | null {
  return kitFilesKeyOf(filesUrl);
}

/**
 * The production source: the kit file store (the envs ArtifactStore on R2) for the bytes, then
 * TDM-217's reader and writer, the same checks the upload passed (KIT_UPLOAD_LIMITS, no links,
 * no path outside the kit, a wrapping directory stripped).
 */
export function kitArtifactSource(store: Pick<KitFileStore, "getKitFiles">): KitArtifactSource {
  return {
    read: (key) => store.getKitFiles(key, KIT_UPLOAD_LIMITS.maxBytes),
    unpack: async (bytes, dir) => writeKitArchive(readKitArchive(bytes), dir),
  };
}

/**
 * The kit's files on this worker. `{ok: false}` says why there are none (no files_url, an unknown
 * scheme, no artifact store); a read or unpack failure throws (the stage retries or holds).
 */
export async function localKitDir(
  filesUrl: string | null | undefined,
  opts: KitDirOptions = {},
): Promise<KitDirResult> {
  if (!filesUrl) return { ok: false, reason: "the kit has no files (kits.files_url is empty)" };
  if (filesUrl.startsWith("file://")) return { ok: true, dir: fileURLToPath(filesUrl) };
  const key = artifactKitKey(filesUrl);
  if (!key) {
    return { ok: false, reason: `kits.files_url ${filesUrl} is neither file:// nor artifact:` };
  }
  if (!opts.artifacts) {
    return {
      ok: false,
      reason: `the kit's files are in the artifact store (${key}) and none is configured (R2_* / S3_*)`,
    };
  }
  const root = path.resolve(opts.cacheDir ?? path.join(tmpdir(), "anybench-kits"));
  const target = path.join(root, createHash("sha256").update(key).digest("hex").slice(0, 32));
  if (existsSync(path.join(target, DONE_MARKER))) return { ok: true, dir: target };

  await mkdir(root, { recursive: true, mode: 0o700 });
  const bytes = await opts.artifacts.read(key);
  if (!bytes)
    return { ok: false, reason: `the kit's files (${key}) are not in the artifact store` };
  const work = await mkdtemp(path.join(root, ".unpack-"));
  try {
    await opts.artifacts.unpack(bytes, work);
    await writeFile(path.join(work, DONE_MARKER), `${key}\n`, { flag: "wx" });
    // A target with no marker is not ours to trust (rename always moves the marker with it).
    if (existsSync(target) && !existsSync(path.join(target, DONE_MARKER))) {
      await rm(target, { recursive: true, force: true });
    }
    try {
      await rename(work, target);
    } catch (err) {
      // Another stage unpacked the same key first: theirs is identical, keep it.
      if (!existsSync(path.join(target, DONE_MARKER))) throw err;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { ok: true, dir: target };
}

/**
 * The worker's resolver: file:// kits as they are, uploaded kits from `store` (the envs
 * ArtifactStore when S3_* / R2 is configured; null holds an uploaded kit with the reason).
 */
export function workerKitDir(
  store: Pick<KitFileStore, "getKitFiles"> | null,
  opts: Pick<KitDirOptions, "cacheDir"> = {},
): (filesUrl: string | null | undefined) => Promise<KitDirResult> {
  const artifacts = store ? kitArtifactSource(store) : null;
  return (filesUrl) => localKitDir(filesUrl, { ...opts, artifacts });
}
