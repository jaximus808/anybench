import { apiRoutes } from "@anybench/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiBaseUrl,
  createWebApiClient,
  DEFAULT_UPSTREAM_API_URL,
  upstreamApiUrl,
  WEB_API_BASE,
} from "../lib/api";

afterEach(() => vi.unstubAllEnvs());

describe("web api client (TDM-98, same-origin proxy TDM-100)", () => {
  it("calls the same-origin /api proxy in the browser", () => {
    expect(WEB_API_BASE).toBe("/api");
    expect(apiBaseUrl()).toBe("/api");
    expect(createWebApiClient().url(apiRoutes.auth.me)).toBe("/api/auth/me");
  });

  it("the proxy upstream reads ANYBENCH_API_URL and defaults to the deployed API", () => {
    expect(upstreamApiUrl({})).toBe(DEFAULT_UPSTREAM_API_URL);
    expect(upstreamApiUrl({ ANYBENCH_API_URL: "http://localhost:8787/" })).toBe(
      "http://localhost:8787",
    );
  });

  it("next.config rewrites /api/* to the upstream API", async () => {
    vi.stubEnv("ANYBENCH_API_URL", "https://api.example.test");
    const { default: config } = await import("../next.config");
    expect(await config.rewrites?.()).toEqual([
      { source: "/api/:path*", destination: "https://api.example.test/:path*" },
    ]);
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
