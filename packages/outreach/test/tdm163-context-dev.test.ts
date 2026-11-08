import { describe, expect, it } from "vitest";
import {
  ContextDevError,
  createContextDevClient,
  estimateSearchCredits,
  githubRepoRoot,
  parseRepoInput,
} from "../src/index.js";
import { SEARCH_BODY } from "./tdm163-fixtures.js";
import { contextDevRoutes, routerFetch } from "./tdm163-router-fetch.js";

describe("Context.dev client", () => {
  it("searches with the bearer key and counts credits from x-credits-used", async () => {
    const { fetchFn, calls } = routerFetch(contextDevRoutes());
    const c = createContextDevClient({ apiKey: "ctx_test", creditCap: 5, fetch: fetchFn });
    const r = await c.webSearch({
      query: "site:github.com x",
      freshness: "last_month",
      numResults: 10,
    });
    expect(r.results).toHaveLength(10);
    expect(r.creditsUsed).toBe(1);
    expect(c.creditsUsed()).toBe(1);
    expect(calls[0]!.headers.authorization).toBe("Bearer ctx_test");
    expect(calls[0]!.body).toEqual({
      query: "site:github.com x",
      freshness: "last_month",
      numResults: 10,
    });
  });

  it("refuses a search whose estimate would pass the credit cap, without calling", async () => {
    const { fetchFn, calls } = routerFetch(contextDevRoutes());
    const c = createContextDevClient({ apiKey: "k", creditCap: 2, fetch: fetchFn });
    expect(estimateSearchCredits(30)).toBe(3);
    await expect(c.webSearch({ query: "q", numResults: 30 })).rejects.toMatchObject({
      code: "CREDIT_CAP",
    });
    expect(calls).toHaveLength(0);
    await c.webSearch({ query: "q", numResults: 20 }); // 1 credit actually charged (header)
    await expect(c.webSearch({ query: "q", numResults: 20 })).rejects.toBeInstanceOf(
      ContextDevError,
    );
  });

  it("never has more than 2 searches in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const { fetchFn } = routerFetch([
      [
        /web\/search/,
        async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return { status: 200, body: SEARCH_BODY, headers: { "x-credits-used": "1" } };
        },
      ],
    ]);
    const c = createContextDevClient({ apiKey: "k", creditCap: 10, fetch: fetchFn });
    await Promise.all([1, 2, 3, 4, 5].map(() => c.webSearch({ query: "q" })));
    expect(peak).toBe(2);
    expect(c.creditsUsed()).toBe(5);
  });

  it("maps 402 to USAGE_EXCEEDED and retries a 429 once", async () => {
    let n = 0;
    const { fetchFn } = routerFetch([
      [
        /web\/search/,
        () =>
          n++ === 0
            ? { status: 429, body: { error: "concurrency" }, headers: { "retry-after": "1" } }
            : { status: 402, body: { code: "USAGE_EXCEEDED" } },
      ],
    ]);
    const slept: number[] = [];
    const c = createContextDevClient({
      apiKey: "k",
      creditCap: 10,
      fetch: fetchFn,
      sleep: async (ms) => void slept.push(ms),
    });
    await expect(c.webSearch({ query: "q" })).rejects.toMatchObject({ code: "USAGE_EXCEEDED" });
    expect(slept).toEqual([1000]);
    expect(c.creditsUsed()).toBe(0);
  });
});

describe("githubRepoRoot", () => {
  it("keeps repo roots and drops issues, topics, blobs and awesome lists", () => {
    const kept = SEARCH_BODY.results.map((r) => githubRepoRoot(r.url)?.fullName ?? null);
    expect(kept).toEqual([
      "aarora79/agentic-coding-harness-benchmarks",
      "samuelfaj/distill",
      "VILA-Lab/Dive-into-Claude-Code",
      "trailhq/Trail-Code",
      null, // /issues/60
      "juliusbrussee/caveman",
      null, // awesome-cli-coding-agents
      "mibayy/token-savior",
      null, // /blob/main/README.md
      null, // /topics/agent-harness
    ]);
    expect(githubRepoRoot("https://github.com/orgs/foo")).toBeNull();
    expect(githubRepoRoot("https://gitlab.com/a/b")).toBeNull();
    expect(githubRepoRoot("https://github.com/a/b/tree/main")).toBeNull();
    expect(githubRepoRoot("https://github.com/sindresorhus/awesome")).toBeNull();
    expect(githubRepoRoot("https://github.com/a/b.git")?.key).toBe("https://github.com/a/b");
    expect(githubRepoRoot("https://github.com/Foo/Bar/")?.key).toBe("https://github.com/foo/bar");
  });

  it("parses owner/repo shorthand and bare URLs", () => {
    expect(parseRepoInput("samuelfaj/distill")?.url).toBe("https://github.com/samuelfaj/distill");
    expect(parseRepoInput("github.com/trailhq/Trail-Code/")?.fullName).toBe("trailhq/Trail-Code");
    expect(parseRepoInput("https://example.com/a/b")).toBeNull();
    expect(parseRepoInput("not a repo")).toBeNull();
  });
});
