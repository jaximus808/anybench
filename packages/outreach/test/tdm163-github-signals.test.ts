import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  companyDomain,
  createFileCache,
  createGithubSignals,
  createMemoryCache,
  createMonidClient,
  extractReadmeClaims,
  isClaimProse,
  proseOf,
} from "../src/index.js";
import {
  ANYAPI_REPO_RUN,
  DISTILL_README,
  NOW,
  TOKEN_SAVIOR_README,
  TRAIL_README,
} from "./tdm163-fixtures.js";
import { githubRoutes, routerFetch } from "./tdm163-router-fetch.js";

const opts = { fullName: "samuelfaj/distill", branch: "main", path: "README.md" };

describe("README claim lines", () => {
  it("cites prose claims only: no HTML attributes, badges, code or comments", () => {
    const claims = extractReadmeClaims(DISTILL_README, opts);
    expect(claims.map((c) => [c.line, c.text])).toEqual([
      [13, "93% cheaper"],
      [15, "UltraSave cost 0.069x the credits of Normal on our 20-case benchmark,"],
      [19, "~2x faster"],
      [21, "UltraFast finished in 0.509x the wall time of Normal, about half,"],
    ]);
    expect(claims[0]!.url).toBe("https://github.com/samuelfaj/distill/blob/main/README.md#L13");
  });

  it("drops img alt text and keeps table claims", () => {
    const claims = extractReadmeClaims(TRAIL_README, { ...opts, fullName: "trailhq/Trail-Code" });
    expect(claims.map((c) => c.line)).toEqual([3, 5, 6]);
    expect(claims[0]!.text).toBe(
      "46% fewer tool calls, 60% less time, and more real issues solved.",
    );
  });

  it("needs a number AND a claim word near it", () => {
    expect(isClaimProse(proseOf('<td width="25%" valign="top">'))).toBe(false);
    expect(isClaimProse("with far fewer tokens.")).toBe(false);
    expect(isClaimProse("Licensed under Apache 2.0, 100% open source")).toBe(false);
    expect(isClaimProse("Gets Claude to 97.9% on tsbench at -80% tokens.")).toBe(true);
    expect(isClaimProse("resolved 33 of 50 instances")).toBe(true);
    expect(extractReadmeClaims(TOKEN_SAVIOR_README, opts).map((c) => c.line)).toEqual([3]);
  });

  it("caps the number of claims", () => {
    const md = Array.from({ length: 30 }, (_, i) => `${i + 2}x faster on case ${i}`).join("\n");
    expect(extractReadmeClaims(md, { ...opts, max: 5 })).toHaveLength(5);
  });
});

describe("companyDomain", () => {
  it("returns the registrable company domain, never a hosting site", () => {
    expect(companyDomain("https://trailhq.com/trail-code")).toBe("trailhq.com");
    expect(companyDomain("docs.example.co.uk")).toBe("example.co.uk");
    expect(companyDomain("https://www.foo.dev")).toBe("foo.dev");
    expect(companyDomain("https://samuelfaj.github.io")).toBeNull();
    expect(companyDomain("https://x.com/someone")).toBeNull();
    expect(companyDomain("")).toBeNull();
    expect(companyDomain(null)).toBeNull();
  });
});

