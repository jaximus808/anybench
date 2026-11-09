// BYOK model key routes (plan.md "Customer model keys"; contract apiRoutes.secrets in
// @anybench/core; TDM-224 wires them for onboarding and Settings). Mounted at /secrets:
//   GET    /secrets            which keys are on file: provider, last4, created_at, last_used_at
//   PUT    /secrets/:provider  store or replace a key, sealed with lib/byok.ts (AES-256-GCM, a
//                              fresh DEK wrapped by ANYBENCH_KEK); answers the summary only
//   DELETE /secrets/:provider  delete; idempotent
//
// Write-only: no route ever returns a value, and the request body is never logged. Session users
// only (an API key gets 403). Every read and write goes through scopedDb(actor), so RLS
// (user_secrets_tenant) keeps a user to their own rows. Without ANYBENCH_KEK the PUT answers 503:
// nothing could decrypt a key stored without it.
import {
  API_ERROR_STATUS,
  apiError,
  apiRoutes,
  encodeRouteResponse,
  parseRouteRequest,
  type ApiErrorCode,
  type RouteResult,
  type SecretSummary,
} from "@anybench/core";
import { and, asc, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { userSecrets } from "../db/schema/user_secrets.js";
import { scopedDb } from "../db/scoped.js";
import { requireSessionActor, type ActorEnv } from "../lib/auth-key.js";
import { ByokError, sealSecret } from "../lib/byok.js";
import type { AppDeps } from "../types.js";

const contract = apiRoutes.secrets;

function fail(c: Context<ActorEnv>, code: ApiErrorCode, message: string, issues?: string[]) {
  return c.json(
    apiError(code, message, { request_id: c.get("requestId"), ...(issues ? { issues } : {}) }),
    API_ERROR_STATUS[code] as ContentfulStatusCode,
  );
}

type SecretRow = Pick<
  typeof userSecrets.$inferSelect,
  "provider" | "last4" | "createdAt" | "lastUsedAt"
>;

function view(row: SecretRow): SecretSummary {
  return {
    provider: row.provider,
    last4: row.last4,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

const SUMMARY_COLUMNS = {
  provider: userSecrets.provider,
  last4: userSecrets.last4,
  createdAt: userSecrets.createdAt,
  lastUsedAt: userSecrets.lastUsedAt,
};

export function secretsRoutes(deps: AppDeps): Hono<ActorEnv> {
  const r = new Hono<ActorEnv>();
  r.use(requireSessionActor(deps));

  r.get("/", async (c) => {
    const actor = c.get("actor");
    const rows = await scopedDb(actor, deps.db).transaction((tx) =>
      tx
        .select(SUMMARY_COLUMNS)
        .from(userSecrets)
        .where(eq(userSecrets.ownerId, actor.userId))
        .orderBy(asc(userSecrets.provider)),
    );
    const result: RouteResult<typeof contract.list> = { items: rows.map(view) };
    c.header("cache-control", "no-store");
    return c.json(encodeRouteResponse(contract.list, result) as object, 200);
  });

  r.put("/:provider", async (c) => {
    const actor = c.get("actor");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, "validation_failed", "body must be JSON");
    }
    const parsed = parseRouteRequest(contract.put, { params: c.req.param(), body });
    if (!parsed.ok) {
      return fail(c, "validation_failed", parsed.error.error.message, parsed.error.error.issues);
    }
    const kek = deps.config.ANYBENCH_KEK;
    if (!kek) return fail(c, "unavailable", "model keys are not configured on this deployment");
    const { provider } = parsed.request.params;
    let sealed;
    try {
      sealed = sealSecret({
        kek,
        ownerId: actor.userId,
        provider,
        plaintext: parsed.request.body.value.trim(),
      });
    } catch (err) {
      if (err instanceof ByokError) return fail(c, "validation_failed", err.message);
      throw err;
    }
    const [row] = await scopedDb(actor, deps.db).transaction((tx) =>
      tx
        .insert(userSecrets)
        .values({ ownerId: actor.userId, provider, ...sealed })
        .onConflictDoUpdate({
          target: [userSecrets.ownerId, userSecrets.provider],
          set: { ...sealed, updatedAt: new Date() },
        })
        .returning(SUMMARY_COLUMNS),
    );
    c.get("log").info({ provider }, "model key stored");
    const result: RouteResult<typeof contract.put> = { secret: view(row!) };
    c.header("cache-control", "no-store");
    return c.json(encodeRouteResponse(contract.put, result) as object, 200);
  });

  r.delete("/:provider", async (c) => {
    const actor = c.get("actor");
    const parsed = parseRouteRequest(contract.delete, { params: c.req.param() });
    if (!parsed.ok) {
      return fail(c, "validation_failed", parsed.error.error.message, parsed.error.error.issues);
    }
    const { provider } = parsed.request.params;
    await scopedDb(actor, deps.db).transaction((tx) =>
      tx
        .delete(userSecrets)
        .where(and(eq(userSecrets.ownerId, actor.userId), eq(userSecrets.provider, provider))),
    );
    c.get("log").info({ provider }, "model key deleted");
    return c.json(encodeRouteResponse(contract.delete, { ok: true }) as object, 200);
  });

  return r;
}
