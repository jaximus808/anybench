// Publish routes (plan.md P5): signed attestation, public page, badge, embed, oEmbed, keys.
// Tickets 12.1–12.10. Only a delivered run whose six proof checks all passed can be published
// (409 `conflict` otherwise); every contender and workload is always included.
import { z } from "zod";
import { ContenderIdSchema, PublishedBenchmarkIdSchema, RunIdSchema } from "../ids.js";
import { KitSha256Schema, SubjectKindSchema } from "../schemas/kit-primitives.js";
import { IsoDateTimeSchema, PageQuerySchema, pageOf } from "./common.js";
import { ProofCheckNameSchema } from "./kits.js";
import { ReportSchema } from "./reports.js";
import { defineRoute, defineRoutes } from "./route.js";

export const PublishSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, { error: "slug: 3-64 of a-z, 0-9 and '-'" });

export const PUBLISH_VISIBILITIES = ["public", "unlisted", "withdrawn"] as const;
export const PublishVisibilitySchema = z.enum(PUBLISH_VISIBILITIES);

/** The canonical JSON that is signed with Ed25519 (plan.md P5). */
export const AttestationSchema = z.object({
  v: z.literal(1),
  benchmark_id: PublishedBenchmarkIdSchema,
  slug: PublishSlugSchema,
  version: z.int().positive(),
  run_id: RunIdSchema,
  kit_hash: KitSha256Schema,
  contenders: z.array(
    z.object({
      contender_id: ContenderIdSchema,
      name: z.string(),
      version: z.string().nullable(),
      snapshot_hash: z.string().nullable(),
      score: z.number().min(0).max(100).nullable(),
      ci95: z.tuple([z.number(), z.number()]).nullable(),
    }),
  ),
  trial_count: z.int().nonnegative(),
  proof: z.array(z.object({ check: ProofCheckNameSchema, pass: z.boolean() })),
  comped: z.boolean(),
  created_at: IsoDateTimeSchema,
});
export type Attestation = z.infer<typeof AttestationSchema>;

export const PublishVersionSchema = z.object({
  version: z.int().positive(),
  /** `held`: a rerun regressed and waits for the owner's review before it is public. */
  status: z.enum(["live", "held"]),
  report: ReportSchema,
  attestation: AttestationSchema,
  /** base64url Ed25519 signature over the canonical attestation JSON. */
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/),
  key_id: z.string().min(1),
  created_at: IsoDateTimeSchema,
});
export type PublishVersion = z.infer<typeof PublishVersionSchema>;

export const PublishedBenchmarkSchema = z.object({
  id: PublishedBenchmarkIdSchema,
  owner: z.string().min(1),
  slug: PublishSlugSchema,
  run_id: RunIdSchema,
  title: z.string(),
  kind: SubjectKindSchema,
  visibility: PublishVisibilitySchema,
  latest_version: z.int().positive(),
  pinned_version: z.int().positive().nullable(),
  auto_publish: z.boolean(),
  page_url: z.url(),
  badge_url: z.url(),
  embed_url: z.url(),
  created_at: IsoDateTimeSchema,
});
export type PublishedBenchmark = z.infer<typeof PublishedBenchmarkSchema>;

export const BADGE_VARIANTS = ["score", "verdict", "rank"] as const;
export const EMBED_THEMES = ["light", "dark", "auto"] as const;

export const SigningKeySchema = z.object({
  key_id: z.string().min(1),
  alg: z.literal("Ed25519"),
  /** base64url raw 32-byte public key. */
  public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  created_at: IsoDateTimeSchema,
  retired_at: IsoDateTimeSchema.nullable(),
});

const benchmarkParams = z.object({ id: PublishedBenchmarkIdSchema });
const benchmarkResponse = z.object({ benchmark: PublishedBenchmarkSchema });

