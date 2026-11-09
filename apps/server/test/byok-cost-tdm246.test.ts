// TDM-246 [21.6]: model-token cost for BYOK trials (plan.md 17.2 rule 5's exception).
//   - a kit whose every contender runs on the Anthropic key with one pinned Claude Code version
//     scores cost = compute + the scored attempt's metered tokens: `cost` and `cost-per-test` rank
//     the setup that is cheaper in tokens first, even when its computer ran longer;
//   - any other (mixed) kit keeps compute + Naïve proxy spend;
//   - a BYOK trial with no reading has no cost under the token basis (never computer time alone);
//   - the report says the cost includes model tokens and how they were measured;
//   - trialMetrics records the basis and the attempt's tokens on the trial;
//   - per-attempt spend: a retried attempt never lowers the trial's recorded spend, and scoring
//     reads the scored attempt's own (local Postgres).
import path from "node:path";
import { isAgentDriver, newId, TrialIdSchema, toJsonValue, type KitSpec } from "@anybench/core";
import { leaseOwnerBase } from "@anybench/bench";
import { loadKit } from "@anybench/kit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contenders, kits, runs, trials, users } from "../src/db/schema/index.js";
import { drizzleTrialExecStore } from "../src/jobs/trial-execute.js";
import {
  CURATED_HARNESS_LEAGUE_KIT,
  defaultKitsDir,
  LEAGUE_V1_WORKLOAD,
  leagueProfile,
} from "../src/orchestrator/curated.js";
import type { StageTrial } from "../src/orchestrator/ports.js";
import {
  buildSummary,
  HARNESS_LEAGUE_DISCLOSURE,
  storedScoreOf,
  trialResultOf,
} from "../src/orchestrator/proof-score.js";
import {
  attemptTokenSpend,
  byokInputsOf,
  recordTrialMetrics,
  trialMetrics,
} from "../src/orchestrator/trial-metrics.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const TOKENS_LINE =
  "cost includes model tokens at list price, as reported by Claude Code 2.1.319's session totals";

/** The league's v1 cut with only A (solo, the baseline) and D (Tandem ×3). */
async function soloVsTandem(): Promise<KitSpec> {
  const kit = (await loadKit(path.join(defaultKitsDir(), CURATED_HARNESS_LEAGUE_KIT))).spec;
  const cut = leagueProfile(kit, { workloads: [LEAGUE_V1_WORKLOAD], repeats: 5 });
  if (!cut.ok) throw new Error(cut.reason);
  return {
    ...cut.spec,
    contenders: cut.spec.contenders.filter((c) => c.id === "claude-code-solo" || c.id === "tandem"),
  };
}

/**
 * Five passing trials each. A: a long computer ($0.50) but $3 of tokens; D: a short computer
 * ($0.10) but $10 of tokens. By computer time D is cheaper; with tokens A is.
 */
function trialsTdm246(over: Partial<Record<string, Record<string, number>>> = {}): StageTrial[] {
  const out: StageTrial[] = [];
  for (const [contender, compute, tokens] of [
    ["claude-code-solo", 500_000n, 3_000_000],
    ["tandem", 100_000n, 10_000_000],
  ] as const) {
    for (let repeat = 0; repeat < 5; repeat++) {
      out.push({
        id: `${contender}-${repeat}`,
        contender,
        contender_id: contender,
        workload_id: LEAGUE_V1_WORKLOAD,
        repeat,
        state: "done",
        attempt: 1,
        metrics: {
          wall_s: contender === "tandem" ? 1300 + repeat : 800 + repeat,
          hidden_test_fraction: 1,
          hidden_tests_passed: 120,
          hidden_tests_total: 120,
          byok_token_cost_micro_usd: tokens + repeat,
          ...over[`${contender}-${repeat}`],
        },
        gate: { "hidden-tests": { pass: true, reason: "120/120", evidence: [] } },
        cost_micro_usd: compute,
      });
    }
  }
  return out;
}

function costCell(score: ReturnType<typeof storedScoreOf>, contender: string, req: string) {
  const c = score.kit_score.contenders.find((x) => x.contenderId === contender)!;
  const r = c.requirements.find((x) => x.requirementId === req)!;
  return r.scored ? { value: r.byWorkload[0]!.value, fraction: r.fraction } : { unscored: r.code };
}

