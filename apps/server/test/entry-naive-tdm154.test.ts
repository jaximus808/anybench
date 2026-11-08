// TDM-154: the Naïve fullstack app entry. Path restore from the vercel.json rewrite, the
// ANYBENCH_DATABASE_* mapping (the platform owns DATABASE_*), and the Node handler end to end on a
// real http server, the way Vercel's Node runtime calls `api/app.js`.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import handler, {
  naiveEnvSource,
  naiveVercelJson,
  restoreRewrittenPath,
} from "../src/entry-naive.js";
import { sessionCookieOptions } from "../src/lib/session.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const hasDb = await pgAvailableTdm11();

describe("restoreRewrittenPath (TDM-154)", () => {
  it("moves __path back into the path and keeps the rest of the query", () => {
    expect(restoreRewrittenPath("/api/app?__path=/health")).toBe("/health");
    expect(restoreRewrittenPath("/api/app?__path=/auth/github/callback&code=abc&state=xyz")).toBe(
      "/auth/github/callback?code=abc&state=xyz",
    );
    expect(restoreRewrittenPath("/api/app?code=1&__path=%2Fruns%2Fr1%2Fstream")).toBe(
      "/runs/r1/stream?code=1",
    );
    expect(restoreRewrittenPath("/api/app?__path=/")).toBe("/");
  });

  it("leaves a URL without __path, or with a non-absolute one, alone", () => {
    expect(restoreRewrittenPath("/health?x=1")).toBe("/health?x=1");
    expect(restoreRewrittenPath("/api/app?__path=evil.com")).toBe("/api/app?__path=evil.com");
    expect(restoreRewrittenPath("/api/app?__path=//evil.com")).toBe("/api/app?__path=//evil.com");
  });

  it("vercel.json rewrites every path to the one function", () => {
    expect(naiveVercelJson()).toEqual({
      functions: { "api/app.js": { maxDuration: 300 } },
      rewrites: [{ source: "/(.*)", destination: "/api/app?__path=/$1" }],
    });
  });
});

describe("naiveEnvSource (TDM-154)", () => {
  it("maps ANYBENCH_DATABASE_URL(_DIRECT) over the platform's DATABASE_*", () => {
    const out = naiveEnvSource({
      DATABASE_URL: "postgres://platform/managed",
      ANYBENCH_DATABASE_URL: "postgres://u:p@neon-pooler/db",
      ANYBENCH_DATABASE_URL_DIRECT: "postgres://u:p@neon/db",
      OTHER: "kept",
    });
    expect(out.DATABASE_URL).toBe("postgres://u:p@neon-pooler/db");
    expect(out.DATABASE_URL_DIRECT).toBe("postgres://u:p@neon/db");
    expect(out.OTHER).toBe("kept");
  });

  it("refuses to fall back to the platform database", () => {
    let err: unknown;
    try {
      naiveEnvSource({ DATABASE_URL: "postgres://platform/managed" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues.map((i) => i.path)).toEqual([
      "ANYBENCH_DATABASE_URL",
      "ANYBENCH_DATABASE_URL_DIRECT",
    ]);
  });
});

describe("SESSION_COOKIE_SAMESITE (TDM-154)", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://u:p@h/db",
    DATABASE_URL_DIRECT: "postgres://u:p@h/db",
    GITHUB_OAUTH_CALLBACK_URL: "https://api.example.vercel.app/auth/github/callback",
  };

  it("defaults to Lax and switches to None (still Secure) for a cross-site web origin", () => {
    expect(sessionCookieOptions(loadConfig(base)).sameSite).toBe("Lax");
    const none = sessionCookieOptions(loadConfig({ ...base, SESSION_COOKIE_SAMESITE: "none" }));
    expect(none).toMatchObject({ sameSite: "None", secure: true, httpOnly: true });
  });

  it("refuses none when the cookie would not be Secure", () => {
    expect(() =>
      loadConfig({
        SESSION_COOKIE_SAMESITE: "none",
        GITHUB_OAUTH_CALLBACK_URL: "http://localhost:8787/auth/github/callback",
      }),
    ).toThrow(/SESSION_COOKIE_SAMESITE/);
    expect(() => loadConfig({ ...base, SESSION_COOKIE_SAMESITE: "strict" })).toThrow(ConfigError);
  });
});

describe("Naïve handler over node:http (TDM-154)", () => {
  let server: Server;
  let base: string;
  const saved = { ...process.env };
  let db: FreshDbTdm11 | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.LOG_LEVEL = "silent";
    delete process.env.ANYBENCH_DATABASE_URL;
    delete process.env.ANYBENCH_DATABASE_URL_DIRECT;
    delete process.env.S3_BUCKET;
    if (hasDb) db = await freshMigratedDbTdm11();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db?.drop();
    process.env = saved;
  });

  it("answers 503 without leaking config while ANYBENCH_DATABASE_URL is missing", async () => {
    const res = await fetch(`${base}/api/app?__path=/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: "unavailable", message: "booting failed" },
    });
  });

  it("boots on the next request once the secrets exist and routes the restored path", async () => {
    const url = db?.url ?? "postgres://anybench:anybench@127.0.0.1:1/none";
    // What the platform injects on a fullstack app: its own managed (no-RLS) Postgres.
    process.env.DATABASE_URL = "postgres://platform:managed@platform-db.invalid/app";
    process.env.DATABASE_URL_DIRECT = "postgres://platform:managed@platform-db.invalid/app";
    process.env.ANYBENCH_DATABASE_URL = url;
    process.env.ANYBENCH_DATABASE_URL_DIRECT = url;
    const res = await fetch(`${base}/api/app?__path=/health`);
    const body = (await res.json()) as { ok: boolean; db: { ok: boolean } };
    if (db) {
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ ok: true, db: { ok: true } });
    } else {
      expect(res.status).toBe(503);
      expect(body).toMatchObject({ ok: false, db: { ok: false } });
    }
    // getDb() and scopedDb's default read process.env directly: they must see Neon, never the platform DB.
    expect(process.env.DATABASE_URL).toBe(url);
    expect(process.env.DATABASE_URL_DIRECT).toBe(url);
    const nf = await fetch(`${base}/api/app?__path=/nope-tdm154`);
    expect(nf.status).toBe(404);
  });
});