export const publishRoutes = defineRoutes({
  publish: defineRoute({
    id: "publish.publish",
    method: "POST",
    path: "/runs/:id/publish",
    auth: ["session", "apiKey:publish:write"],
    summary: "Freeze the report into a signed version 1 (or the next version) of a benchmark.",
    params: z.object({ id: RunIdSchema }),
    body: z.object({
      slug: PublishSlugSchema,
      visibility: z.enum(["public", "unlisted"]).default("public"),
      /** On "rerun on next release": publish new versions without review. Default review first. */
      auto_publish: z.boolean().default(false),
    }),
    status: 201,
    response: z.object({ benchmark: PublishedBenchmarkSchema, version: PublishVersionSchema }),
  }),
  list: defineRoute({
    id: "publish.list",
    method: "GET",
    path: "/published",
    auth: ["session", "apiKey:runs:read"],
    summary: "The caller's published benchmarks.",
    query: PageQuerySchema,
    response: pageOf(PublishedBenchmarkSchema),
  }),
  update: defineRoute({
    id: "publish.update",
    method: "PATCH",
    path: "/published/:id",
    auth: ["session", "apiKey:publish:write"],
    summary: "Change visibility (public/unlisted), pin a version, or toggle auto-publish.",
    params: benchmarkParams,
    body: z.object({
      visibility: z.enum(["public", "unlisted"]).optional(),
      pinned_version: z.int().positive().nullable().optional(),
      auto_publish: z.boolean().optional(),
    }),
    response: benchmarkResponse,
  }),
  unpublish: defineRoute({
    id: "publish.unpublish",
    method: "POST",
    path: "/published/:id/unpublish",
    auth: ["session", "apiKey:publish:write"],
    summary: "Withdraw: the badge then reads 'withdrawn'; it never silently disappears.",
    params: benchmarkParams,
    response: benchmarkResponse,
  }),
  releaseVersion: defineRoute({
    id: "publish.releaseVersion",
    method: "POST",
    path: "/published/:id/versions/:version/release",
    auth: ["session", "apiKey:publish:write"],
    summary: "Make a held (regressed) version public after review.",
    params: z.object({
      id: PublishedBenchmarkIdSchema,
      version: z.coerce.number().int().positive(),
    }),
    response: z.object({ benchmark: PublishedBenchmarkSchema, version: PublishVersionSchema }),
  }),
  analytics: defineRoute({
    id: "publish.analytics",
    method: "GET",
    path: "/published/:id/analytics",
    auth: ["session"],
    summary: "Views and clicks per embed, badge and page, by day and referrer host.",
    params: benchmarkParams,
    query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
    response: z.object({
      items: z.array(
        z.object({
          day: z.iso.date(),
          kind: z.enum(["badge", "embed", "page"]),
          referrer_host: z.string().nullable(),
          count: z.int().nonnegative(),
        }),
      ),
    }),
  }),
  page: defineRoute({
    id: "publish.page",
    method: "GET",
    path: "/public/benchmarks/:owner/:slug",
    auth: ["public"],
    summary: "Public benchmark page data: the latest (or pinned, or ?version=) signed version.",
    params: z.object({ owner: z.string().min(1).max(100), slug: PublishSlugSchema }),
    query: z.object({ version: z.coerce.number().int().positive().optional() }),
    response: z.object({
      benchmark: PublishedBenchmarkSchema,
      version: PublishVersionSchema,
      versions: z.array(z.object({ version: z.int().positive(), created_at: IsoDateTimeSchema })),
    }),
  }),
  gallery: defineRoute({
    id: "publish.gallery",
    method: "GET",
    path: "/public/benchmarks",
    auth: ["public"],
    summary: "Public benchmarks for /benchmarks, filterable by kind.",
    query: PageQuerySchema.extend({ kind: SubjectKindSchema.optional() }),
    response: pageOf(PublishedBenchmarkSchema),
  }),
  embed: defineRoute({
    id: "publish.embed",
    method: "GET",
    path: "/public/embed/:slug",
    auth: ["public"],
    summary: "The payload the /embed/<slug> iframe renders (table or chart).",
    params: z.object({ slug: PublishSlugSchema }),
    query: z.object({
      theme: z.enum(EMBED_THEMES).default("auto"),
      version: z.coerce.number().int().positive().optional(),
    }),
    response: z.object({
      slug: PublishSlugSchema,
      title: z.string(),
      answer: z.string(),
      version: z.int().positive(),
      withdrawn: z.boolean(),
      rows: z.array(
        z.object({
          name: z.string(),
          role: z.string(),
          score: z.number().min(0).max(100).nullable(),
        }),
      ),
      page_url: z.url(),
    }),
  }),
  badge: defineRoute({
    id: "publish.badge",
    method: "GET",
    path: "/badge/:file",
    auth: ["public"],
    summary: "SVG badge (`/badge/<slug>.svg`), edge-cached. Reads 'withdrawn' when unpublished.",
    params: z.object({
      file: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]\.svg$/, {
        error: "expected <slug>.svg",
      }),
    }),
    query: z.object({
      variant: z.enum(BADGE_VARIANTS).default("score"),
      version: z.coerce.number().int().positive().optional(),
    }),
    kind: "text",
    response: z.string(),
  }),
  keys: defineRoute({
    id: "publish.keys",
    method: "GET",
    path: "/.well-known/anybench-keys.json",
    auth: ["public"],
    summary: "Ed25519 public keys that verify attestations.",
    response: z.object({ keys: z.array(SigningKeySchema) }),
  }),
  oembed: defineRoute({
    id: "publish.oembed",
    method: "GET",
    path: "/oembed",
    auth: ["public"],
    summary: "oEmbed for /b/<owner>/<slug> and /embed/<slug> URLs (Notion, Ghost, Medium).",
    query: z.object({
      url: z.url(),
      format: z.literal("json").default("json"),
      maxwidth: z.coerce.number().int().positive().optional(),
      maxheight: z.coerce.number().int().positive().optional(),
    }),
    response: z.object({
      type: z.literal("rich"),
      version: z.literal("1.0"),
      title: z.string(),
      provider_name: z.literal("Anybench"),
      provider_url: z.url(),
      html: z.string(),
      width: z.int().positive(),
      height: z.int().positive(),
      thumbnail_url: z.url().optional(),
    }),
  }),
});

/** The slug in a badge file name (`tandem.svg` → `tandem`). */
export function badgeSlug(file: string): string {
  return file.replace(/\.svg$/, "");
}
