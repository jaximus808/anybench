import { describe, expect, it } from "vitest";
import {
  MemoryLeadStore,
  SAVED_CLAIM_QUERIES,
  createContextDevClient,
  createGithubSignals,
  createMonidClient,
  runSourcing,
  type SourceOptions,
} from "../src/index.js";
import { NOW } from "./tdm163-fixtures.js";
import { contextDevRoutes, githubRoutes, monidRoutes, routerFetch } from "./tdm163-router-fetch.js";

function setup(over: Partial<SourceOptions> & { creditCap?: number; spendCap?: bigint } = {}) {
  const net = routerFetch([...contextDevRoutes(), ...githubRoutes(), ...monidRoutes()]);
  const contextDev = createContextDevClient({
    apiKey: "ctx",
    creditCap: over.creditCap ?? 10,
    fetch: net.fetchFn,
  });
  const github = createGithubSignals({ fetch: net.fetchFn, now: () => NOW });
  const monid = createMonidClient({
    apiKey: "m",
    fetch: net.fetchFn,
    spendCapMicroUsd: over.spendCap ?? 2_000_000n,
  });
  const store = (over.store as MemoryLeadStore | undefined) ?? new MemoryLeadStore();
  const opts: SourceOptions = {
    queryId: "harness-perf",
    limit: 10,
    contextDev,
    github,
    monid,
    store,
    now: () => NOW,
    ...over,
  };
  return { net, store, opts, monid };
}

const hits = (calls: { url: string }[], re: RegExp) => calls.filter((c) => re.test(c.url)).length;