describe("BYOK token cost in the score (TDM-246, no DB)", () => {
  let spec: KitSpec;
  beforeAll(async () => {
    spec = await soloVsTandem();
  });

  it("all on the Anthropic key, one Claude Code: cost and cost-per-test count tokens and rank the cheaper-in-tokens setup first", () => {
    const score = storedScoreOf(spec, trialsTdm246());
    const a = costCell(score, "claude-code-solo", "cost");
    const d = costCell(score, "tandem", "cost");
    // Spend per solve: compute + tokens (median over the five).
    expect(a.value).toBe(500_000 + 3_000_002);
    expect(d.value).toBe(100_000 + 10_000_002);
    expect(a.fraction!).toBeGreaterThan(d.fraction!);
    const aPer = costCell(score, "claude-code-solo", "cost-per-test");
    const dPer = costCell(score, "tandem", "cost-per-test");
    expect(aPer.value!).toBeLessThan(dPer.value!);
    expect(aPer.fraction!).toBeGreaterThan(dPer.fraction!);
  });

  it("a mixed kit keeps compute + proxy: the same trials rank D first on cost", () => {
    const mixed: KitSpec = {
      ...spec,
      contenders: spec.contenders.map((c) =>
        c.id === "tandem" && isAgentDriver(c.driver)
          ? {
              ...c,
              driver: { ...c.driver, env: { ...c.driver.env, AB_TOKEN_SOURCE: "naive_proxy" } },
            }
          : c,
      ),
    };
    const score = storedScoreOf(mixed, trialsTdm246());
    expect(costCell(score, "claude-code-solo", "cost").value).toBe(500_000);
    expect(costCell(score, "tandem", "cost").value).toBe(100_000);
    expect(costCell(score, "tandem", "cost").fraction!).toBeGreaterThan(
      costCell(score, "claude-code-solo", "cost").fraction!,
    );
  });

  it("a BYOK trial with no token reading has no cost under the token basis, never computer time alone", () => {
    const noReading = trialsTdm246()[0]!;
    noReading.metrics = { ...(noReading.metrics as object), byok_token_cost_micro_usd: undefined };
    const r = trialResultOf(noReading, {
      kind: "compute_byok_tokens",
      tokenSource: "anthropic_key",
      claudeCodeVersion: "2.1.319",
    });
    expect(r.ok && r.result.metrics.cost_micro_usd).toBeUndefined();
    // The trial's own (agent-writable) cost_micro_usd never counts.
    const forged = trialsTdm246({ "claude-code-solo-0": { cost_micro_usd: 1 } })[0]!;
    const f = trialResultOf(forged, {
      kind: "compute_byok_tokens",
      tokenSource: "anthropic_key",
      claudeCodeVersion: "2.1.319",
    });
    expect(f.ok && f.result.metrics.cost_micro_usd).toBe(3_500_000);
    // The proxy basis ignores the token reading entirely.
    const p = trialResultOf(trialsTdm246()[0]!, { kind: "compute_proxy" });
    expect(p.ok && p.result.metrics.cost_micro_usd).toBe(500_000);
  });

  it("the report says the cost includes model tokens and how they were measured; a mixed kit's does not", () => {
    const trials = trialsTdm246();
    const built = buildSummary({
      kit: spec,
      score: storedScoreOf(spec, trials),
      proof: [],
      trials,
      disclosure: HARNESS_LEAGUE_DISCLOSURE,
    });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.analysis.md).toContain(TOKENS_LINE);
    const mixed: KitSpec = {
      ...spec,
      contenders: spec.contenders.map((c) =>
        c.id === "tandem"
          ? { ...c, versions: { ...c.versions, CLAUDE_CODE_VERSION: "2.1.320" } }
          : c,
      ),
    };
    const m = buildSummary({ kit: mixed, score: storedScoreOf(mixed, trials), proof: [], trials });
    expect(m.ok && m.analysis.md).not.toContain("cost includes model tokens");
  });

  it("trialMetrics records the attempt's tokens and the basis on the trial (recomputed, never kept stale)", () => {
    const base = {
      attempt: 2,
      existing: { byok_token_cost_micro_usd: 99, cost_includes_model_tokens: 1, other: 5 },
      costMicroUsd: 40_000n,
      edges: [],
      gate: null,
      proxy: { status: "none" as const },
    };
    const byAttempt = { "1": "7000000", "2": "2500000" };
    const m = trialMetrics({
      ...base,
      ...byokInputsOf({ attempt: 2, proxyKeyId: null, tokenSpendByAttempt: byAttempt }),
      costBasis: {
        kind: "compute_byok_tokens",
        tokenSource: "anthropic_key",
        claudeCodeVersion: "2.1.319",
      },
    });
    expect(m.metrics).toMatchObject({
      byok_token_cost_micro_usd: 2_500_000,
      cost_includes_model_tokens: 1,
      other: 5,
    });
    // The column stays compute + proxy: BYOK tokens are never billed.
    expect(m.costMicroUsd).toBe(40_000n);
    const proxyKit = trialMetrics({ ...base, costBasis: { kind: "compute_proxy" } });
    expect(proxyKit.metrics.cost_includes_model_tokens).toBe(0);
    expect(proxyKit.metrics).not.toHaveProperty("byok_token_cost_micro_usd");
    // A trial on a proxy key has no BYOK tokens.
    expect(byokInputsOf({ attempt: 1, proxyKeyId: "k", tokenSpendByAttempt: byAttempt })).toEqual(
      {},
    );
    expect(attemptTokenSpend(byAttempt, 3)).toBeNull();
    expect(attemptTokenSpend(null, 1)).toBeNull();
  });
});

