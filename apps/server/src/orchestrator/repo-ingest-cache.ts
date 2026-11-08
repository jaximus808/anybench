// TDM-56 [6.2]: the repo context next to a run's digest, for the agent stages.
//
// projects.digest stores only the ProjectDigest; the understander (and TDM-60's kit designer) also
// need what ingest gathered around it (README, tree, manifests, test paths, test commits: the
// RepoContext). githubIngest writes the whole RepoIngest (serializeRepoIngest: already redacted
// and capped at 200 KB by ingest) to `<dir>/<digest hash>.json`, where dir defaults to
// `~/.anybench/ingest` (a sibling of the generated-kits root). `loadRepoIngest` reads it back and,
// on a miss (another worker ingested it, or the digest predates the cache), re-ingests the same
// commit and caches the result.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ProjectDigest } from "@anybench/core";
import {
  IngestError,
  ingestGitHubRepo,
  RepoIngestSchema,
  serializeRepoIngest,
  type GitHubIngestOptions,
  type RepoIngest,
} from "@anybench/kit";
import { z } from "zod";

export const DEFAULT_INGEST_CACHE_SUBDIR = path.join(".anybench", "ingest");

const DigestHashSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a sha256 hex digest hash");

/** The ingest cache dir: the override, else ~/.anybench/ingest. */
export function repoIngestCacheDir(override?: string): string {
  return override ? path.resolve(override) : path.join(homedir(), DEFAULT_INGEST_CACHE_SUBDIR);
}

/** `<dir>/<digest hash>.json`. The hash is validated, so it can never escape the dir. */
export function repoIngestCachePath(hash: string, dir?: string): string {
  return path.join(repoIngestCacheDir(dir), `${DigestHashSchema.parse(hash)}.json`);
}

/** Write one ingest result under its digest hash (atomic: temp file + rename). */
export async function writeRepoIngestCache(
  ingest: RepoIngest,
  opts: { dir?: string } = {},
): Promise<string> {
  const file = repoIngestCachePath(ingest.digest.hash, opts.dir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, serializeRepoIngest(ingest), { mode: 0o600 });
  await rename(tmp, file);
  return file;
}

/** The cached ingest for a digest hash, or null (missing, unreadable or invalid). */
export async function readRepoIngestCache(
  hash: string,
  opts: { dir?: string } = {},
): Promise<RepoIngest | null> {
  let raw: string;
  try {
    raw = await readFile(repoIngestCachePath(hash, opts.dir), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = RepoIngestSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.digest.hash === hash ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface LoadRepoIngestOptions {
  dir?: string;
  githubToken?: string;
  /** Re-ingest on a miss (tests inject a fake). Default ingestGitHubRepo. */
  ingest?: (input: string, opts: GitHubIngestOptions) => Promise<RepoIngest>;
}

export type LoadedRepoIngest =
  | { ingest: RepoIngest; from: "cache" | "ingest" }
  | { ingest: null; from: "unavailable"; why: string };

/**
 * The RepoIngest behind a digest: the cache, else a re-ingest of the digest's commit (cached on the
 * way out). A source that is not GitHub, or a re-ingest that fails with an IngestError, is
 * `unavailable` (the stage then works from the digest alone); other errors throw.
 */
export async function loadRepoIngest(
  digest: ProjectDigest,
  opts: LoadRepoIngestOptions = {},
): Promise<LoadedRepoIngest> {
  const cached = await readRepoIngestCache(digest.hash, { ...(opts.dir ? { dir: opts.dir } : {}) });
  if (cached) return { ingest: cached, from: "cache" };
  if (digest.source.kind !== "github") {
    return {
      ingest: null,
      from: "unavailable",
      why: `a ${digest.source.kind} source has no repo context`,
    };
  }
  const ref = digest.source.commit ?? digest.source.ref;
  const ingest = opts.ingest ?? ingestGitHubRepo;
  let result: RepoIngest;
  try {
    result = await ingest(`${digest.source.url}#${ref}`, {
      ...(opts.githubToken ? { githubToken: opts.githubToken } : {}),
    });
  } catch (err) {
    if (err instanceof IngestError) {
      return { ingest: null, from: "unavailable", why: `re-ingest failed: ${err.code}` };
    }
    throw err;
  }
  try {
    await writeRepoIngestCache(result, { ...(opts.dir ? { dir: opts.dir } : {}) });
  } catch {
    // A cache we cannot write only costs a re-ingest next time.
  }
  return { ingest: result, from: "ingest" };
}