describe("runSourcing", () => {
  it("writes cited leads from repo roots, with Hunter only for leads that pass fit", async () => {
    const { net, store, opts } = setup();
    const report = await runSourcing(opts);

    expect(report.searches).toEqual([
      expect.objectContaining({ results: 10, creditsUsed: 1, requestId: "8dc3c8ab-test" }),
    ]);
    expect(report.written.map((w) => w.githubUrl)).toEqual([
      "https://github.com/aarora79/agentic-coding-harness-benchmarks",
      "https://github.com/samuelfaj/distill",
      "https://github.com/VILA-Lab/Dive-into-Claude-Code",
      "https://github.com/trailhq/Trail-Code",
      "https://github.com/Mibayy/token-savior",
    ]);
    const reasons = Object.fromEntries(report.skipped.map((s) => [s.url, s.reason]));
    expect(reasons).toEqual({
      "https://github.com/Heretek-AI/harness-benchmark/issues/60": "not_repo_root",
      "https://github.com/JuliusBrussee/caveman": "no_claim",
      "https://github.com/bradagi/awesome-cli-coding-agents": "not_repo_root",
      "https://github.com/ai-boost/awesome-harness-engineering/blob/main/README.md":
        "not_repo_root",
      "https://github.com/topics/agent-harness": "not_repo_root",
    });
    expect(report.stoppedBy).toBe("queries_exhausted");
    expect(report.contextDevCredits).toBe(1);

    // Only distill has a name + company/blog domain → exactly one Hunter lookup, one hit.
    expect(report.emailLookups).toBe(1);
    expect(report.emailsFound).toBe(1);
    expect(report.monidSpentMicroUsd).toBe(24_500n);
    expect(hits(net.calls, /api\.monid\.ai/)).toBe(1);
    // GitHub: 6 repos + 6 READMEs (caveman's had no claim) + users for the 3 User owners that passed.
    expect(report.githubRequests).toBe(6 + 6 + 3);
    expect(net.calls.some((c) => /commits|events/.test(c.url))).toBe(false);

    const distill = store.leads.find((l) => l.githubUrl?.endsWith("/distill"))!;
    expect(distill).toMatchObject({
      source: "context_dev",
      query: "harness-perf",
      status: "new",
      contact: "Samuel Test",
      email: "samuel@samuelfaj.example",
    });
    const prov = distill.signals.provenance as Record<string, unknown>;
    expect(prov).toMatchObject({
      source: "context_dev",
      queryId: "harness-perf",
      query: SAVED_CLAIM_QUERIES[0]!.queries[0],
      rank: 2,
      resultUrl: "https://github.com/samuelfaj/distill",
      email: { source: "hunter", via: "monid", domain: "samuelfaj.example", score: 91 },
    });
    const claims = prov.claims as { text: string; url: string; from: string }[];
    expect(claims[0]).toEqual({
      line: 13,
      text: "93% cheaper",
      url: "https://github.com/samuelfaj/distill/blob/main/README.md#L13",
      from: "readme",
    });
    expect(distill.signals).toMatchObject({ stars: 777, pushedAt: "2026-11-05T17:28:52Z" });

    const trail = store.leads.find((l) => l.githubUrl?.endsWith("/Trail-Code"))!;
    expect(trail).toMatchObject({ company: "trailhq", email: null });
    expect(trail.signals.domain).toBe("trailhq.com");
    // The search snippet is also cited, with the result URL.
    expect(
      (trail.signals.claims as { from: string }[]).some((c) => c.from === "search_snippet"),
    ).toBe(true);
    const savior = store.leads.find((l) => l.githubUrl?.endsWith("/token-savior"))!;
    expect((savior.signals.claims as { url: string }[])[0]!.url).toBe(
      "https://github.com/Mibayy/token-savior/blob/main/docs/README.md#L3",
    );
  });

  it("dedupes by repo URL (case-insensitive) and company domain against existing leads", async () => {
    const store = new MemoryLeadStore({
      leads: [
        {
          source: "hackathon_optin",
          query: null,
          company: null,
          contact: "x",
          email: "x@example.com",
          githubUrl: "https://github.com/SamuelFaj/Distill",
          signals: {},
          status: "new",
        },
        {
          source: "context_dev",
          query: "token-savings",
          company: "trailhq",
          contact: "trailhq",
          email: null,
          githubUrl: "https://github.com/trailhq/other-repo",
          signals: { domain: "trailhq.com" },
          status: "new",
        },
      ],
    });
    const { opts } = setup({ store });
    const report = await runSourcing(opts);
    const reasons = Object.fromEntries(report.skipped.map((s) => [s.url, s.reason]));
    expect(reasons["https://github.com/samuelfaj/distill"]).toBe("duplicate_repo");
    expect(reasons["https://github.com/trailhq/Trail-Code"]).toBe("duplicate_domain");
    expect(report.emailLookups).toBe(0);
    expect(store.leads).toHaveLength(2 + 3);
  });

  it("skips a suppressed domain BEFORE paying for Hunter", async () => {
    const store = new MemoryLeadStore({ suppressions: ["SAMUEL@samuelfaj.example"] });
    const { net, opts } = setup({ store });
    const report = await runSourcing(opts);
    expect(report.skipped).toContainEqual({
      url: "https://github.com/samuelfaj/distill",
      reason: "suppressed",
      detail: "an address at samuelfaj.example unsubscribed",
    });
    expect(report.emailLookups).toBe(0);
    expect(hits(net.calls, /api\.monid\.ai/)).toBe(0);
    expect(store.leads.some((l) => l.githubUrl?.endsWith("/distill"))).toBe(false);
  });

  it("skips a contact domain another lead already has, before Hunter", async () => {
    const store = new MemoryLeadStore({
      leads: [
        {
          source: "hackathon_optin",
          query: null,
          company: null,
          contact: "Someone",
          email: "someone@samuelfaj.example",
          githubUrl: null,
          signals: {},
          status: "new",
        },
      ],
    });
    const { net, opts } = setup({ store });
    const report = await runSourcing(opts);
    expect(report.skipped).toContainEqual({
      url: "https://github.com/samuelfaj/distill",
      reason: "duplicate_domain",
      detail: "samuelfaj.example",
    });
    expect(hits(net.calls, /api\.monid\.ai/)).toBe(0);
  });

  it("books maxCost and stops all Monid spend when a charge is unknown", async () => {
    // Transport error on the Hunter POST; GitHub's budget then runs out, which would normally
    // trigger the anyapi fallback. Neither Hunter nor the fallback may run again.
    const net = routerFetch([
      ...contextDevRoutes(),
      ...githubRoutes(),
      [
        /api\.monid\.ai\/v1\/run$/,
        () => {
          throw new TypeError("fetch failed: socket hang up");
        },
      ],
    ]);
    const monid = createMonidClient({
      apiKey: "m",
      fetch: net.fetchFn,
      spendCapMicroUsd: 2_000_000n,
    });
    const store = new MemoryLeadStore();
    const report = await runSourcing({
      queryId: "harness-perf",
      limit: 10,
      contextDev: createContextDevClient({ apiKey: "c", creditCap: 10, fetch: net.fetchFn }),
      // aarora79: repo+readme+user, distill: repo+readme+user → the 7th call (VILA) is over budget.
      github: createGithubSignals({ fetch: net.fetchFn, requestBudget: 6, monid, now: () => NOW }),
      monid,
      store,
      now: () => NOW,
    });
    expect(report.emailStoppedBy).toBe("monid_charge_unknown");
    expect(report.monidSpentMicroUsd).toBe(24_500n); // the Hunter maxCost, booked
    expect(report.monidHalted).toMatch(/hunterio \/email-finder \(TRANSPORT_ERROR\)/);
    expect(report.stoppedBy).toBe("github_exhausted");
    expect(hits(net.calls, /api\.monid\.ai/)).toBe(1);
    expect(store.leads.map((l) => l.githubUrl)).toEqual([
      "https://github.com/aarora79/agentic-coding-harness-benchmarks",
      "https://github.com/samuelfaj/distill",
    ]);
    expect(store.leads[1]!.email).toBeNull();
  });

  it("treats an insert conflict (a concurrent run won) as a duplicate skip", async () => {
    const store = new MemoryLeadStore();
    const realInsert = store.insert.bind(store);
    let raced = false;
    store.insert = async (lead) => {
      if (!raced && lead.githubUrl?.endsWith("/distill")) {
        raced = true;
        await realInsert({ ...lead, signals: {} }); // the other run's row lands first
      }
      return realInsert(lead);
    };
    const { opts } = setup({ store });
    const report = await runSourcing(opts);
    expect(report.skipped).toContainEqual({
      url: "https://github.com/samuelfaj/distill",
      reason: "duplicate_email",
      detail: "insert conflict",
    });
    expect(store.leads.filter((l) => l.githubUrl?.endsWith("/distill"))).toHaveLength(1);
  });

  it("records the README blob SHA in provenance", async () => {
    const { store, opts } = setup();
    await runSourcing(opts);
    const distill = store.leads.find((l) => l.githubUrl?.endsWith("/distill"))!;
    expect((distill.signals.provenance as { readme: unknown }).readme).toEqual({
      path: "README.md",
      blobSha: expect.stringMatching(/^blob-/),
      commitSha: null,
    });
  });

  it("stops at --limit", async () => {
    const { net, store, opts } = setup({ limit: 2 });
    const report = await runSourcing(opts);
    expect(report.stoppedBy).toBe("limit");
    expect(store.leads).toHaveLength(2);
    // Nothing fetched for repos after the limit.
    expect(hits(net.calls, /Dive-into-Claude-Code/i)).toBe(0);
  });

  it("never exceeds the Context.dev credit cap", async () => {
    const { net, store, opts } = setup({ creditCap: 0 });
    const report = await runSourcing(opts);
    expect(report.stoppedBy).toBe("credit_cap");
    expect(report.contextDevCredits).toBe(0);
    expect(store.leads).toHaveLength(0);
    expect(net.calls).toHaveLength(0);
  });

  it("keeps sourcing without emails once the Monid spend cap is hit", async () => {
    const { net, store, opts } = setup({ spendCap: 10_000n }); // < one Hunter maxCost (24,500)
    const report = await runSourcing(opts);
    expect(report.emailStoppedBy).toBe("spend_cap");
    expect(report.emailLookups).toBe(0);
    expect(report.monidSpentMicroUsd).toBe(0n);
    expect(hits(net.calls, /api\.monid\.ai/)).toBe(0);
    expect(store.leads).toHaveLength(5);
    expect(store.leads.every((l) => l.email === null)).toBe(true);
  });

  it("dry run writes nothing and needs no Monid client", async () => {
    const { store, opts } = setup({ dryRun: true, monid: undefined });
    const report = await runSourcing(opts);
    expect(report.written).toHaveLength(5);
    expect(report.written.every((w) => w.id === null)).toBe(true);
    expect(store.leads).toHaveLength(0);
    expect(report.emailLookups).toBe(0);
  });

  it("rejects an unknown saved query", async () => {
    const { opts } = setup({ queryId: "nope" });
    await expect(runSourcing(opts)).rejects.toThrow(/unknown saved query "nope"/);
  });
});
