// Demo proof + scoring + summary (TDM-54 follow-up): the curated Tandem kit's signed-off offline
// proof, scoreKit over fake trials, the deterministic summary (no LLM) and GET /runs/:id/report.
// A full Tandem run with fake trials goes to delivered; a non-curated kit holds at proof; the
// summary carries scoreKit's verdicts (TDM-175): "no detectable difference at n=…, smallest
// detectable difference=…" at n=1, "better on these 8 tasks" for a planted effect. DEMO_EVIDENCE=1 prints it.
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AnybenchEventSchema, PROOF_CHECKS, type KitSpec, type RunId } from "@anybench/core";
import { loadKit } from "@anybench/kit";
import { FakeProvider } from "@anybench/providers";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, kits, reports, runs, trials } from "../src/db/schema/index.js";
import type { JobDef } from "../src/jobs/types.js";
import { appendEvents } from "../src/lib/events.js";
import {
  CURATED_LONG_HORIZON_KIT,
  CURATED_TANDEM_KIT,
  curatedDisclosure,
  curatedKitOfSpec,
  defaultKitsDir,
  longHorizonSmokeProfile,
  smokeProfile,
} from "../src/orchestrator/curated.js";
import { FakeAgentStages, FakePipeline } from "../src/orchestrator/fake.js";
import { curatedKitStages } from "../src/orchestrator/curated.js";
import {
  buildSummary,
  curatedProof,
  kitScore,
  PROOF_SUITE_UNAVAILABLE,
  proofAccepted,
  LONG_HORIZON_DISCLOSURE,
  LONG_HORIZON_PROOF_SIGNOFF,
  TANDEM_DISCLOSURE,
  TANDEM_PROOF_SIGNOFF,
} from "../src/orchestrator/proof-score.js";
import type { PipelinePort, StageContext, StageTrial } from "../src/orchestrator/ports.js";
import { fakeRunnerTdm49 } from "./helpers/fake-runner-tdm49.js";
import {
  digestTdm54,
  drainTdm54,
  kitTdm54,
  MemQueueTdm54,
  workerTdm54,
} from "./helpers/orchestrator-tdm54.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { runsAppTdm67, seedUserTdm67, type RunsAppTdm67 } from "./helpers/runs-tdm67.js";

const available = await pgAvailableTdm11();
const BASE = "http://api.test";
const N1 = "no detectable difference at n=1";

/** trial.gate for this test: a real TrialGateRecord (every applicable gate passes) + metrics. */
function demoGateJob(): JobDef {
  return {
    name: "trial.gate",
    payload: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
    async run(raw, ctx) {
      const p = raw as { trial_id: string; attempt: number };
      await ctx.db.transaction(async (tx) => {
        const [cur] = await tx.select().from(trials).where(eq(trials.id, p.trial_id));
        if (!cur || cur.state !== "collecting") return;
        const outcome = (pass: boolean, reason: string) => ({
          result: { pass, reason, evidence: [], applicable: true },
          status: "verdict" as const,
          exit_code: 0,
          timed_out: false,
          duration_ms: 1,
          log_tail: "",
          kit_suspect: false,
        });
        const record = {
          version: 1,
          trial_id: cur.id,
          workload_id: cur.workloadId,
          scored_at: new Date().toISOString(),
          scoring_computer: null,
          sandbox: "demo-test",
          outputs_sha256: null,
          gates: {
            "hidden-tests": outcome(true, "16/16 hidden tests passed"),
            "api-load": outcome(true, "p95 under 120 ms"),
          },
        };
        const [t] = await tx
          .update(trials)
          .set({
            state: "done",
            gate: record,
            // A runner-reported cost is ignored by the scorer (plan 17.2 rule 5).
            metrics: { wall_s: 600, api_p95_ms: 6.5, cost_micro_usd: 1 },
            costMicroUsd: 2_500_000n,
            updatedAt: sql`now()`,
          })
          .where(and(eq(trials.id, p.trial_id), eq(trials.state, "collecting")))
          .returning();
        if (!t) return;
        const at = new Date().toISOString();
        const ev = (from: "collecting" | "gating", to: "gating" | "done") =>
          AnybenchEventSchema.parse({
            run_id: t.runId,
            seq: 0,
            type: "trial.phase",
            source: "trial",
            source_id: t.id,
            severity: "info",
            actor: { kind: "worker", id: ctx.workerId },
            at,
            payload: { from, to, attempt: t.attempt },
          });
        await appendEvents(tx, t.runId as RunId, [
          ev("collecting", "gating"),
          ev("gating", "done"),
        ]);
      });
    },
  };
}

