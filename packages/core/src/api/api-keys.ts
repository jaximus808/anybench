// API key routes (plan.md sections 6 and 9). Session only: a key can never mint another key.
// Ticket 7.2 implements them.
import { z } from "zod";
import { ApiKeyIdSchema, RunIdSchema } from "../ids.js";
import { IsoDateTimeSchema } from "./common.js";
import { ApiKeyScopeSchema, defineRoute, defineRoutes } from "./route.js";

export const API_KEY_PREFIXES = ["ab_live_", "ab_test_"] as const;

export const ApiKeySchema = z.object({
  id: ApiKeyIdSchema,
  name: z.string().min(1),
  /** The visible prefix, e.g. `ab_live_3f9a`. The full key is shown once, at creation. */
  prefix: z.string().min(1),
  scopes: z.array(ApiKeyScopeSchema).min(1),
  /** null = every run the owner has. */
  run_ids: z.array(RunIdSchema).nullable(),
  expires_at: IsoDateTimeSchema.nullable(),
  last_used_at: IsoDateTimeSchema.nullable(),
  revoked_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const CreateApiKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(ApiKeyScopeSchema).min(1),
  /** Limit the key to these runs (e.g. a run-scoped read key for a Tandem worker). */
  run_ids: z.array(RunIdSchema).min(1).optional(),
  expires_at: IsoDateTimeSchema.optional(),
  /** `test` keys (`ab_test_`) only see Stripe test-mode billing. Default `live`. */
  mode: z.enum(["live", "test"]).default("live"),
});

const idParams = z.object({ id: ApiKeyIdSchema });

export const apiKeyRoutes = defineRoutes({
  list: defineRoute({
    id: "apiKeys.list",
    method: "GET",
    path: "/api-keys",
    auth: ["session"],
    summary: "The caller's API keys (never the secret).",
    response: z.object({ items: z.array(ApiKeySchema) }),
  }),
  create: defineRoute({
    id: "apiKeys.create",
    method: "POST",
    path: "/api-keys",
    auth: ["session"],
    summary: "Create a scoped key. `secret` is returned once and stored only as a sha256 hash.",
    body: CreateApiKeyBodySchema,
    status: 201,
    response: z.object({
      api_key: ApiKeySchema,
      secret: z.string().regex(/^ab_(live|test)_[A-Za-z0-9_-]{16,}$/),
    }),
  }),
  revoke: defineRoute({
    id: "apiKeys.revoke",
    method: "DELETE",
    path: "/api-keys/:id",
    auth: ["session"],
    summary: "Revoke a key. Idempotent.",
    params: idParams,
    response: z.object({ api_key: ApiKeySchema }),
  }),
});
