// ProjectDigest: what ingest learned about the project, before any agent writes a kit (plan.md P2).
import { z } from "zod";
import { DriverTypeSchema } from "./contender.js";
import { KitSha256Schema, SubjectKindSchema } from "./kit-primitives.js";

export const DigestSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("github"),
    url: z.url({ hostname: /^github\.com$/ }),
    ref: z.string().min(1),
    /** Resolved commit sha at ingest time. */
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/, { error: "must be a 40-char lowercase git sha" })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("binary"),
    url: z.url().optional(),
    upload_id: z.string().min(1).optional(),
    sha256: KitSha256Schema,
    docs: z.array(z.string().min(1)).default([]),
  }),
  z.strictObject({
    kind: z.literal("claude-code-setup"),
    /** Files found, e.g. `CLAUDE.md`, `.claude/agents/x.md`, `.mcp.json`. */
    files: z.array(z.string().min(1)).min(1),
  }),
]);
export type DigestSource = z.infer<typeof DigestSourceSchema>;

export const DigestLanguageSchema = z.strictObject({
  name: z.string().min(1),
  bytes: z.int().min(0),
});

export const DigestEntrypointSchema = z.strictObject({
  kind: z.enum(["bin", "script", "service", "library", "agent", "web", "other"]),
  name: z.string().min(1),
  command: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
});
export type DigestEntrypoint = z.infer<typeof DigestEntrypointSchema>;

export const DigestClaudeCodeSchema = z.strictObject({
  claude_md: z.boolean(),
  agents: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  commands: z.array(z.string()).default([]),
  mcp_servers: z.array(z.string()).default([]),
});

export const ProjectDigestSchema = z.strictObject({
  source: DigestSourceSchema,
  name: z.string().min(1),
  /** Ingest's guess; the understander agent confirms or corrects it. */
  kind: SubjectKindSchema,
  summary: z.string().min(1),
  languages: z.array(DigestLanguageSchema).default([]),
  entrypoints: z.array(DigestEntrypointSchema).default([]),
  build_commands: z.array(z.string().min(1)).default([]),
  test_commands: z.array(z.string().min(1)).default([]),
  /** Docs paths or URLs worth reading (README, docs/, man pages). */
  docs: z.array(z.string().min(1)).default([]),
  claude_code: DigestClaudeCodeSchema.optional(),
  releases: z
    .strictObject({
      latest: z.string().min(1).optional(),
      tags: z.array(z.string().min(1)).default([]),
    })
    .default({ tags: [] }),
  files: z.strictObject({
    count: z.int().min(0),
    total_bytes: z.int().min(0),
  }),
  /** Driver types that look plausible from the entrypoints, most likely first. */
  suggested_driver_types: z.array(DriverTypeSchema).default([]),
  ingested_at: z.iso.datetime({ offset: true }),
  /** sha256 of the ingested tree or binary; the digest's cache key. */
  hash: KitSha256Schema,
});
export type ProjectDigest = z.infer<typeof ProjectDigestSchema>;
export type ProjectDigestInput = z.input<typeof ProjectDigestSchema>;
