// BYOK model keys (plan.md section 9). Write-only: the API never returns a secret value, only
// `last4`. Envelope-encrypted at rest; decrypted only right before a trial. Ticket 7.6.
import { z } from "zod";
import { IsoDateTimeSchema, OkSchema } from "./common.js";
import { defineRoute, defineRoutes } from "./route.js";

/** The model provider a key is for (`anthropic`, `openai`, ...). */
export const SecretProviderSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,31}$/, { error: "provider must be a lowercase slug" });

export const SecretSummarySchema = z.object({
  provider: SecretProviderSchema,
  last4: z.string().length(4),
  created_at: IsoDateTimeSchema,
  last_used_at: IsoDateTimeSchema.nullable(),
});
export type SecretSummary = z.infer<typeof SecretSummarySchema>;

const providerParams = z.object({ provider: SecretProviderSchema });

export const secretRoutes = defineRoutes({
  list: defineRoute({
    id: "secrets.list",
    method: "GET",
    path: "/secrets",
    auth: ["session"],
    summary: "Which model keys are on file (provider and last4 only).",
    response: z.object({ items: z.array(SecretSummarySchema) }),
  }),
  put: defineRoute({
    id: "secrets.put",
    method: "PUT",
    path: "/secrets/:provider",
    auth: ["session"],
    summary: "Store or replace a model key. The value is redacted from every log.",
    params: providerParams,
    body: z.object({ value: z.string().min(8).max(4096) }),
    response: z.object({ secret: SecretSummarySchema }),
  }),
  delete: defineRoute({
    id: "secrets.delete",
    method: "DELETE",
    path: "/secrets/:provider",
    auth: ["session"],
    summary: "Delete a model key. Idempotent.",
    params: providerParams,
    response: OkSchema,
  }),
});
