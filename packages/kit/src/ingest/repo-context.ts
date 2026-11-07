// TDM-34 [4.2]: the material ingest gathers next to a ProjectDigest.
//
// `ProjectDigestSchema` (packages/core) is strict and only holds the summary fields. The
// understander and kit designer also need the raw material behind them: a capped file tree, the
// README, the manifests, where the tests and benchmarks live, and recent commits that touched tests
// (bug-hunt candidates). That material lives here, so the digest contract stays unchanged.
import { ProjectDigestSchema } from "@anybench/core";
import { z } from "zod";

export const RepoTreeDirSchema = z.strictObject({
  path: z.string().min(1),
  files: z.int().min(0),
  bytes: z.int().min(0),
});

export const RepoManifestKindSchema = z.enum([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "Makefile",
  "justfile",
  "CMakeLists.txt",
  "Dockerfile",
  "docker-compose",
  "pnpm-workspace.yaml",
]);
export type RepoManifestKind = z.infer<typeof RepoManifestKindSchema>;

export const RepoManifestSchema = z.strictObject({
  path: z.string().min(1),
  kind: RepoManifestKindSchema,
  /** File text, redacted and capped. */
  text: z.string(),
  truncated: z.boolean(),
});
export type RepoManifest = z.infer<typeof RepoManifestSchema>;

export const RepoPathGroupSchema = z.strictObject({
  /** Number of matching files in the whole tree (not capped). */
  files: z.int().min(0),
  /** Directories holding them, most files first (capped). */
  dirs: z.array(z.string().min(1)),
  /** Some of the files (capped). */
  sample: z.array(z.string().min(1)),
});
export type RepoPathGroup = z.infer<typeof RepoPathGroupSchema>;

export const RepoTestCommitSchema = z.strictObject({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  date: z.iso.datetime({ offset: true }),
  subject: z.string(),
  files_changed: z.int().min(0),
  /** The test files it touched (capped). */
  test_files: z.array(z.string().min(1)),
});
export type RepoTestCommit = z.infer<typeof RepoTestCommitSchema>;

export const RepoContextSchema = z.strictObject({
  tree: z.strictObject({
    /** File paths (noise dirs like node_modules/ and dist/ dropped first), capped. */
    paths: z.array(z.string().min(1)),
    /** Directories with their file counts and bytes, biggest first, capped. */
    dirs: z.array(RepoTreeDirSchema),
    truncated: z.boolean(),
  }),
  readme: z
    .strictObject({
      path: z.string().min(1),
      text: z.string(),
      truncated: z.boolean(),
    })
    .optional(),
  manifests: z.array(RepoManifestSchema),
  tests: RepoPathGroupSchema,
  benchmarks: RepoPathGroupSchema,
  /** How many commits were scanned for `recent_test_commits` (the clone depth bounds it). */
  commits_scanned: z.int().min(0),
  recent_test_commits: z.array(RepoTestCommitSchema),
  /** Files whose blobs were over the clone's size filter, so their size is a lower bound. */
  large_files: z.array(z.string().min(1)),
});
export type RepoContext = z.infer<typeof RepoContextSchema>;

/** What `ingestGitHubRepo` / `ingestLocalRepo` return and what the digest fixtures hold. */
export const RepoIngestSchema = z.strictObject({
  digest: ProjectDigestSchema,
  context: RepoContextSchema,
});
export type RepoIngest = z.infer<typeof RepoIngestSchema>;

/** Every digest fixture (and every ingest result) must serialize under this many bytes. */
export const REPO_INGEST_MAX_BYTES = 200 * 1024;
