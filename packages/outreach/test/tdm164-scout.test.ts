// TDM-164 [15.3a]: scout claim briefs. Offline: FakeNaive, an in-memory ingest, no network.

import { readFileSync } from "node:fs";
import {
  loadScoutConfig,
  loadScoutOutputJsonSchema,
  loadScoutPrompt,
  scoutAgentSpec,
} from "@anybench/agents";
import type { RepoIngest } from "@anybench/kit";
import { FakeNaive, fakeNaiveError } from "@anybench/naive";
import { describe, expect, it } from "vitest";
import {
  checkQuote,
  contactFor,
  DEFAULT_SCOUT_PER_LEAD_BUDGET_MICRO_USD,
  MemoryScoutLeadStore,
  METRICS_BY_CLASS,
  materialFromIngest,
  PgScoutLeadStore,
  runScout,
  ScoutBriefRejectedError,
  ScoutBriefSchema,
  ScoutMaterial,
  scoutLeadFromRow,
  scoutLeadFromStored,
  scoutOutputJsonSchema,
  scoutSettingsFromEnv,
  unmeasuredAssertions,
  verifyScoutOutput,
  type ScoutEmailFinder,
  type ScoutOutput,
} from "../src/index.js";

// ---- fixtures ---------------------------------------------------------------------------------

const TDM164_SHA = "0123456789abcdef0123456789abcdef01234567";
const TDM164_README = [
  "# zippy",
  "",
  '<p align="center"><img src="logo.png" width="25%"></p>',
  "",
  "Zippy is a coding-agent harness for Claude Code.",
  "",
  "- **2x faster** than plain Claude Code on our 20-task suite",
  "- Uses 46% fewer tokens than [pi](https://github.com/example/pi) on the same tasks",
  "",
  "## Benchmarks",
  "",
  "SWE-bench Verified: 27 → 33 of 50 with Claude Sonnet",
  "Benchmark fixtures: not currently published",
].join("\n");

function tdm164Ingest(githubUrl = "https://github.com/acme/zippy"): RepoIngest {
  return {
    digest: {
      source: { kind: "github", url: githubUrl, ref: "main", commit: TDM164_SHA },
      name: "zippy",
      kind: "harness",
      summary: "A coding-agent harness for Claude Code",
      languages: [{ name: "TypeScript", bytes: 1000 }],
      entrypoints: [{ kind: "bin", name: "zippy", command: "zippy" }],
      build_commands: ["pnpm build"],
      test_commands: ["pnpm test"],
      docs: ["README.md"],
      releases: { tags: [] },
      files: { count: 12, total_bytes: 4000 },
      suggested_driver_types: [],
      ingested_at: "2026-11-08T00:00:00.000Z",
      hash: "a".repeat(64),
    },
    context: {
      tree: { paths: ["README.md", "package.json"], dirs: [], truncated: false },
      readme: { path: "README.md", text: TDM164_README, truncated: false },
      manifests: [
        {
          path: "package.json",
          kind: "package.json",
          text: '{\n  "name": "zippy",\n  "description": "fast harness"\n}',
          truncated: false,
        },
      ],
      tests: { files: 0, dirs: [], sample: [] },
      benchmarks: { files: 0, dirs: [], sample: [] },
      commits_scanned: 0,
      recent_test_commits: [],
      large_files: [],
    },
  };
}

const tdm164Material = () => materialFromIngest(tdm164Ingest());

