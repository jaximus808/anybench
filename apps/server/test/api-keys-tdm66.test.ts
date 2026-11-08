// TDM-66 [7.2]: scoped API keys (shown once, sha256-only storage, Bearer auth, scopes, run_ids,
// revoke, expiry, last_used_at throttle, admin scope) against a fresh local Postgres.
import { createHash } from "node:crypto";
import type { RunId } from "@anybench/core";
import { eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiKeys } from "../src/db/schema/api_keys.js";
import { runs } from "../src/db/schema/runs.js";
import { users } from "../src/db/schema/users.js";
import {
  apiKeyOrSessionAuthenticator,
  bearerApiKey,
  hashApiKey,
  isApiKeySecret,
  memoizeAuthenticate,
  newApiKeySecret,
  requireScope,
  type ActorEnv,
} from "../src/lib/auth-key.js";
import { appendEvents } from "../src/lib/events.js";
import { createSession } from "../src/lib/session.js";
import { authAppTdm65, fakeGitHubTdm65, WEB_ORIGIN_TDM65 } from "./helpers/auth-tdm65.js";
import { messageEventTdm72 } from "./helpers/events-tdm72.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const hasDb = await pgAvailableTdm11();

describe("api key helpers (TDM-66)", () => {
  it("mints ab_live_/ab_test_ secrets with 32 random bytes and hashes them with sha256", () => {
    const live = newApiKeySecret("live");
    const test = newApiKeySecret("test");
    expect(live).toMatch(/^ab_live_[A-Za-z0-9_-]{43}$/);
    expect(test).toMatch(/^ab_test_[A-Za-z0-9_-]{43}$/);
    expect(newApiKeySecret("test")).not.toBe(test);
    expect(hashApiKey(live)).toBe(createHash("sha256").update(live).digest("hex"));
    expect(isApiKeySecret(live)).toBe(true);
    expect(isApiKeySecret("ab_live_short")).toBe(false);
  });

  it("reads only `Bearer ab_…` authorization headers", () => {
    expect(bearerApiKey("Bearer ab_test_xyz")).toBe("ab_test_xyz");
    expect(bearerApiKey("bearer ab_live_xyz ")).toBe("ab_live_xyz");
    expect(bearerApiKey("Bearer runner-token")).toBeUndefined();
    expect(bearerApiKey("Basic ab_test_xyz")).toBeUndefined();
    expect(bearerApiKey(null)).toBeUndefined();
  });

  it("memoizeAuthenticate resolves each Request once", async () => {
    let calls = 0;
    const auth = memoizeAuthenticate(async () => {
      calls++;
      return null;
    });
    const req = new Request("http://x/");
    await auth(req);
    await auth(req);
    await auth(new Request("http://x/"));
    expect(calls).toBe(2);
  });
});

