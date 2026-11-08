// TDM-154: the apps wrapper over a mocked fetch (no live calls).
import { describe, expect, it } from "vitest";
import { createNaiveApps, NaiveNotFoundError } from "../src/index.js";

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

function mock(routes: Record<string, { status?: number; body: unknown }>) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}`;
    seen.push({
      method,
      path: url.pathname + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const hit = routes[key];
    if (!hit) {
      return new Response(
        JSON.stringify({ error: { type: "not_found", code: "not_found", message: key } }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  const apps = createNaiveApps({
    apiKey: "test-key",
    baseUrl: "https://naive.test",
    fetch: fetchImpl,
    idempotencyKey: () => "k",
  });
  return { apps, seen };
}

const app = {
  id: "app_tdm154aaaaaaaaaaaaaaaaaaaa",
  object: "app",
  name: "anybench-api",
  description: null,
  type: "fullstack",
  project: null,
  status: "active",
  url: "https://anybench-api-x.vercel.app",
  error: null,
  mcp: null,
  dashboard: false,
  created_at: "2026-11-08T00:00:00Z",
};

describe("createNaiveApps (TDM-154)", () => {
  it("findByName filters the list to an exact name", async () => {
    const { apps, seen } = mock({
      "GET /v1/apps": {
        body: {
          object: "list",
          data: [{ ...app, name: "anybench-api-old" }, app],
          has_more: false,
          next_cursor: null,
        },
      },
    });
    expect((await apps.findByName("anybench-api"))?.id).toBe("app_tdm154aaaaaaaaaaaaaaaaaaaa");
    expect(seen[0]?.path).toContain("name=anybench-api");
  });

  it("setSecret sends the value_hash and refuses platform-managed names before any request", async () => {
    const { apps, seen } = mock({
      "POST /v1/apps/app_tdm154aaaaaaaaaaaaaaaaaaaa/secrets": {
        body: {
          object: "app_secret",
          name: "SESSION_SECRET",
          value_hash: "v1:h",
          created_at: "2026-11-08T00:00:00Z",
        },
      },
    });
    const res = await apps.setSecret(
      "app_tdm154aaaaaaaaaaaaaaaaaaaa",
      "SESSION_SECRET",
      "value",
      "v1:h",
    );
    expect(res.value_hash).toBe("v1:h");
    expect(seen[0]?.body).toEqual({ name: "SESSION_SECRET", value: "value", value_hash: "v1:h" });
    await expect(
      apps.setSecret("app_tdm154aaaaaaaaaaaaaaaaaaaa", "DATABASE_URL", "x"),
    ).rejects.toThrow(/managed by the Naïve platform/);
    await expect(
      apps.setSecret("app_tdm154aaaaaaaaaaaaaaaaaaaa", "VETTA_MCP_TOKEN", "x"),
    ).rejects.toThrow(/managed/);
    await expect(apps.setSecret("app_tdm154aaaaaaaaaaaaaaaaaaaa", "bad-name", "x")).rejects.toThrow(
      /invalid/,
    );
    expect(seen).toHaveLength(1);
  });

  it("maps a 404 onto NaiveNotFoundError", async () => {
    const { apps } = mock({});
    await expect(apps.get("app_tdm154zzzzzzzzzzzzzzzzzzzz")).rejects.toBeInstanceOf(
      NaiveNotFoundError,
    );
  });
});