function tdm164Output(over: Partial<ScoutOutput> = {}): ScoutOutput {
  return {
    kind: "agent_harness",
    fit: 82,
    fit_reason: "The README makes quantified speed and token claims with no published fixtures.",
    claims: [
      {
        text: "2x faster than plain Claude Code on our 20-task suite",
        source_ref: "README.md#L7",
        what_it_claims: "The README says zippy is about 2x faster than plain Claude Code.",
        about: "own",
      },
      {
        // Markdown link in the line; the quote is the rendered text. Cited on the wrong line.
        text: "Uses 46% fewer tokens than pi on the same tasks",
        source_ref: "README.md#L2",
        what_it_claims: "The README claims 46% fewer tokens than pi.",
        about: "own",
      },
      {
        text: "SWE-bench Verified: 27 → 33 of 50",
        source_ref: "README.md#L12",
        what_it_claims: "The README reports 33 of 50 solved on SWE-bench Verified.",
        about: "own",
      },
      {
        text: "Zippy solves 90% of SWE-bench",
        source_ref: "README.md#L12",
        what_it_claims: "Invented by the model.",
        about: "own",
      },
      {
        // A real quote, but about another product (survey-style): dropped.
        text: "Uses 46% fewer tokens than pi on the same tasks",
        source_ref: "README.md#L8",
        what_it_claims: "Numbers about pi, not zippy.",
        about: "third_party",
      },
    ],
    what_we_would_measure: [
      { metric: "cost_per_solved_task", why: "To test the claim of 46% fewer tokens." },
      {
        metric: "time_to_solve",
        why: "To check whether the 2x speed claim holds with failures at the cap.",
      },
      {
        metric: "regressions_pass_to_pass",
        why: "We'd check whether faster runs break passing tests.",
      },
      { metric: "wall_time_warm", why: "Not an agent metric." },
    ],
    gate: [
      "Hidden SWE-bench Verified tests, run out of process, decide pass/fail before any time or cost counts.",
    ],
    compared_against: [
      { name: "pi", source: "README.md#L8", why: "The README names pi as its baseline." },
      {
        name: "Claude Code",
        source: "https://docs.anthropic.com/claude-code",
        why: "The plain harness.",
      },
      { name: "made up", source: "README.md#L999", why: "x" },
      { name: "not a url", source: "somewhere", why: "x" },
    ],
    caveats: ["Results depend on the pinned model version.", "Zippy is 2x slower on big repos."],
    contact_ok: true,
    why: "Zippy claims 2x speed and 46% fewer tokens. We'd check both against hidden tests.",
    ...over,
  };
}

// ---- claim verification ---------------------------------------------------------------------

describe("checkQuote: quotes must be on their cited line of the fetched text", () => {
  const mat = tdm164Material();

  it("accepts an exact quote and a quote with markdown stripped", () => {
    expect(checkQuote(mat, "2x faster than plain Claude Code", "README.md#L7")).toEqual({
      ok: true,
      path: "README.md",
      line: 7,
      relocated: false,
    });
    expect(checkQuote(mat, "“Uses 46% fewer tokens than pi”", "README.md#L8").ok).toBe(true);
    expect(
      checkQuote(mat, "SWE-bench Verified: 27 → 33 of 50 ... Claude Sonnet", "README.md#L12").ok,
    ).toBe(true);
  });

  it("relocates a real quote cited on the wrong line, refuses invented or trivial ones", () => {
    expect(checkQuote(mat, "46% fewer tokens than pi", "README.md#L3")).toMatchObject({
      ok: true,
      line: 8,
      relocated: true,
    });
    expect(checkQuote(mat, "Zippy solves 90% of SWE-bench", "README.md#L12")).toEqual({
      ok: false,
      reason: "quote_not_found",
    });
    expect(checkQuote(mat, "2x faster", "README.md#L7")).toEqual({
      ok: false,
      reason: "quote_too_short",
    });
    expect(checkQuote(mat, "2x faster than plain Claude Code", "docs/x.md#L7")).toEqual({
      ok: false,
      reason: "unknown_file",
    });
    expect(checkQuote(mat, "2x faster than plain Claude Code", "README.md")).toEqual({
      ok: false,
      reason: "unknown_file",
    });
  });

  it('never matches markup: width="25%" in an HTML tag is not a quote', () => {
    expect(checkQuote(mat, 'img src="logo.png" width="25%"', "README.md#L3").ok).toBe(false);
  });
});

