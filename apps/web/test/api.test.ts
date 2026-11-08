import { apiRoutes } from "@anybench/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBaseUrl, createWebApiClient, DEFAULT_API_URL } from "../lib/api";

afterEach(() => vi.unstubAllEnvs());

describe("web api client (TDM-98)", () => {
  it("reads NEXT_PUBLIC_ANYBENCH_API_URL and falls back to the local API", () => {
    vi.stubEnv("NEXT_PUBLIC_ANYBENCH_API_URL", "");
    expect(apiBaseUrl()).toBe(DEFAULT_API_URL);
    vi.stubEnv("NEXT_PUBLIC_ANYBENCH_API_URL", "https://api.anybench.jaxonp.com");
    expect(apiBaseUrl()).toBe("https://api.anybench.jaxonp.com");
  });

  it("builds route URLs against the base", () => {
    const client = createWebApiClient("https://api.anybench.jaxonp.com/");
    expect(client.url(apiRoutes.auth.me)).toBe("https://api.anybench.jaxonp.com/auth/me");
  });

  it("sends the session cookie with credentials: include", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createWebApiClient("https://api.example.test", {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await expect(client.auth.me()).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.test/auth/me");
    expect(calls[0]?.init.credentials).toBe("include");
  });
});