describe("GitHub signals", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("fetches repo + README in 2 calls and caches both", async () => {
    const { fetchFn, calls } = routerFetch(githubRoutes());
    const cache = createMemoryCache();
    const gh = createGithubSignals({ fetch: fetchFn, cache, now: () => NOW });
    const sig = await gh.repo("samuelfaj", "distill");
    expect(sig).toMatchObject({ fullName: "samuelfaj/distill", stars: 777, via: "github_api" });
    const readme = await gh.readme(sig);
    expect(readme.claims).toHaveLength(4);
    expect(gh.requestsUsed()).toBe(2);
    expect(calls.every((c) => c.headers.authorization === undefined)).toBe(true);
    await gh.repo("SamuelFaj", "Distill");
    await gh.readme(sig);
    expect(gh.requestsUsed()).toBe(2);
    expect(cache.size()).toBe(2);
  });

  it("records the README blob SHA and pins claim URLs to a commit only with a token", async () => {
    const anon = routerFetch(githubRoutes());
    const gh = createGithubSignals({ fetch: anon.fetchFn });
    const readme = await gh.readme({ fullName: "samuelfaj/distill", defaultBranch: "main" });
    expect(readme.blobSha).toMatch(/^blob-/);
    expect(readme.commitSha).toBeNull();
    expect(readme.claims[0]!.url).toContain("/blob/main/README.md#L13");
    expect(anon.calls.some((c) => c.url.includes("/git/ref/"))).toBe(false);

    const sha = "0123456789abcdef0123456789abcdef01234567";
    const authed = routerFetch([
      [
        /git\/ref\/heads\/main$/,
        () => ({ status: 200, body: { ref: "refs/heads/main", object: { sha, type: "commit" } } }),
      ],
      ...githubRoutes(),
    ]);
    const gh2 = createGithubSignals({ fetch: authed.fetchFn, token: "ghp_test" });
    const pinned = await gh2.readme({ fullName: "samuelfaj/distill", defaultBranch: "main" });
    expect(pinned.commitSha).toBe(sha);
    expect(pinned.claims[0]!.url).toBe(
      `https://github.com/samuelfaj/distill/blob/${sha}/README.md#L13`,
    );
    expect(authed.calls[0]!.headers.authorization).toBe("Bearer ghp_test");
  });

  it("skips the Monid fallback once the Monid client has halted", async () => {
    const { fetchFn: ghFetch } = routerFetch([
      [
        /api\.github\.com/,
        () => ({
          status: 403,
          body: { message: "API rate limit exceeded" },
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 3000) },
        }),
      ],
    ]);
    const { fetchFn: monidFetch, calls: monidCalls } = routerFetch([
      [
        /v1\/run$/,
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    ]);
    const monid = createMonidClient({ apiKey: "m", fetch: monidFetch });
    const gh = createGithubSignals({ fetch: ghFetch, monid, now: () => NOW });
    await expect(gh.repo("samuelfaj", "distill")).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      chargeUnknown: true,
    });
    expect(monid.halted()).toMatch(/charge unknown/);
    await expect(gh.repo("trailhq", "Trail-Code")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(monidCalls).toHaveLength(1);
  });

  it("never reads the profile email", async () => {
    const { fetchFn } = routerFetch(githubRoutes());
    const gh = createGithubSignals({ fetch: fetchFn });
    const u = await gh.user("samuelfaj");
    expect(u).toEqual({
      login: "samuelfaj",
      type: "User",
      name: "Samuel Test",
      company: null,
      blog: "https://samuelfaj.example",
    });
    expect(JSON.stringify(u)).not.toContain("@");
  });

  it("stops at the request budget", async () => {
    const { fetchFn, calls } = routerFetch(githubRoutes());
    const gh = createGithubSignals({ fetch: fetchFn, requestBudget: 1 });
    await gh.repo("samuelfaj", "distill");
    await expect(gh.repo("trailhq", "Trail-Code")).rejects.toMatchObject({ code: "BUDGET" });
    expect(calls).toHaveLength(1);
    expect(gh.exhausted()).toBe(true);
  });

  it("waits for a near reset, then retries", async () => {
    let n = 0;
    const slept: number[] = [];
    const ok = githubRoutes()[1]![1];
    const { fetchFn } = routerFetch([
      [
        /repos\/[^/]+\/[^/]+$/,
        (u, i, b) =>
          n++ === 0
            ? {
                status: 403,
                body: { message: "API rate limit exceeded" },
                headers: {
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-reset": String(NOW / 1000 + 20),
                },
              }
            : ok(u, i, b),
      ],
    ]);
    const gh = createGithubSignals({
      fetch: fetchFn,
      now: () => NOW,
      sleep: async (ms) => void slept.push(ms),
    });
    expect((await gh.repo("samuelfaj", "distill")).stars).toBe(777);
    expect(slept).toEqual([21_000]);
  });

  it("falls back to Monid anyapi when the reset is far away, and skips the README", async () => {
    const { fetchFn: ghFetch, calls: ghCalls } = routerFetch([
      [
        /api\.github\.com/,
        () => ({
          status: 403,
          body: { message: "API rate limit exceeded" },
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 3000) },
        }),
      ],
    ]);
    const { fetchFn: monidFetch, calls: monidCalls } = routerFetch([
      [/v1\/run$/, () => ({ status: 200, body: ANYAPI_REPO_RUN })],
    ]);
    const monid = createMonidClient({
      apiKey: "m",
      fetch: monidFetch,
      spendCapMicroUsd: 2_000_000n,
    });
    const gh = createGithubSignals({ fetch: ghFetch, monid, now: () => NOW });
    const sig = await gh.repo("samuelfaj", "distill");
    expect(sig).toMatchObject({ via: "monid_anyapi", stars: 777, ownerLogin: "samuelfaj" });
    expect(gh.exhausted()).toBe(true);
    expect(gh.fallbackSpentMicroUsd()).toBe(1_200n);
    expect(monidCalls[0]!.body).toMatchObject({
      provider: "anyapi",
      endpoint: "/github.repository",
      input: { body: { url: "https://github.com/samuelfaj/distill" } },
      maxCost: 0.0012,
    });
    expect(await gh.readme(sig)).toEqual({
      available: false,
      path: null,
      blobSha: null,
      commitSha: null,
      claims: [],
    });
    expect(ghCalls).toHaveLength(1);
  });

  it("file cache survives a new client and expires after the TTL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdm163-ghcache-"));
    dirs.push(dir);
    let t = NOW;
    const { fetchFn, calls } = routerFetch(githubRoutes());
    const mk = () =>
      createGithubSignals({ fetch: fetchFn, cache: createFileCache(dir, 1000, () => t) });
    await mk().repo("samuelfaj", "distill");
    await mk().repo("samuelfaj", "distill");
    expect(calls).toHaveLength(1);
    t += 5000;
    await mk().repo("samuelfaj", "distill");
    expect(calls).toHaveLength(2);
  });
});