describe("unmeasuredAssertions (plan 17.2 rule 10)", () => {
  it("flags results stated as fact", () => {
    for (const s of [
      "Zippy is 2x slower than pi.",
      "It beats Claude Code on every task.",
      "We measured a 30% gap.",
      "Our tests showed regressions.",
      "Their claim is inflated.",
      "Zippy is significantly cheaper.",
      "The claim is false, according to the README numbers.",
    ]) {
      expect(unmeasuredAssertions(s), s).toEqual([s]);
    }
  });

  it("allows plans and reports of the project's own claims", () => {
    for (const s of [
      "We'd check whether zippy is faster than plain Claude Code.",
      "The README says it beats pi on 20 tasks.",
      "We have measured nothing yet.",
      "To test if it is cheaper per solved task.",
      "We'd check whether the claim is true on hidden tests.",
      "Results depend on the pinned model version.",
    ]) {
      expect(unmeasuredAssertions(s), s).toEqual([]);
    }
  });
});

describe("verifyScoutOutput", () => {
  it("keeps verified claims with permalinks, drops the rest, and gates metrics by class", () => {
    const v = verifyScoutOutput(tdm164Output(), tdm164Material());
    expect(v.claims.map((c) => c.source_ref)).toEqual([
      "README.md#L7",
      "README.md#L8",
      "README.md#L12",
    ]);
    expect(v.claims[1]).toMatchObject({ cited_ref: "README.md#L2" });
    expect(v.claims[0]!.source_url).toBe(
      `https://github.com/acme/zippy/blob/${TDM164_SHA}/README.md#L7`,
    );
    expect(v.dropped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "claims", reason: "quote_not_found" }),
        expect.objectContaining({ field: "claims", reason: "third_party_claim" }),
        expect.objectContaining({
          field: "what_we_would_measure",
          item: "wall_time_warm",
          reason: "metric_not_for_class",
        }),
        expect.objectContaining({ field: "compared_against", reason: "source_not_found" }),
        expect.objectContaining({ field: "compared_against", reason: "bad_source" }),
        expect.objectContaining({ field: "caveats", reason: "unmeasured_assertion" }),
      ]),
    );
    // Required core for agent_harness always present, first; vanity metrics can't be picked at all.
    const ids = v.what_we_would_measure.map((w) => w.metric);
    for (const def of METRICS_BY_CLASS.agent_harness.required) expect(ids).toContain(def.id);
    expect(ids).toContain("regressions_pass_to_pass");
    expect(ids).not.toContain("wall_time_warm");
    expect(v.what_we_would_measure.findIndex((w) => !w.required)).toBe(
      METRICS_BY_CLASS.agent_harness.required.length,
    );
    expect(v.compared_against).toEqual([
      expect.objectContaining({ name: "pi", source: "README.md#L8", source_in_repo: true }),
      expect.objectContaining({ name: "Claude Code", source_in_repo: false }),
    ]);
    expect(v.caveats).toEqual(["Results depend on the pinned model version."]);
  });

  it("rejects a brief whose why or fit_reason asserts an unmeasured result, or that has no gate left", () => {
    expect(() =>
      verifyScoutOutput(tdm164Output({ why: "Zippy is slower than pi." }), tdm164Material()),
    ).toThrow(ScoutBriefRejectedError);
    expect(() =>
      verifyScoutOutput(tdm164Output({ fit_reason: "It outperforms nothing." }), tdm164Material()),
    ).toThrow(ScoutBriefRejectedError);
    expect(() =>
      verifyScoutOutput(
        tdm164Output({ gate: ["We measured it and it passes."] }),
        tdm164Material(),
      ),
    ).toThrow(/no correctness gate/);
  });
});

// ---- the run ----------------------------------------------------------------------------------

