// GitHub scan (plan.md sections 3 and 13, ticket 11.7): run the understander over a user's or
// org's repos and say which are benchable. No compute; only Naïve agent sessions.
import { z } from "zod";
import { NonNegativeMicroUsdSchema } from "../money.js";
import { SubjectKindSchema } from "../schemas/kit-primitives.js";
import { IsoDateTimeSchema, PageQuerySchema, pageOf, uuidSchema } from "./common.js";
import { defineRoute, defineRoutes } from "./route.js";

export const ScanIdSchema = uuidSchema<"ScanId">();

export const ScanRepoSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  status: z.enum(["queued", "running", "done", "failed"]),
  kind: SubjectKindSchema.nullable(),
  summary: z.string().nullable(),
  /** The understander's verdict (plan.md section 11). */
  benchable: z.enum(["ready", "needs_hardware", "skip"]).nullable(),
  reason: z.string().nullable(),
  better_means: z.array(z.string()),
});

export const ScanSchema = z.object({
  id: ScanIdSchema,
  github_owner: z.string().min(1),
  status: z.enum(["queued", "running", "done", "failed"]),
  repos: z.array(ScanRepoSchema),
  cost_micro_usd: NonNegativeMicroUsdSchema,
  created_at: IsoDateTimeSchema,
  finished_at: IsoDateTimeSchema.nullable(),
});
export type Scan = z.infer<typeof ScanSchema>;

const GithubOwnerSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, {
  error: "expected a GitHub user or org name",
});

export const scanRoutes = defineRoutes({
  create: defineRoute({
    id: "scan.create",
    method: "POST",
    path: "/scans",
    auth: ["session", "apiKey:runs:write"],
    summary: "Scan a GitHub user's or org's public repos (or the listed ones).",
    body: z.object({
      github_owner: GithubOwnerSchema,
      repos: z.array(z.string().min(1)).min(1).max(100).optional(),
      max_repos: z.int().min(1).max(100).default(20),
    }),
    status: 201,
    response: z.object({ scan: ScanSchema }),
  }),
  list: defineRoute({
    id: "scan.list",
    method: "GET",
    path: "/scans",
    auth: ["session", "apiKey:runs:read"],
    summary: "The caller's scans, newest first.",
    query: PageQuerySchema,
    response: pageOf(ScanSchema),
  }),
  get: defineRoute({
    id: "scan.get",
    method: "GET",
    path: "/scans/:id",
    auth: ["session", "apiKey:runs:read"],
    summary: "One scan with a verdict per repo.",
    params: z.object({ id: ScanIdSchema }),
    response: z.object({ scan: ScanSchema }),
  }),
});