describe.skipIf(!hasDb)("api key routes and Bearer auth (TDM-66)", () => {
  let fresh: FreshDbTdm11;
  let h: ReturnType<typeof authAppTdm65>;
  let live: ReturnType<typeof authAppTdm65>;
  let noAdmins: ReturnType<typeof authAppTdm65>;
  const github = fakeGitHubTdm65({});

  let owner: { id: string; token: string };
  let admin: { id: string; token: string };
  let other: { id: string; token: string };
  let runX: string;
  let runY: string;
  let foreignRun: string;
  let githubId = 66_000;

  async function seedUser(login: string) {
    const [u] = await fresh.db
      .insert(users)
      .values({ githubLogin: login, githubId: githubId++ })
      .returning();
    const { token } = await createSession(fresh.db, u!.id);
    return { id: u!.id, token };
  }

  async function seedRun(ownerId: string) {
    const [r] = await fresh.db
      .insert(runs)
      .values({ ownerId, question: "faster?", budgetMicroUsd: 1_000_000n, state: "running" })
      .returning();
    return r!.id;
  }

  /** Extra routes on the real app (after CSRF) to exercise requireScope with writes and admin. */
  function addGuardedRoutes(app: ReturnType<typeof authAppTdm65>) {
    const deps = {
      authenticate: memoizeAuthenticate(
        apiKeyOrSessionAuthenticator({ db: app.dbh.db, config: app.config }),
      ),
    };
    const ok = (c: Context<ActorEnv>) => c.json({ ok: true, via: c.get("actor").via ?? null });
    app.app.post(
      "/tdm66/runs/:id/cancel",
      requireScope(deps, "runs:write", { runIdParam: "id" }),
      ok,
    );
    app.app.get("/tdm66/admin", requireScope(deps, "admin"), ok);
  }

  const session = (token: string, extra: Record<string, string> = {}) => ({
    cookie: `anybench_session=${token}`,
    origin: WEB_ORIGIN_TDM65,
    ...extra,
  });
  const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

  async function createKey(
    body: Record<string, unknown>,
    token = owner.token,
    app = h.app,
  ): Promise<Response> {
    return app.request("/api-keys", {
      method: "POST",
      headers: { ...session(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function mint(body: Record<string, unknown>, token = owner.token, app = h.app) {
    const res = await createKey(body, token, app);
    expect(res.status).toBe(201);
    return (await res.json()) as {
      api_key: { id: string; prefix: string; scopes: string[]; run_ids: string[] | null } & Record<
        string,
        unknown
      >;
      secret: string;
    };
  }

  beforeAll(async () => {
    fresh = await freshMigratedDbTdm11();
    h = authAppTdm65(fresh.url, github);
    live = authAppTdm65(fresh.url, github, { BILLING_MODE: "live" });
    noAdmins = authAppTdm65(fresh.url, github, { ADMIN_GITHUB_LOGINS: "" });
    for (const app of [h, live, noAdmins]) addGuardedRoutes(app);
    owner = await seedUser("tdm66-owner");
    admin = await seedUser("jaximus808");
    other = await seedUser("tdm66-other");
    runX = await seedRun(owner.id);
    runY = await seedRun(owner.id);
    foreignRun = await seedRun(other.id);
    await appendEvents(fresh.db, runX as RunId, [
      messageEventTdm72(runX, 1),
      messageEventTdm72(runX, 2),
    ]);
  }, 60_000);
  afterAll(async () => {
    for (const app of [h, live, noAdmins]) await app?.dbh.close();
    await fresh?.drop();
  });

  it("shows the secret once and stores only its sha256 and a short prefix", async () => {
    const { api_key, secret } = await mint({ name: "cli", scopes: ["runs:read"] });
    // BILLING_MODE defaults to test: even a requested live key is ab_test_.
    expect(secret).toMatch(/^ab_test_[A-Za-z0-9_-]{43}$/);
    expect(api_key.prefix).toBe(secret.slice(0, 14));
    expect(api_key).not.toHaveProperty("secret");
    expect(api_key.run_ids).toBeNull();

    const [row] = await fresh.db.select().from(apiKeys).where(eq(apiKeys.id, api_key.id));
    expect(row!.hash).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(secret.slice(14));

    const list = await h.app.request("/api-keys", { headers: session(owner.token) });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain(secret.slice(14));
    const items = (JSON.parse(text) as { items: { id: string }[] }).items;
    expect(items.map((k) => k.id)).toContain(api_key.id);
    expect(items.every((k) => !("secret" in k) && !("hash" in k))).toBe(true);
  });

  it("issues ab_live_ only when BILLING_MODE=live, and ab_test_ when asked", async () => {
    expect(
      (await mint({ name: "live", scopes: ["runs:read"] }, owner.token, live.app)).secret,
    ).toMatch(/^ab_live_/);
    expect(
      (await mint({ name: "t", scopes: ["runs:read"], mode: "test" }, owner.token, live.app))
        .secret,
    ).toMatch(/^ab_test_/);
  });

  it("authenticates `Authorization: Bearer ab_test_…` on the events routes for its run", async () => {
    const { secret } = await mint({
      name: "worker",
      scopes: ["runs:read", "events:read"],
      run_ids: [runX],
    });
    const res = await h.app.request(`/runs/${runX}/events`, { headers: bearer(secret) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { seq: number }[] };
    expect(body.items.map((e) => e.seq)).toEqual([1, 2]);

    const stream = await h.app.request(`/runs/${runX}/stream`, { headers: bearer(secret) });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
  });

  it("gives a run-scoped key 403 on another run and on writes", async () => {
    const { secret } = await mint({
      name: "scoped",
      scopes: ["runs:read", "events:read"],
      run_ids: [runX],
    });
    for (const path of [`/runs/${runY}/events`, `/runs/${runY}/stream`]) {
      const res = await h.app.request(path, { headers: bearer(secret) });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    }
    const write = await h.app.request(`/tdm66/runs/${runX}/cancel`, {
      method: "POST",
      headers: bearer(secret),
    });
    expect(write.status).toBe(403);
    expect(await write.text()).toContain("runs:write");
    // A key cannot manage keys.
    const mintWithKey = await h.app.request("/api-keys", {
      method: "POST",
      headers: { ...bearer(secret), "content-type": "application/json" },
      body: JSON.stringify({ name: "x", scopes: ["runs:read"] }),
    });
    expect(mintWithKey.status).toBe(403);
    expect((await h.app.request("/api-keys", { headers: bearer(secret) })).status).toBe(403);
  });

  it("checks the scope: a runs:read key without events:read gets 403 on events", async () => {
    const { secret } = await mint({ name: "runs-only", scopes: ["runs:read"] });
    expect((await h.app.request(`/runs/${runX}/events`, { headers: bearer(secret) })).status).toBe(
      403,
    );
  });

  it("lets a runs:write key write without Origin (Bearer, no cookie passes CSRF)", async () => {
    const { secret } = await mint({ name: "writer", scopes: ["runs:write"], run_ids: [runX] });
    const res = await h.app.request(`/tdm66/runs/${runX}/cancel`, {
      method: "POST",
      headers: bearer(secret),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, via: "apiKey" });
  });

  it("an unrestricted key still only sees its owner's runs (RLS)", async () => {
    const { secret } = await mint({ name: "all", scopes: ["events:read"] });
    expect((await h.app.request(`/runs/${runY}/events`, { headers: bearer(secret) })).status).toBe(
      200,
    );
    expect(
      (await h.app.request(`/runs/${foreignRun}/events`, { headers: bearer(secret) })).status,
    ).toBe(404);
  });

  it("revoked, expired and malformed keys fail with 401; revoke is idempotent", async () => {
    const { api_key, secret } = await mint({ name: "rev", scopes: ["events:read"] });
    expect((await h.app.request(`/runs/${runX}/events`, { headers: bearer(secret) })).status).toBe(
      200,
    );
    const del = await h.app.request(`/api-keys/${api_key.id}`, {
      method: "DELETE",
      headers: session(owner.token),
    });
    expect(del.status).toBe(200);
    const revokedAt = ((await del.json()) as { api_key: { revoked_at: string } }).api_key
      .revoked_at;
    expect(revokedAt).toBeTruthy();
    expect((await h.app.request(`/runs/${runX}/events`, { headers: bearer(secret) })).status).toBe(
      401,
    );
    const again = await h.app.request(`/api-keys/${api_key.id}`, {
      method: "DELETE",
      headers: session(owner.token),
    });
    expect(((await again.json()) as { api_key: { revoked_at: string } }).api_key.revoked_at).toBe(
      revokedAt,
    );
    // Another user cannot revoke it (404, no existence leak), nor can a key holder.
    expect(
      (
        await h.app.request(`/api-keys/${api_key.id}`, {
          method: "DELETE",
          headers: session(other.token),
        })
      ).status,
    ).toBe(404);

    const exp = await mint({
      name: "exp",
      scopes: ["events:read"],
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await fresh.db
      .update(apiKeys)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(apiKeys.id, exp.api_key.id));
    expect(
      (await h.app.request(`/runs/${runX}/events`, { headers: bearer(exp.secret) })).status,
    ).toBe(401);

    // A bad Bearer key never falls back to the session cookie.
    const bad = await h.app.request(`/runs/${runX}/events`, {
      headers: {
        ...bearer(`ab_test_${"A".repeat(43)}`),
        cookie: `anybench_session=${owner.token}`,
      },
    });
    expect(bad.status).toBe(401);
  });

  it("only admins mint admin-scoped keys, and the scope follows ADMIN_GITHUB_LOGINS", async () => {
    const denied = await createKey({ name: "adm", scopes: ["admin"] });
    expect(denied.status).toBe(403);
    const { secret } = await mint({ name: "adm", scopes: ["admin", "runs:read"] }, admin.token);
    const ok = await h.app.request("/tdm66/admin", { headers: bearer(secret) });
    expect(ok.status).toBe(200);
    // Same key on a deployment where the owner is no longer an admin: the scope is dropped.
    expect((await noAdmins.app.request("/tdm66/admin", { headers: bearer(secret) })).status).toBe(
      403,
    );
    // Sessions: admin needs isAdmin.
    expect((await h.app.request("/tdm66/admin", { headers: session(owner.token) })).status).toBe(
      403,
    );
    expect((await h.app.request("/tdm66/admin", { headers: session(admin.token) })).status).toBe(
      200,
    );
  });

  it("writes last_used_at at most once per minute", async () => {
    const { api_key, secret } = await mint({ name: "touch", scopes: ["events:read"] });
    const read = async () =>
      (await fresh.db.select().from(apiKeys).where(eq(apiKeys.id, api_key.id)))[0]!.lastUsedAt;
    expect(await read()).toBeNull();
    await h.app.request(`/runs/${runX}/events`, { headers: bearer(secret) });
    const first = await read();
    expect(first).toBeInstanceOf(Date);
    await h.app.request(`/runs/${runX}/events`, { headers: bearer(secret) });
    expect((await read())!.getTime()).toBe(first!.getTime());
    await fresh.db
      .update(apiKeys)
      .set({ lastUsedAt: sql`now() - interval '2 minutes'` })
      .where(eq(apiKeys.id, api_key.id));
    const stale = await read();
    await h.app.request(`/runs/${runX}/events`, { headers: bearer(secret) });
    expect((await read())!.getTime()).toBeGreaterThan(stale!.getTime());
  });

  it("validates the body: unknown or foreign run_ids, past expiry, empty scopes", async () => {
    const foreign = await createKey({ name: "f", scopes: ["runs:read"], run_ids: [foreignRun] });
    expect(foreign.status).toBe(400);
    expect(await foreign.text()).toContain(foreignRun);
    expect(
      (
        await createKey({
          name: "p",
          scopes: ["runs:read"],
          expires_at: new Date(Date.now() - 1000).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect((await createKey({ name: "e", scopes: [] })).status).toBe(400);
    expect((await createKey({ name: "s", scopes: ["runs:delete"] })).status).toBe(400);
  });

  it("answers 401 without credentials and keeps session access to events", async () => {
    expect((await h.app.request("/api-keys")).status).toBe(401);
    expect((await h.app.request(`/runs/${runX}/events`)).status).toBe(401);
    const res = await h.app.request(`/runs/${runX}/events`, { headers: session(owner.token) });
    expect(res.status).toBe(200);
  });
});