const tdm164Leads = [
  {
    id: "lead-hi",
    githubUrl: "https://github.com/acme/zippy",
    claims: [
      {
        text: "2x faster than plain Claude Code",
        url: "https://github.com/acme/zippy/blob/main/README.md#L7",
        line: 7,
      },
    ],
    signals: { stars: 900, ownerType: "User" as const },
  },
  { id: "lead-lo", githubUrl: "https://github.com/acme/meh", email: "known@example.com" },
];

function tdm164Finder(): ScoutEmailFinder & { calls: string[] } {
  const calls: string[] = [];
  return {
    source: "test_finder",
    calls,
    find: async (lead) => {
      calls.push(lead.id);
      return { email: "Founder@Example.com", costMicroUsd: 24_500n };
    },
  };
}

describe("runScout (FakeNaive)", () => {
  it("scores, verifies and stores briefs; skips below threshold; looks up email only for passing leads", async () => {
    const naive = new FakeNaive();
    naive.script(
      "scout",
      { output: tdm164Output(), costMicroUsd: 41_000n },
      { output: tdm164Output({ fit: 30 }), costMicroUsd: 9_000n },
    );
    const store = new MemoryScoutLeadStore(tdm164Leads);
    const finder = tdm164Finder();
    const report = await runScout({
      naive,
      store,
      ingest: async (url) => tdm164Ingest(url),
      emailFinder: finder,
      fitThreshold: 60,
      now: () => new Date("2026-11-08T03:00:00.000Z"),
    });

    expect(report.results.map((r) => [r.leadId, r.status])).toEqual([
      ["lead-hi", "scored"],
      ["lead-lo", "skipped"],
    ]);
    expect(report.spentMicroUsd).toBe(50_000n);
    expect(finder.calls).toEqual(["lead-hi"]);

    const hi = store.leads.find((l) => l.id === "lead-hi")!;
    expect(hi).toMatchObject({ status: "scored", fit: 82, email: "founder@example.com" });
    const brief = ScoutBriefSchema.parse(hi.brief);
    expect(brief.naive.cost_micro_usd).toBe(41_000n);
    expect(brief.naive.budget_micro_usd).toBe(DEFAULT_SCOUT_PER_LEAD_BUDGET_MICRO_USD);
    expect(brief.contact_lookup).toEqual({
      source: "test_finder",
      found: true,
      cost_micro_usd: 24_500n,
    });
    expect(brief.contact.status).toBe("email_found");
    expect(hi.brief!.naive.cost_micro_usd).toBe("41000"); // jsonb: decimal string, never a float

    // Every stored claim's source_ref resolves to a line of the digest's material that contains it.
    const mat = tdm164Material();
    for (const c of brief.claims) {
      const [path, line] = c.source_ref.split("#L");
      const text = mat.lines(path!)?.[Number(line) - 1];
      expect(text, c.source_ref).toBeDefined();
      expect(checkQuote(mat, c.text, c.source_ref)).toMatchObject({ ok: true, relocated: false });
    }

    const lo = store.leads.find((l) => l.id === "lead-lo")!;
    expect(lo).toMatchObject({ status: "skipped", fit: 30, email: "known@example.com" });
    expect(lo.brief).toMatchObject({
      skip_reason: "below_threshold",
      contact_lookup: null,
      contact: { status: "email_known" },
    });

    // One session per lead, each capped at the per-lead budget, with the output schema attached.
    expect(naive.sessionCreates).toHaveLength(2);
    for (const c of naive.sessionCreates) {
      expect(c.body.budgetMicroUsd).toBe(DEFAULT_SCOUT_PER_LEAD_BUDGET_MICRO_USD);
      expect(c.body.outputSchema).toEqual(scoutOutputJsonSchema());
      expect(c.body.structuredOutputRequired).toBe(true);
      expect(c.body.message).not.toContain("known@example.com");
    }
    const input = JSON.parse(naive.sessionCreates[0]!.body.message) as {
      material: { files: Array<{ path: string; lines: string }> };
    };
    expect(input.material.files[0]!.lines.split("\n")[6]).toBe(
      "L7: - **2x faster** than plain Claude Code on our 20-task suite",
    );
  });

  it("stops at the run cap and never gives a session more than the per-lead budget", async () => {
    const naive = new FakeNaive();
    naive.scriptDefault("scout", { output: tdm164Output(), costMicroUsd: 100_000n });
    const leads = ["a", "b", "c", "d"].map((id) => ({
      id,
      githubUrl: `https://github.com/acme/${id}`,
    }));
    const report = await runScout({
      naive,
      leads,
      ingest: async (url) => tdm164Ingest(url),
      perLeadBudgetMicroUsd: 100_000n,
      runCapMicroUsd: 250_000n,
    });
    expect(report.results).toHaveLength(2);
    expect(report.stoppedBy).toBe("run_cap");
    expect(report.unscouted).toEqual(["c", "d"]);
    expect(report.spentMicroUsd).toBe(200_000n);
    expect(naive.sessionCreates.every((c) => c.body.budgetMicroUsd === 100_000n)).toBe(true);
  });

  it("records invalid output, wording violations and budget hits as errors with their spend, writing nothing", async () => {
    const naive = new FakeNaive();
    naive.script(
      "scout",
      { output: { fit: 900 }, costMicroUsd: 7_000n },
      { output: tdm164Output({ why: "Zippy is slower than pi." }), costMicroUsd: 8_000n },
      { stopReason: "budget_paused", costMicroUsd: 250_000n },
    );
    const store = new MemoryScoutLeadStore(
      ["x", "y", "z"].map((id) => ({ id, githubUrl: `https://github.com/acme/${id}` })),
    );
    const report = await runScout({ naive, store, ingest: async (url) => tdm164Ingest(url) });
    expect(report.results.map((r) => (r.status === "error" ? r.error.code : r.status))).toEqual([
      "output_invalid",
      "unmeasured_assertion",
      "budget_exceeded",
    ]);
    expect(report.results.map((r) => r.costMicroUsd)).toEqual([7_000n, 8_000n, 250_000n]);
    expect(store.leads.every((l) => l.status === "new" && l.brief === null)).toBe(true);
  });

  it("counts the whole per-lead budget when a failed session's spend can't be read", async () => {
    const naive = new FakeNaive();
    naive.script("scout", { createError: fakeNaiveError("internal_error", 500) });
    const report = await runScout({
      naive,
      leads: [{ id: "q", githubUrl: "https://github.com/acme/q" }],
      ingest: async (url) => tdm164Ingest(url),
    });
    expect(report.results[0]).toMatchObject({
      status: "error",
      costMicroUsd: DEFAULT_SCOUT_PER_LEAD_BUDGET_MICRO_USD,
    });
  });

  it("a pre-flight refusal (quote above the per-lead budget) is recorded as 0 spend", async () => {
    const naive = new FakeNaive();
    naive.script("scout", { createError: fakeNaiveError("budget_exceeded", 402) });
    const report = await runScout({
      naive,
      leads: [{ id: "pf", githubUrl: "https://github.com/acme/pf" }],
      ingest: async (url) => tdm164Ingest(url),
    });
    expect(report.results[0]).toMatchObject({
      status: "error",
      error: { code: "budget_below_quote" },
      costMicroUsd: 0n,
    });
    expect(report.spentMicroUsd).toBe(0n);
  });

  it("replays the same session for the same lead, digest and prompt (no double spend)", async () => {
    const naive = new FakeNaive();
    naive.scriptDefault("scout", { output: tdm164Output(), costMicroUsd: 5_000n });
    const opts = {
      naive,
      leads: [tdm164Leads[0]!],
      ingest: async (url: string) => tdm164Ingest(url),
      dryRun: true,
    };
    await runScout(opts);
    await runScout(opts);
    expect(naive.sessionCreates.map((c) => c.replayed)).toEqual([false, true]);
  });

  it("still writes the brief for a GitHub organization with no email, marked contact none", async () => {
    const naive = new FakeNaive();
    naive.scriptDefault("scout", { output: tdm164Output() });
    const store = new MemoryScoutLeadStore([
      {
        id: "org",
        githubUrl: "https://github.com/acme/zippy",
        contact: "acme", // TDM-163 puts the org login here
        signals: { ownerType: "Organization", ownerLogin: "acme" },
      },
    ]);
    const report = await runScout({ naive, store, ingest: async (url) => tdm164Ingest(url) });
    expect(report.results[0]).toMatchObject({ status: "scored" });
    const brief = ScoutBriefSchema.parse(store.leads[0]!.brief);
    expect(brief.contact).toEqual({
      status: "none",
      reason: "GitHub organization with no person; a human must pick a contact",
    });
    expect(brief.contact_lookup).toBeNull();
    expect(store.leads[0]!.email).toBeNull();
  });

  it("skips leads with no verified claim or not ok to contact, and errors on ingest failure", async () => {
    const naive = new FakeNaive();
    naive.script(
      "scout",
      { output: tdm164Output({ claims: [tdm164Output().claims[3]!] }) },
      { output: tdm164Output({ contact_ok: false }) },
    );
    const report = await runScout({
      naive,
      leads: [
        { id: "n1", githubUrl: "https://github.com/acme/n1" },
        { id: "n2", githubUrl: "https://github.com/acme/n2" },
        { id: "n3", githubUrl: "https://github.com/acme/broken" },
      ],
      ingest: async (url) => {
        if (url.endsWith("broken")) throw new Error("git failed");
        return tdm164Ingest(url);
      },
    });
    expect(
      report.results.map((r) =>
        r.status === "skipped" ? r.skipReason : r.status === "error" ? r.error.code : r.status,
      ),
    ).toEqual(["no_verified_claims", "contact_not_ok", "ingest_failed"]);
  });
});