describe.skipIf(!available)("demo proof, scoring and summary", () => {
  let h: FreshDbTdm11;
  let api: RunsAppTdm67;
  let userId: string;
  let seq = 0;

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 8 });
    api = runsAppTdm67(h.url);
    userId = await seedUserTdm67(h.db, "demo-proof-score");
  }, 60_000);

  afterAll(async () => {
    await api?.dbh.close();
    await h?.drop();
  });

  async function createRun(queue: MemQueueTdm54, body: Record<string, unknown>) {
    const before = api.jobs.jobs.length;
    const res = await api.app.request(`${BASE}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
      body: JSON.stringify({ budget_micro_usd: "50000000", ...body }),
    });
    const json = (await res.json()) as { run?: { id: string } };
    expect(res.status, JSON.stringify(json)).toBe(201);
    for (const j of api.jobs.jobs.slice(before)) {
      void queue.add(j.task, j.payload, { jobKey: j.jobKey });
    }
    return json.run!.id;
  }

  function worker(agents: Parameters<typeof workerTdm54>[5]["agents"], pipeline: PipelinePort) {
    const queue = new MemQueueTdm54();
    const fake = new FakeProvider({ name: `fake-demo-${seq}` });
    fakeRunnerTdm49(fake, { stepMs: 5 });
    const w = workerTdm54(h.db, h.url, `demo-worker-${seq++}`, queue, fake, {
      agents,
      pipeline: () => pipeline,
      billingGate: () => async () => ({ allowed: true }),
      charges: () => ({ recordRunCharges: async () => {} }),
    });
    w.handlers.set("trial.gate", demoGateJob());
    return { w, queue };
  }

  /** FakePipeline for ingest/env/estimate; the real proof and scoring ports. */
  function pipeline(): PipelinePort {
    const p = new FakePipeline({ digest: digestTdm54() });
    return {
      ingest: (ctx) => p.ingest(ctx),
      buildEnv: (ctx) => p.buildEnv(ctx),
      estimate: (ctx) => p.estimate(ctx),
      prove: curatedProof(),
      score: kitScore(),
    };
  }

  async function stateEdges(id: string) {
    const rows = await h.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.runId, id), eq(events.type, "run.state_changed")))
      .orderBy(asc(events.seq));
    return rows.map((r) => (r.payload as { to: string }).to);
  }

  it("the Tandem repo: curated proof, fake trials, scoreKit, the summary, delivered; GET /runs/:id/report", async () => {
    const { w, queue } = worker(() => curatedKitStages(), pipeline());
    const id = await createRun(queue, {
      question: "Smoke test on tandem-vs-claude-code: does Tandem beat Claude Code?",
      source: { kind: "github", github: "jaximus808/tandem", ref: "main" },
      // New users don't auto-start (auto_start_runs defaults off): ask for auto-go explicitly,
      // as the New run form's "start automatically" does. The billing gate still applies.
      auto_go: true,
    });
    await drainTdm54(w, queue);
    const [run] = await h.db.select().from(runs).where(eq(runs.id, id));
    expect(run!.state, run!.pausedReason ?? "").toBe("delivered");
    expect(await stateEdges(id)).toEqual([
      "intake",
      "understand",
      "research",
      "kit_draft",
      "env_build",
      "proof",
      "awaiting_go",
      "running",
      "scoring",
      "analyzing",
      "delivered",
    ]);

    // Proof: only the offline-verified checks pass; the rest say "not run".
    const [kit] = await h.db.select().from(kits).where(eq(kits.id, run!.kitId!));
    const proof = kit!.proof as { check: string; pass: boolean; reason: string }[];
    expect(proof.map((p) => p.check)).toEqual([...PROOF_CHECKS]);
    expect(proof.filter((p) => p.pass).map((p) => p.check)).toEqual([
      "oracle_passes",
      "do_less_fails",
    ]);
    expect(proof.find((p) => p.check === "oracle_passes")!.reason).toBe(
      "proof: curated (verified offline at bebb77e): oracle 42/42 hidden tests passed (100% on 3/3 tasks)",
    );
    for (const p of proof.filter((x) => !x.pass)) expect(p.reason).toMatch(/^not run: /);
    const outputs = run!.stageOutputs as {
      proof_basis: { label: string; commit: string; kit_id: string };
      score: { n_per_setup: { min: number; max: number }; trials: { scored: number } };
    };
    expect(outputs.proof_basis).toMatchObject({
      label: "proof: curated (verified offline at bebb77e)",
      commit: TANDEM_PROOF_SIGNOFF.commit,
      kit_id: kit!.id,
    });
    // The smoke profile: 3 setups × todo-api × 1 repeat.
    expect(outputs.score.trials.scored).toBe(3);
    expect(outputs.score.n_per_setup).toEqual({ min: 1, max: 1 });

    const [rep] = await h.db.select().from(reports).where(eq(reports.runId, id));
    expect(rep!.md).toContain(N1);
    expect(rep!.md).toContain(TANDEM_DISCLOSURE);
    expect(rep!.md).toContain("proof: curated (verified offline at bebb77e)");
    expect(rep!.md).not.toMatch(/\b(beats|faster|cheaper|better than)\b/i);

    const res = await api.app.request(`${BASE}/runs/${id}/report`, {
      headers: { authorization: `Bearer ${userId}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: {
        run_id: string;
        answer: string;
        contenders: {
          name: string;
          score: null;
          requirements: { requirement_id: string; value: number | null }[];
        }[];
      };
    };
    expect(body.report.run_id).toBe(id);
    expect(body.report.answer).toContain(N1);
    expect(body.report.answer).toContain(TANDEM_DISCLOSURE);
    expect(body.report.contenders).toHaveLength(3);
    for (const c of body.report.contenders) {
      expect(c.score).toBeNull();
      const byId = Object.fromEntries(c.requirements.map((r) => [r.requirement_id, r.value]));
      expect(byId["tests-pass"]).toBe(1);
      expect(byId["api-p95"]).toBe(6.5);
      // Provider-side cost (trials.cost_micro_usd), never the runner-reported 1.
      expect(byId.cost).toBe(2_500_000);
    }
    const md = await api.app.request(`${BASE}/runs/${id}/report/markdown`, {
      headers: { authorization: `Bearer ${userId}` },
    });
    expect(md.status).toBe(200);
    expect(await md.text()).toBe(rep!.md);

    if (process.env.DEMO_EVIDENCE === "1") {
      console.log(`\n[demo evidence] run ${id} → ${run!.state}\n\n${rep!.md}\n`);
      console.log(`[demo evidence] GET /runs/${id}/report answer: ${body.report.answer}\n`);
    }
  }, 120_000);

  it("TDM-233: the Tandem repo's default long-horizon kit: its own sign-off, its disclosure, delivered", async () => {
    const { w, queue } = worker(() => curatedKitStages(), pipeline());
    const id = await createRun(queue, {
      question: "Smoke test: does Tandem beat Claude Code on a whole app?",
      source: { kind: "github", github: "jaximus808/tandem", ref: "main" },
      auto_go: true,
    });
    await drainTdm54(w, queue);
    const [run] = await h.db.select().from(runs).where(eq(runs.id, id));
    expect(run!.state, run!.pausedReason ?? "").toBe("delivered");
    const [kit] = await h.db.select().from(kits).where(eq(kits.id, run!.kitId!));
    expect(kit!.filesUrl).toContain(`kits/${CURATED_LONG_HORIZON_KIT}`);
    const proof = kit!.proof as { check: string; pass: boolean; reason: string }[];
    const label = `proof: curated (verified offline at ${LONG_HORIZON_PROOF_SIGNOFF.commit.slice(0, 7)})`;
    expect(proof.filter((p) => p.pass).map((p) => [p.check, p.reason])).toEqual([
      [
        "oracle_passes",
        `${label}: oracle 120/120, 120/120, 120/120 hidden tests passed (3 runs), 600/600, 600/600, 600/600 on project-tracker-xl (3 runs)`,
      ],
      [
        "do_less_fails",
        `${label}: do-nothing 1/120 passed, 1/600 on project-tracker-xl; partial-oracle 106/120 passed, gate failed, 515/600 on project-tracker-xl, gate failed`,
      ],
    ]);
    const outputs = run!.stageOutputs as {
      proof_basis: { source: string; commit: string };
      score: { trials: { scored: number; infra: number } };
    };
    expect(outputs.proof_basis).toMatchObject({
      source: LONG_HORIZON_PROOF_SIGNOFF.source,
      commit: LONG_HORIZON_PROOF_SIGNOFF.commit,
    });
    // The long-horizon smoke plans A solo and Tandem ×3 on project-tracker × 1 repeat. Its
    // setups buy tokens with the owner's stored Anthropic key (AB_TOKEN_SOURCE=anthropic_key);
    // this worker has no ANYBENCH_KEK, so both trials fail closed at prepare (TDM-212's rule) and
    // none is scored. What this test proves is the kit, its proof sign-off and its disclosure.
    expect(outputs.score.trials).toMatchObject({ scored: 0, infra: 2 });
    const [rep] = await h.db.select().from(reports).where(eq(reports.runId, id));
    expect(rep!.md).toContain(LONG_HORIZON_DISCLOSURE);
    expect(rep!.md).not.toContain(TANDEM_DISCLOSURE);
    expect(LONG_HORIZON_DISCLOSURE).toBe("tokens: anthropic-key, effort: default, thinking: on");
  }, 120_000);

  it("TDM-233: the long-horizon sign-off covers the kit and its smoke cut, not an edited copy", async () => {
    const spec = (await loadKit(path.join(defaultKitsDir(), CURATED_LONG_HORIZON_KIT))).spec;
    const ctx = { emit: async () => {} } as unknown as StageContext;
    const smoke = longHorizonSmokeProfile(spec);
    expect(smoke.ok).toBe(true);
    for (const kit of [spec, smoke.ok ? smoke.spec : spec]) {
      const r = await curatedProof()(ctx, { kit_id: "k", kit, env: null });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toMatchObject({
          basis: "curated",
          source: LONG_HORIZON_PROOF_SIGNOFF.source,
        });
      }
    }
    const edited = await curatedProof()(ctx, {
      kit_id: "k",
      kit: { ...spec, repeats: 2 },
      env: null,
    });
    expect(edited).toEqual({ ok: false, outcome: "needs_human", reason: PROOF_SUITE_UNAVAILABLE });
    // The analyst's disclosure follows the kit the spec came from.
    expect(await curatedKitOfSpec(spec)).toBe(CURATED_LONG_HORIZON_KIT);
    const short = (await loadKit(path.join(defaultKitsDir(), CURATED_TANDEM_KIT))).spec;
    expect(await curatedKitOfSpec(short)).toBe(CURATED_TANDEM_KIT);
    expect(curatedDisclosure(CURATED_TANDEM_KIT)).toBe(TANDEM_DISCLOSURE);
  });

  it("a non-curated kit holds at proof: proof suite not available yet", async () => {
    const stages = new FakeAgentStages({ kit: kitTdm54() });
    const { w, queue } = worker(() => stages, pipeline());
    const id = await createRun(queue, {
      question: "Is ripgrep faster than grep?",
      source: { kind: "github", github: "BurntSushi/ripgrep", ref: "14.1.1" },
    });
    await drainTdm54(w, queue);
    const [run] = await h.db.select().from(runs).where(eq(runs.id, id));
    expect(run).toMatchObject({ state: "needs_human", pausedReason: PROOF_SUITE_UNAVAILABLE });
    expect((run!.stageOutputs as { held_from?: string }).held_from).toBe("proof");
    const [kit] = await h.db.select().from(kits).where(eq(kits.id, run!.kitId!));
    expect(kit!.proof).toBeNull();
    expect((await stateEdges(id)).slice(-2)).toEqual(["proof", "needs_human"]);
  }, 60_000);

  it("an edited copy of the curated kit is not the signed-off kit: it holds", async () => {
    const kitsDir = defaultKitsDir();
    const spec = (await loadKit(path.join(kitsDir, CURATED_TANDEM_KIT))).spec;
    const edited: KitSpec = { ...spec, repeats: 2 };
    const emitted: unknown[] = [];
    const ctx = {
      emit: async (e: unknown[]) => void emitted.push(...e),
    } as unknown as StageContext;
    const r = await curatedProof()(ctx, { kit_id: "k", kit: edited, env: null });
    expect(r).toEqual({ ok: false, outcome: "needs_human", reason: PROOF_SUITE_UNAVAILABLE });
    const smoke = smokeProfile(spec);
    expect(smoke.ok).toBe(true);
    const ok = await curatedProof()(ctx, {
      kit_id: "k",
      kit: smoke.ok ? smoke.spec : spec,
      env: null,
    });
    expect(ok.ok).toBe(true);
  });

  it("a PROOF.md that changed since its sign-off holds", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "demo-proof-"));
    cpSync(path.join(defaultKitsDir(), CURATED_TANDEM_KIT), path.join(dir, CURATED_TANDEM_KIT), {
      recursive: true,
    });
    writeFileSync(path.join(dir, CURATED_TANDEM_KIT, "PROOF.md"), "Overall: RESULT: PASS\n");
    const spec = (await loadKit(path.join(dir, CURATED_TANDEM_KIT))).spec;
    const ctx = { emit: async () => {} } as unknown as StageContext;
    const r = await curatedProof({ kitsDir: dir })(ctx, { kit_id: "k", kit: spec, env: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/changed since its sign-off at bebb77e/);
  });
});