const available = await pgAvailableTdm11();

describe.skipIf(!available)("per-attempt token spend (TDM-246, local Postgres)", () => {
  let h: FreshDbTdm11;
  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 2 });
  }, 60_000);
  afterAll(async () => {
    await h?.drop();
  });

  it("a retried attempt adds to the trial's spend instead of overwriting it; scoring reads the scored attempt's own", async () => {
    const [u] = await h.db
      .insert(users)
      .values({ githubLogin: "tdm246", githubId: 246_001 })
      .returning();
    const spec = await soloVsTandem();
    const [run] = await h.db
      .insert(runs)
      .values({ ownerId: u!.id, question: "q", budgetMicroUsd: 1_000_000n, state: "running" })
      .returning();
    const [kit] = await h.db
      .insert(kits)
      .values({ ownerId: u!.id, runId: run!.id, version: 1, spec: toJsonValue(spec), hash: "h246" })
      .returning();
    await h.db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run!.id));
    const [c] = await h.db
      .insert(contenders)
      .values({ runId: run!.id, kitId: kit!.id, source: "claude-code-solo", role: "baseline" })
      .returning();
    const id = newId(TrialIdSchema);
    await h.db.insert(trials).values({
      id,
      ownerId: u!.id,
      runId: run!.id,
      contenderId: c!.id,
      workloadId: LEAGUE_V1_WORKLOAD,
      repeat: 0,
      state: "running",
    });
    const store = drizzleTrialExecStore(h.db);
    const owner = `${leaseOwnerBase("tdm246-w", new Date(Date.now() - 1000))}~n`;
    const row = async () => (await h.db.select().from(trials).where(eq(trials.id, id)))[0]!;
    await h.db.update(trials).set({ leaseOwner: owner }).where(eq(trials.id, id));

    // Attempt 1 spent $7 on the key, then failed for our infra; attempt 2 spent $2.50.
    expect(await store.patch(id, owner, { token_spend_micro_usd: 7_000_000n })).toBe(true);
    await h.db.update(trials).set({ attempt: 2 }).where(eq(trials.id, id));
    expect(await store.patch(id, owner, { token_spend_micro_usd: 2_500_000n })).toBe(true);
    let r = await row();
    expect(r.tokenSpendMicroUsd).toBe(9_500_000n);
    expect(r.tokenSpendByAttempt).toEqual({ "1": "7000000", "2": "2500000" });
    // The same attempt written again replaces its own entry (idempotent), never double-counts.
    expect(await store.patch(id, owner, { token_spend_micro_usd: 2_600_000n })).toBe(true);
    r = await row();
    expect(r.tokenSpendMicroUsd).toBe(9_600_000n);
    // A patch without a reading leaves the spend alone.
    expect(await store.patch(id, owner, { token_spend_micro_usd: null })).toBe(true);
    expect((await row()).tokenSpendMicroUsd).toBe(9_600_000n);

    // Scored on attempt 2 only: the infra-failed attempt 1 never counts against the contender.
    await h.db.update(trials).set({ state: "done", leaseOwner: null }).where(eq(trials.id, id));
    const written = await recordTrialMetrics(
      h.db,
      await row(),
      { status: "none" },
      {
        costBasis: {
          kind: "compute_byok_tokens",
          tokenSource: "anthropic_key",
          claudeCodeVersion: "2.1.319",
        },
      },
    );
    expect(written?.metrics).toMatchObject({
      byok_token_cost_micro_usd: 2_600_000,
      cost_includes_model_tokens: 1,
    });
  });
});