// ---- adapters, config, env ------------------------------------------------------------------

describe("scoutLeadFromRow (leads row as TDM-163 writes it)", () => {
  it("reads repo, claims and signals; ignores malformed fields", () => {
    const lead = scoutLeadFromRow({
      id: "0190f0aa-0000-7000-8000-000000000001",
      github_url: "https://github.com/samuelfaj/distill",
      company: null,
      contact: "Samuel",
      email: null,
      signals: {
        fullName: "samuelfaj/distill",
        stars: 777,
        ownerType: "User",
        pushedAt: "2026-11-05T00:00:00Z",
        language: "Rust",
        topics: "not-an-array",
        claims: [
          {
            text: "93% cheaper",
            url: "https://github.com/samuelfaj/distill/blob/main/README.md#L32",
            line: 32,
            from: "readme",
          },
          { text: "snippet", url: "https://github.com/samuelfaj/distill", from: "search_snippet" },
          { nope: true },
        ],
      },
    });
    expect(lead).toMatchObject({
      githubUrl: "https://github.com/samuelfaj/distill",
      signals: { stars: 777, ownerType: "User", language: "Rust" },
    });
    expect(lead!.signals).not.toHaveProperty("topics");
    expect(lead!.claims).toHaveLength(2);
    expect(
      scoutLeadFromRow({
        id: "x",
        github_url: null,
        company: null,
        contact: null,
        email: null,
        signals: null,
      }),
    ).toBeNull();
  });

  it("reads a TDM-163 StoredLead: githubUrl, source, signals.claims + signals.provenance.claims (deduped)", () => {
    const c1 = {
      text: "93% cheaper",
      url: "https://github.com/o/r/blob/main/README.md#L32",
      line: 32,
      from: "readme",
    };
    const lead = scoutLeadFromStored({
      id: "id-1",
      source: "context_dev",
      company: "o",
      contact: "o",
      email: null,
      githubUrl: "https://github.com/o/r",
      signals: {
        ownerType: "Organization",
        domain: "o.dev",
        claims: [c1],
        provenance: {
          source: "context_dev",
          queryId: "perf-claims",
          claims: [
            c1,
            { text: "snippet claim", url: "https://github.com/o/r", from: "search_snippet" },
          ],
        },
      },
    });
    expect(lead).toMatchObject({
      source: "context_dev",
      githubUrl: "https://github.com/o/r",
      signals: { ownerType: "Organization", domain: "o.dev" },
    });
    expect(lead!.claims.map((c) => c.from)).toEqual(["readme", "search_snippet"]);
    expect(contactFor(lead!, null).status).toBe("none");
    expect(contactFor({ ...lead!, email: "a@o.dev" }, null).status).toBe("email_known");
  });

  it("PgScoutLeadStore only updates leads still new and keeps a known email", async () => {
    const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
    const store = new PgScoutLeadStore({
      query: async (text, values) => {
        queries.push({ text, values });
        return { rows: [] };
      },
    });
    await store.saveScout("id1", { status: "skipped", fit: 12, brief: {} as never, email: null });
    expect(queries[0]!.text).toMatch(/where id = \$1 and status = 'new'/);
    expect(queries[0]!.text).toMatch(/email = coalesce\(email, \$5\)/);
    expect(queries[0]!.values).toEqual(["id1", "skipped", 12, "{}", null]);
  });
});

