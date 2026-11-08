// API key routes (TDM-66, plan.md sections 6 and 9; contract apiRoutes.apiKeys in @anybench/core).
// Mounted at /api-keys:
//   GET    /api-keys       the caller's keys (never the secret)
//   POST   /api-keys       create; the `secret` is in this response only, the DB keeps its sha256
//   DELETE /api-keys/:id   revoke (idempotent: revoking twice keeps the first revoked_at)
//
// Session users only: an API key can never list, mint or revoke keys (403). Minting an `admin`
// scope needs the caller to be an admin on this request. run_ids must be the caller's own runs.
// The key prefix follows apiKeyModeFor (ab_live_ only when BILLING_MODE=live).
import {
  API_ERROR_STATUS,
  apiError,
  ApiKeyIdSchema,
  ApiKeyScopeSchema,
  apiRoutes,
  encodeRouteResponse,
  newId,
  parseRouteRequest,
  type ApiErrorCode,
  type ApiKey,
  type RouteResult,
} from "@anybench/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { apiKeys } from "../db/schema/api_keys.js";
import { runs } from "../db/schema/runs.js";
import { scopedDb } from "../db/scoped.js";
import {
  apiKeyDisplayPrefix,
  apiKeyModeFor,
  hashApiKey,
  newApiKeySecret,
  requireSessionActor,
  type ActorEnv,
} from "../lib/auth-key.js";
import type { AppDeps } from "../types.js";

const contract = apiRoutes.apiKeys;

type ApiKeyRow = typeof apiKeys.$inferSelect;

function fail(c: Context<ActorEnv>, code: ApiErrorCode, message: string, issues?: string[]) {
  return c.json(
    apiError(code, message, { request_id: c.get("requestId"), ...(issues ? { issues } : {}) }),
    API_ERROR_STATUS[code] as ContentfulStatusCode,
  );
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** A row as the contract's ApiKey (scopes the contract no longer knows are dropped). */
export function apiKeyView(row: ApiKeyRow): ApiKey {
  return {
    id: row.id as ApiKey["id"],
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes.flatMap((s) => {
      const r = ApiKeyScopeSchema.safeParse(s);
      return r.success ? [r.data] : [];
    }),
    run_ids: (row.runIds ?? null) as ApiKey["run_ids"],
    expires_at: iso(row.expiresAt),
    last_used_at: iso(row.lastUsedAt),
    revoked_at: iso(row.revokedAt),
    created_at: row.createdAt.toISOString(),
  };
}

export function apiKeysRoutes(deps: AppDeps): Hono<ActorEnv> {
  const r = new Hono<ActorEnv>();
  r.use(requireSessionActor(deps));

  r.get("/", async (c) => {
    const actor = c.get("actor");
    const rows = await scopedDb(actor, deps.db).transaction((tx) =>
      tx
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.ownerId, actor.userId))
        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id)),
    );
    const result: RouteResult<typeof contract.list> = { items: rows.map(apiKeyView) };
    return c.json(encodeRouteResponse(contract.list, result) as object, 200);
  });

  r.post("/", async (c) => {
    const actor = c.get("actor");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, "validation_failed", "body must be JSON");
    }
    const parsed = parseRouteRequest(contract.create, { body });
    if (!parsed.ok) {
      return fail(c, "validation_failed", parsed.error.error.message, parsed.error.error.issues);
    }
    const input = parsed.request.body;
    const scopes = [...new Set(input.scopes)];
    if (scopes.includes("admin") && actor.isAdmin !== true) {
      return fail(c, "forbidden", "only an admin can create a key with the admin scope");
    }
    const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return fail(c, "validation_failed", "expires_at must be in the future", [
        "body.expires_at: must be in the future",
      ]);
    }
    const runIds = input.run_ids ? [...new Set(input.run_ids.map((id) => id.toLowerCase()))] : null;

    const secret = newApiKeySecret(apiKeyModeFor(deps.config, input.mode));
    const outcome = await scopedDb(actor, deps.db).transaction(async (tx) => {
      if (runIds) {
        // Through the user's RLS scope: a run that is not theirs is invisible, so it is "unknown".
        const visible = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.ownerId, actor.userId), inArray(runs.id, runIds)));
        const known = new Set(visible.map((v) => v.id.toLowerCase()));
        const unknown = runIds.filter((id) => !known.has(id));
        if (unknown.length > 0) return { ok: false, unknown } as const;
      }
      const [row] = await tx
        .insert(apiKeys)
        .values({
          id: newId(ApiKeyIdSchema),
          ownerId: actor.userId,
          name: input.name,
          prefix: apiKeyDisplayPrefix(secret),
          hash: hashApiKey(secret),
          scopes,
          runIds,
          expiresAt,
        })
        .returning();
      return { ok: true, row: row! } as const;
    });
    if (!outcome.ok) {
      return fail(
        c,
        "validation_failed",
        "run_ids must be your own runs",
        outcome.unknown.map((id) => `body.run_ids: unknown run ${id}`),
      );
    }
    c.get("log").info(
      { apiKeyId: outcome.row.id, scopes, runScoped: runIds !== null },
      "api key created",
    );
    const result: RouteResult<typeof contract.create> = {
      api_key: apiKeyView(outcome.row),
      secret,
    };
    c.header("cache-control", "no-store");
    return c.json(encodeRouteResponse(contract.create, result) as object, 201);
  });

  r.delete("/:id", async (c) => {
    const actor = c.get("actor");
    const parsed = parseRouteRequest(contract.revoke, { params: c.req.param() });
    if (!parsed.ok) {
      return fail(c, "validation_failed", parsed.error.error.message, parsed.error.error.issues);
    }
    const { id } = parsed.request.params;
    const [row] = await scopedDb(actor, deps.db).transaction((tx) =>
      tx
        .update(apiKeys)
        .set({ revokedAt: sql`coalesce(${apiKeys.revokedAt}, now())` })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.ownerId, actor.userId)))
        .returning(),
    );
    if (!row) return fail(c, "not_found", "API key not found");
    c.get("log").info({ apiKeyId: row.id }, "api key revoked");
    const result: RouteResult<typeof contract.revoke> = { api_key: apiKeyView(row) };
    return c.json(encodeRouteResponse(contract.revoke, result) as object, 200);
  });

  return r;
}
