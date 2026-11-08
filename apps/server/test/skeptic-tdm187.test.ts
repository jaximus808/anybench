// TDM-187 [16.16]: skepticReview, the orchestrator seam, on local Postgres + FakeNaive: the cli
// example passes, the Tandem kit needs repair, a verified model block turns a pass into repair, a
// model-only (unverified) block does not, the family rule refuses before any session, a re-check
// after a repair is a new session, and the session is persisted and costed. No network, no spend.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadKit } from "@anybench/kit";
import { FakeNaive } from "@anybench/naive/fake";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentSessions, costEntries, runs } from "../src/db/schema/index.js";
import type { RunIntake, StageContext, StageEventDraft } from "../src/orchestrator/ports.js";
import {
  kitSkeptic,
  SKEPTIC_BUDGET_MICRO_USD,
  skepticReview,
} from "../src/orchestrator/skeptic.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { seedUserTdm67 } from "./helpers/runs-tdm67.js";

const available = await pgAvailableTdm11();
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_KIT = path.join(here, "../../../packages/kit/examples/cli");
const TANDEM_KIT = path.join(here, "../../../kits/tandem-vs-claude-code");

describe.skipIf(!available)("skepticReview on Postgres + FakeNaive (TDM-187)", () => {
  let h: FreshDbTdm11;
  let userId: string;
  const naive = new FakeNaive();

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 4 });
    userId = await seedUserTdm67(h.db, "tdm187");
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  async function ctxTdm187(): Promise<StageContext & { emitted: StageEventDraft[] }> {
    const intake: RunIntake = {
      source: { kind: "github", github: "example/tool" },
      contenders: [],
      auto_go: true,
    };
    const [r] = await h.db
      .insert(runs)
      .values({ ownerId: userId, question: "is it faster?", budgetMicroUsd: 10_000_000n, intake })
      .returning();
    const emitted: StageEventDraft[] = [];
    return {
      emitted,
      run: {
        id: r!.id,
        owner_id: userId,
        project_id: null,
        question: "is it faster?",
        intake,
        budget_micro_usd: 10_000_000n,
        spent_micro_usd: 0n,
      },
      idempotencyKey: `${r!.id}:kit_draft:0`,
      signal: new AbortController().signal,
      emit: async (d) => {
        emitted.push(...d);
      },
    };
  }

  const creates = () => naive.sessionCreates.filter((c) => !c.replayed);

  it("the cli example: no blocks, the model agrees → pass; session persisted and costed", async () => {
    const ctx = await ctxTdm187();
    const kit = await loadKit(CLI_KIT);
    naive.script("skeptic", {
      output: { verdict: "pass", summary: "fair: GNU grep is an independent oracle", findings: [] },
      costMicroUsd: 2_400n,
    });
    const before = creates().length;
    const r = await skepticReview(
      { db: h.db, client: naive },
      { ctx, kitDir: CLI_KIT, spec: kit.spec },
    );
    expect(r).toMatchObject({
      ok: true,
      value: {
        verdict: "pass",
        costMicroUsd: 2_400n,
        model: "openai/gpt-5-mini",
        advisoryVerdict: "pass",
      },
    });
    expect(creates()).toHaveLength(before + 1);
    const create = naive.sessionCreates.at(-1)!;
    expect(create.role).toBe("skeptic");
    expect(create.body.budgetMicroUsd).toBe(SKEPTIC_BUDGET_MICRO_USD);
    const message = JSON.parse(create.body.message) as Record<string, unknown>;
    expect(Object.keys(message).sort()).toEqual([
      "contender_help",
      "deterministic_findings",
      "hidden_tests",
      "kit",
      "manifest",
      "proof_results",
      "understanding",
    ]);
    const [row] = await h.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.runId, ctx.run.id));
    expect(row).toMatchObject({ role: "skeptic", status: "done", costMicroUsd: 2_400n });
    const costs = await h.db.select().from(costEntries).where(eq(costEntries.runId, ctx.run.id));
    expect(costs.map((c) => c.amountMicroUsd)).toEqual([2_400n]);
    const said = ctx.emitted.map((e) => (e.payload as { text?: string }).text ?? "");
    expect(said.some((t) => t.startsWith("skeptic (openai/gpt-5-mini): pass, 0 block"))).toBe(true);
  });

  it("a skeptic session that fails once is retried on a fresh key; failing twice holds", async () => {
    const kit = await loadKit(CLI_KIT);
    const ctx = await ctxTdm187();
    naive.script(
      "skeptic",
      { output: { not: "the schema" } },
      { output: { verdict: "pass", summary: "", findings: [] } },
    );
    const before = creates().length;
    const ok = await skepticReview(
      { db: h.db, client: naive },
      { ctx, kitDir: CLI_KIT, spec: kit.spec },
    );
    expect(ok).toMatchObject({ ok: true, value: { verdict: "pass" } });
    expect(creates()).toHaveLength(before + 2);
    const said = ctx.emitted.map((e) => (e.payload as { text?: string }).text ?? "");
    expect(said.some((t) => t.includes("retrying once"))).toBe(true);

    const ctx2 = await ctxTdm187();
    naive.script("skeptic", { output: { not: "the schema" } }, { output: { still: "wrong" } });
    const held = await skepticReview(
      { db: h.db, client: naive },
      { ctx: ctx2, kitDir: CLI_KIT, spec: kit.spec },
    );
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.reason).toMatch(/skeptic review could not run/);
  });

  it("a verified model block → repair; an unverified one stays a warning", async () => {
    const kit = await loadKit(CLI_KIT);
    const ctx = await ctxTdm187();
    naive.script("skeptic", {
      output: {
        verdict: "repair",
        summary: "the second workload is trivial",
        findings: [
          {
            check: "noop_passable",
            severity: "block",
            evidence: "anybench.yaml:40",
            quote: "id: literal-search",
            why: "a literal search over 3 files cannot separate the contenders",
          },
          {
            check: "other",
            severity: "block",
            evidence: "anybench.yaml:1",
            quote: "not on that line",
            why: "made up",
          },
        ],
      },
    });
    const r = await skepticReview(
      { db: h.db, client: naive },
      { ctx, kitDir: CLI_KIT, spec: kit.spec },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.verdict).toBe("repair");
    const model = r.value.findings.filter((f) => f.source === "model");
    expect(model.map((f) => f.severity)).toEqual(["block", "warn"]);
  });

  it("the Tandem kit → repair whatever the model advises; a re-check (attempt 1) is a new session", async () => {
    const kit = await loadKit(TANDEM_KIT);
    const ctx = await ctxTdm187();
    naive.script("skeptic", { output: { verdict: "pass", summary: "", findings: [] } });
    const r = await skepticReview(
      { db: h.db, client: naive },
      { ctx, kitDir: TANDEM_KIT, spec: kit.spec },
    );
    expect(r).toMatchObject({ ok: true, value: { verdict: "repair", advisoryVerdict: "pass" } });
    if (!r.ok) return;
    expect(
      r.value.findings
        .filter((f) => f.severity === "block")
        .map((f) => f.check)
        .sort(),
    ).toEqual(["solution_leakage", "solution_leakage", "weak_do_less"]);

    const n = creates().length;
    // Same visit, same attempt: replayed, not paid twice.
    await skepticReview({ db: h.db, client: naive }, { ctx, kitDir: TANDEM_KIT, spec: kit.spec });
    expect(creates()).toHaveLength(n);
    naive.script("skeptic", { output: { verdict: "repair", summary: "", findings: [] } });
    await skepticReview(
      { db: h.db, client: naive },
      { ctx, kitDir: TANDEM_KIT, spec: kit.spec, attempt: 1 },
    );
    expect(creates()).toHaveLength(n + 1);
  });

  it("no independent model → hold, and no Naïve session is created", async () => {
    const kit = await loadKit(TANDEM_KIT);
    const ctx = await ctxTdm187();
    const n = naive.sessionCreates.length;
    const r = await skepticReview(
      { db: h.db, client: naive },
      {
        ctx,
        kitDir: TANDEM_KIT,
        spec: kit.spec,
        models: ["anthropic/claude-haiku-4.5", "deepseek/deepseek-v4-pro"],
      },
    );
    expect(r).toMatchObject({ ok: false, outcome: "needs_human" });
    expect(!r.ok && r.reason).toMatch(
      /^skeptic: no model independent of the designer and every contender: .*from anthropic.*deepseek/,
    );
    expect(naive.sessionCreates).toHaveLength(n);
  });

  it("a kit dir that does not load → hold with the reason", async () => {
    const kit = await loadKit(CLI_KIT);
    const ctx = await ctxTdm187();
    const r = await skepticReview(
      { db: h.db, client: naive },
      { ctx, kitDir: path.join(here, "no-such-kit-tdm187"), spec: kit.spec },
    );
    expect(r).toMatchObject({ ok: false, outcome: "needs_human" });
    expect(!r.ok && r.reason).toMatch(/does not load: BLOCK kit_invalid/);
  });

  it("kitSkeptic (the kit designer's seam): pass → ok, repair → the blocks as fix issues, no model → refused", async () => {
    const seam = kitSkeptic({ db: h.db, client: naive });
    const cli = await loadKit(CLI_KIT);
    const tandem = await loadKit(TANDEM_KIT);
    const draft = {} as never;
    naive.script("skeptic", { output: { verdict: "pass", summary: "", findings: [] } });
    expect(await seam(await ctxTdm187(), { spec: cli.spec, dir: CLI_KIT, draft })).toEqual({
      ok: true,
    });

    naive.script("skeptic", { output: { verdict: "pass", summary: "", findings: [] } });
    const repair = await seam(await ctxTdm187(), {
      spec: tandem.spec,
      dir: TANDEM_KIT,
      draft,
      attempt: 0,
    });
    expect(repair.ok).toBe(false);
    if (repair.ok) return;
    expect(repair.repair).toHaveLength(3);
    expect(repair.repair!.every((l) => l.startsWith("skeptic: BLOCK "))).toBe(true);
    expect(repair.reason).toMatch(/^repair: skeptic: BLOCK solution_leakage workloads\/bug-hunt/);

    const refused = await kitSkeptic(
      { db: h.db, client: naive },
      { models: ["anthropic/claude-sonnet-5.5"] },
    )(await ctxTdm187(), { spec: cli.spec, dir: CLI_KIT, draft });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok === false && refused.repair).toBeUndefined();
  });
});