describe("demo summary wording (no DB)", () => {
  function trialsFor(n: number): StageTrial[] {
    const out: StageTrial[] = [];
    for (const contender of ["a", "b"]) {
      for (let repeat = 0; repeat < n; repeat++) {
        out.push({
          id: `${contender}-${repeat}`,
          contender,
          contender_id:
            contender === "a"
              ? "0190f5a0-0000-7000-8000-00000000000a"
              : "0190f5a0-0000-7000-8000-00000000000b",
          workload_id: "w1",
          repeat,
          state: "done",
          attempt: 1,
          metrics: { wall_s: contender === "a" ? 10 + repeat : 20 + repeat },
          gate: { g: { pass: true, reason: "ok", evidence: [] } },
          cost_micro_usd: 0n,
        });
      }
    }
    return out;
  }

  const kit = {
    subject: { name: "demo", kind: "agent" },
    contenders: [
      { id: "a", name: "A", role: "subject", driver: {} },
      { id: "b", name: "B", role: "baseline", driver: {} },
    ],
    workloads: [{ id: "w1" }],
    requirements: [
      {
        id: "wall",
        type: "measured",
        title: "Wall time",
        metric: "wall_s",
        unit: "s",
        better: "lower",
        gate_id: "g",
      },
    ],
    scoring: { weights: { wall: 100 } },
  } as unknown as KitSpec;

  async function summary(n: number) {
    const score = await kitScore()({} as StageContext, { kit_id: "k", kit, trials: trialsFor(n) });
    if (!score.ok) throw new Error(score.reason);
    const r = buildSummary({ kit, score: score.value, proof: [], trials: trialsFor(n) });
    if (!r.ok) throw new Error(r.reason);
    return r.analysis;
  }

  it("n=1 per setup: no detectable difference at n=1, with its smallest detectable difference", async () => {
    const a = await summary(1);
    expect(a.md).toContain(N1);
    expect(a.md).toContain("- a: w1 10 s (n=1, solved 1/1)");
    expect(a.md).toContain("- b: w1 20 s (n=1, solved 1/1)");
    // TDM-251: one task, so the verdict is the within-task one (the task-paired test is p=1 there).
    expect(a.md).toContain(
      "Verdict on w1 only, a vs b: no detectable difference at n=1 vs 1, smallest detectable difference=none reachable at this n",
    );
    expect(a.report.answer).toMatch(
      /^Within this task \(w1\), each setup vs B by exact two-sample tests on the trials' values, Holm-corrected across 1 test: A: no detectable difference at n=1 vs 1/,
    );
    expect(a.report.answer).toContain("On this task only (w1); no general claim from 1 task");
    expect(a.report.answer).toContain("No setup is ranked by a composite score.");
    expect(a.md).not.toMatch(/\b(beats|faster|cheaper|better than)\b/i);
    const req = a.report.contenders[0]!.requirements[0]!;
    expect(req.comparison).toMatchObject({ verdict: "indistinguishable", baseline_id: "b" });
    expect(a.report.contenders[0]!.wins).toEqual([]);
  });

  it("10 repeats on one task: the within-task test sees it, but a median over solved trials can't show better (TDM-251)", async () => {
    const ten = await summary(10);
    expect(ten.md).toContain(
      "Verdict on w1 only, a vs b: no detectable difference at n=10 vs 10, smallest detectable difference=|δ| 0.72",
    );
    expect(ten.md).toContain("it leans better, but the value is a median over solved trials only");
    expect(ten.report.answer).toContain(
      "A: no detectable difference at n=10 vs 10 (closest: wall, permutation p<0.001, Holm p<0.001; it is a median over solved trials only, so it can't show better)",
    );
    expect(ten.report.answer).not.toMatch(/insufficient tasks|over 1 task/);
  });

  it("a planted effect on 8 tasks is 'better on these 8 tasks' and becomes a win", async () => {
    const capped = {
      ...kit,
      workloads: Array.from({ length: 8 }, (_, i) => ({ id: `w${i}` })),
      requirements: [{ ...kit.requirements[0]!, cap: 600 }],
    } as unknown as KitSpec;
    const trials = Array.from({ length: 8 }, (_, w) =>
      trialsFor(5).map((t) => ({ ...t, id: `${t.id}-w${w}`, workload_id: `w${w}` })),
    ).flat();
    const score = await kitScore()({} as StageContext, { kit_id: "k", kit: capped, trials });
    if (!score.ok) throw new Error(score.reason);
    const r = buildSummary({ kit: capped, score: score.value, proof: [], trials });
    if (!r.ok) throw new Error(r.reason);
    expect(r.analysis.md).toMatch(
      /Verdict, a vs b: better on these 8 tasks: Cliff's δ \+1\.00 averaged over tasks/,
    );
    expect(r.analysis.report.contenders[0]!.wins).toEqual(["wall"]);
    expect(r.analysis.report.contenders[0]!.requirements[0]!.comparison).toMatchObject({
      verdict: "better",
      claim: "these_tasks",
      test: "task_paired",
    });
    if (process.env.DEMO_EVIDENCE === "1") console.log(r.analysis.md);
  });

  it("proofAccepted: all six passed, or a curated basis for exactly this kit row", () => {
    const six = PROOF_CHECKS.map((check) => ({ check, pass: true, reason: "", evidence: [] }));
    expect(proofAccepted({ id: "k1", proof: six }, {}, {})).toBe(true);
    const curated = PROOF_CHECKS.map((check) => ({
      check,
      pass: check === "oracle_passes" || check === "do_less_fails",
      reason: "",
      evidence: [],
    }));
    const basis = {
      basis: "curated",
      label: "proof: curated (verified offline at bebb77e)",
      source: TANDEM_PROOF_SIGNOFF.source,
      commit: TANDEM_PROOF_SIGNOFF.commit,
      sha256: TANDEM_PROOF_SIGNOFF.sha256,
      verified: ["oracle_passes", "do_less_fails"],
      kit_id: "k1",
    };
    expect(proofAccepted({ id: "k1", proof: curated }, {}, {})).toBe(false);
    expect(proofAccepted({ id: "k1", proof: curated }, { proof_basis: basis }, {})).toBe(true);
    expect(proofAccepted({ id: "k2", proof: curated }, { proof_basis: basis }, {})).toBe(false);
    const broken = curated.map((p) => (p.check === "oracle_passes" ? { ...p, pass: false } : p));
    expect(proofAccepted({ id: "k1", proof: broken }, { proof_basis: basis }, {})).toBe(false);
  });
});