describe("scout agent spec (packages/agents/scout)", () => {
  it("committed output.schema.json is the zod schema's JSON schema", () => {
    expect(loadScoutOutputJsonSchema()).toEqual(scoutOutputJsonSchema());
  });

  it("pins a model, denies tools and carries the honest-wording rule", () => {
    const config = loadScoutConfig();
    expect(config.model).not.toMatch(/latest|^~/);
    expect(config.tools).toEqual({ default_config: { permission: "deny" }, configs: {} });
    expect(loadScoutPrompt()).toMatch(/We have measured \*\*nothing\*\*/);
    const spec = scoutAgentSpec({ maxTaskMicroUsd: 250_000n });
    expect(spec.budget.maxTaskMicroUsd).toBe(250_000n);
    expect(spec.role).toBe("scout");
  });

  it("the CLI-facing env names exist in .env.example", () => {
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    for (const k of [
      "OUTREACH_FIT_THRESHOLD",
      "OUTREACH_PER_LEAD_BUDGET_MICRO_USD",
      "OUTREACH_SCOUT_RUN_CAP_MICRO_USD",
    ]) {
      expect(example).toMatch(new RegExp(`^${k}=`, "m"));
    }
  });
});

describe("scoutSettingsFromEnv", () => {
  it("defaults to threshold 60, $0.25 per lead, $3 per run; reads integers only", () => {
    expect(scoutSettingsFromEnv({})).toEqual({
      fitThreshold: 60,
      perLeadBudgetMicroUsd: 250_000n,
      runCapMicroUsd: 3_000_000n,
    });
    expect(
      scoutSettingsFromEnv({
        OUTREACH_FIT_THRESHOLD: "70",
        OUTREACH_PER_LEAD_BUDGET_MICRO_USD: "100000",
        OUTREACH_SCOUT_RUN_CAP_MICRO_USD: "",
      }),
    ).toEqual({ fitThreshold: 70, perLeadBudgetMicroUsd: 100_000n, runCapMicroUsd: 3_000_000n });
    expect(() => scoutSettingsFromEnv({ OUTREACH_PER_LEAD_BUDGET_MICRO_USD: "0.25" })).toThrow();
  });
});

describe("ScoutMaterial", () => {
  it("numbers lines 1-based and caps what the scout sees", () => {
    const mat = new ScoutMaterial(
      [{ path: "./README.md", text: "a\nb\nc" }],
      "https://github.com/o/r",
      "main",
    );
    expect(mat.numbered("README.md", 2, 1000)).toEqual({ text: "L1: a\nL2: b", truncated: true });
    expect(mat.permalink("README.md", 3)).toBe("https://github.com/o/r/blob/main/README.md#L3");
  });
});
