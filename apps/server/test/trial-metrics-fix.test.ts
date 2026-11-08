// metrics-fix: run 01a1b9ee (2026-11-08) delivered 11 graded trials with trials.metrics = null, so
// scoreKit said "metric missing" for wall and api-p95 and cost was the compute share alone
// (27 600 micro-USD on every trial, no tokens). Nothing in the trial path wrote trials.metrics.
//
// These tests run the curated head-to-head kit (the one that run used) through trial.gate on local
// Postgres with a FakeProvider scoring computer and a FakeProxySpend ledger, and pin:
//   - trial.gate writes wall_s (worker running → collecting edges), the passing api-load verdict's
//     api_p95_ms and cost = compute + the attempt's proxy-key spend, with the verdict;
//   - scoreKit then scores wall, cost and api-p95 for both setups (quality stays "not reviewed");
//   - unknown proxy spend leaves cost unscored instead of reporting compute alone;
//   - failed_subject trials get their cost recorded by trial.execute;
//   - the backfill recovers old trials (legacy p95 from the verdict text), is idempotent, and
//     re-scores the run and rebuilds the curated report.
import path from "node:path";
import {
  AnybenchEventSchema,
  newId,
  RunIdSchema,
  TrialIdSchema,
  type KitSpec,
} from "@anybench/core";
import { SCORE_ROOT, type TrialGateRecord } from "@anybench/bench";
import { createComputerRegistry } from "@anybench/envs";
import { loadKit } from "@anybench/kit";
import { FakeProxySpend } from "@anybench/naive";
import { FakeProvider, type FakeExecContext } from "@anybench/providers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { contenders, kits, reports, runs, trials, users } from "../src/db/schema/index.js";
import { recordFailedSubjectMetrics } from "../src/jobs/trial-execute.js";
import { gateTrial, type GateTrialDeps, type KitFilesPort } from "../src/jobs/trial-gate.js";
import { appendEvents } from "../src/lib/events.js";
import { drizzleComputerStore } from "../src/lib/computer-store.js";
import { stageTrialOf } from "../src/orchestrator/advance.js";
import {
  CURATED_TANDEM_KIT,
  defaultKitsDir,
  headToHeadProfile,
} from "../src/orchestrator/curated.js";
import { backfillRunMetrics, legacyGateMetrics } from "../src/orchestrator/metrics-backfill.js";
import { storedScoreOf, type StoredScore } from "../src/orchestrator/proof-score.js";
import { kitContenderSlugs } from "../src/orchestrator/store.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const available = await pgAvailableTdm11();
const enc = new TextEncoder();
const SHA = "d".repeat(64);
const COMPUTE = 27_600n;
const WORKLOADS = ["todo-api", "auth-refactor", "bug-hunt"] as const;
const SLUGS = ["claude-code-solo", "tandem"] as const;
const KIT_FILES_MF: KitFilesPort = {
  scoringFiles: async () => [
    { path: "gates/hidden-tests/check.sh", data: enc.encode("#!/bin/sh\n") },
    { path: "gates/api-load/check.sh", data: enc.encode("#!/bin/sh\n") },
  ],
};

let kitMf: KitSpec;
let seqMf = 0;

/** Scoring computer: hidden-tests passes; api-load passes with a p95 on todo-api, else n/a. */
function scoringMf(p95: number) {
  const fake = new FakeProvider({ name: `fake-mf-${++seqMf}` });
  fake.onExec(/\.anybench\/score\/(fetch|setup)\.sh'$/, (ctx: FakeExecContext) =>
    ctx.command.includes("setup.sh") ? `AB_SETUP frozen=ok sha256=${SHA}\n` : "",
  );
  fake.onExec(/^printf '%s %s/, () => `9 ${SHA}\n`);
  fake.onExec(/bin\/gate-([a-z0-9._-]+)\.sh'/, (ctx: FakeExecContext) => {
    const id = ctx.match![1]!;
    const script = ctx.readFile(`${ctx.home}/.anybench/score/gate-${id}.sh`) ?? "";
    const wl = /WL='([^']+)'/.exec(script)?.[1] ?? "";
    let verdict: object;
    if (id === "hidden-tests") {
      verdict = { pass: true, reason: "16/16 hidden tests passed", evidence: [] };
      ctx.writeFile(
        `${SCORE_ROOT}/status/${id}.metrics`,
        JSON.stringify({ metric: "hidden_tests_passed", value: 16 }) + "\n",
      );
    } else if (wl === "todo-api") {
      verdict = { pass: true, reason: `p95 ${p95.toFixed(1)} ms at 50 req/s`, evidence: [] };
      ctx.writeFile(
        `${SCORE_ROOT}/status/${id}.metrics`,
        JSON.stringify({ metric: "api_p95_ms", value: p95, unit: "ms" }) + "\n",
      );
    } else {
      verdict = { pass: false, applicable: false, reason: "not applicable", evidence: [] };
    }
    ctx.writeFile(`${SCORE_ROOT}/status/${id}.verdict`, JSON.stringify(verdict));
    ctx.writeFile(
      `${SCORE_ROOT}/status/${id}.json`,
      JSON.stringify({ rc: 0, duration_ms: 2, verdict: "present" }),
    );
    return "";
  });
  fake.onExec(/cat '([^']+)'/, (ctx: FakeExecContext) => {
    const text = ctx.readFile(ctx.match![1]!);
    return text === undefined ? { exitCode: 1 } : { stdout: text };
  });
  return fake;
}

interface SeedMf {
  ownerId: string;
  runId: string;
  kitId: string;
  contenderIds: Record<(typeof SLUGS)[number], string>;
}

async function seedMf(db: Database): Promise<SeedMf> {
  const n = ++seqMf;
  const [u] = await db
    .insert(users)
    .values({ githubLogin: `mf${n}`, githubId: 7700 + n })
    .returning();
  const [run] = await db
    .insert(runs)
    .values({
      ownerId: u!.id,
      question: "Is Tandem faster or cheaper than plain Claude Code?",
      budgetMicroUsd: 100_000_000n,
      state: "running",
      intake: { source: { kind: "github", github: "jaximus808/tandem", ref: "main" } },
    })
    .returning();
  const [kit] = await db
    .insert(kits)
    .values({ ownerId: u!.id, runId: run!.id, version: 1, spec: kitMf, hash: `mf${n}` })
    .returning();
  await db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run!.id));
  const ids = {} as SeedMf["contenderIds"];
  for (const slug of SLUGS) {
    const [c] = await db
      .insert(contenders)
      .values({
        runId: run!.id,
        kitId: kit!.id,
        source: slug,
        role: slug === "tandem" ? "subject" : "baseline",
        foundBy: "kit",
      })
      .returning();
    ids[slug] = c!.id;
  }
  return { ownerId: u!.id, runId: run!.id, kitId: kit!.id, contenderIds: ids };
}

let keySeq = 0;
function keyIdMf(): string {
  return `key_mf${String(++keySeq).padStart(22, "0")}`;
}

/** A trial that ran: worker phase edges running → collecting `wallS` apart, a proxy key. */
async function ranTrialMf(
  db: Database,
  s: SeedMf,
  slug: (typeof SLUGS)[number],
  workload: string,
  repeat: number,
  wallS: number,
  extra: Partial<typeof trials.$inferInsert> = {},
) {
  const created = new Date(Date.UTC(2026, 10, 8, 7, 12, repeat));
  const [t] = await db
    .insert(trials)
    .values({
      ownerId: s.ownerId,
      runId: s.runId,
      contenderId: s.contenderIds[slug],
      workloadId: workload,
      repeat,
      state: "collecting",
      costMicroUsd: COMPUTE,
      proxyKeyId: keyIdMf(),
      proxyKeyCreatedAt: created,
      proxyKeyAttempt: 1,
      ...extra,
    })
    .returning();
  const running = new Date(created.getTime() + 20_000);
  const collecting = new Date(running.getTime() + wallS * 1000);
  const edge = (from: string, to: string, at: Date, kind = "worker") =>
    AnybenchEventSchema.parse({
      type: "trial.phase",
      source: "trial",
      source_id: t!.id,
      severity: "info",
      actor: { kind, id: kind === "worker" ? "worker-mf" : t!.id },
      cost_delta_micro_usd: 0n,
      at: at.toISOString(),
      payload: { from, to, attempt: 1 },
      run_id: s.runId,
      seq: 0,
    });
  await appendEvents(db, RunIdSchema.parse(s.runId), [
    edge("warming", "running", running),
    // A runner-reported edge (subject-writable clock) is never used for wall time.
    edge("running", "collecting", new Date(running.getTime() + 1000), "runner"),
    edge("running", "collecting", collecting),
  ]);
  return t!;
}

describe.skipIf(!available)("trial metrics end to end (metrics-fix, local Postgres)", () => {
  let h: FreshDbTdm11;

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 2 });
    const full = (await loadKit(path.join(defaultKitsDir(), CURATED_TANDEM_KIT))).spec;
    const r = headToHeadProfile(full);
    if (!r.ok) throw new Error(r.reason);
    kitMf = r.spec;
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  function depsMf(p95: number, over: Partial<GateTrialDeps> = {}): GateTrialDeps {
    return {
      db: h.db,
      registry: createComputerRegistry({
        provider: scoringMf(p95),
        store: drizzleComputerStore(h.db),
        pricing: { pricePerBlockMicroUsd: 1000n },
      }),
      frozen: {
        frozen: async () => ({
          kind: "url",
          url: "https://r2.example.com/o",
          sha256: SHA,
          sizeBytes: 9,
        }),
      },
      kitFiles: KIT_FILES_MF,
      gateOptions: { pollIntervalMs: 5, graceMs: 0, sleep: async () => undefined },
      workerId: "worker-mf",
      ...over,
    };
  }

  async function scoreOf(runId: string): Promise<StoredScore> {
    const slugs = await kitContenderSlugs(h.db, runId);
    const rows = await h.db.select().from(trials).where(eq(trials.runId, runId));
    return storedScoreOf(
      kitMf,
      rows.map((t) => stageTrialOf(t, slugs)),
    );
  }

  function req(score: StoredScore, contender: string, id: string) {
    const c = score.kit_score.contenders.find((x) => x.contenderId === contender)!;
    return c.requirements.find((r) => r.requirementId === id)!;
  }

  it("trial.gate records wall, api p95 and compute + proxy cost; scoreKit scores them", async () => {
    const s = await seedMf(h.db);
    const ledger = new FakeProxySpend();
    const walls: Record<string, number> = { "claude-code-solo": 90, tandem: 300 };
    const spendOf: Record<string, bigint> = { "claude-code-solo": 410_000n, tandem: 1_250_000n };
    for (const slug of SLUGS) {
      for (const w of WORKLOADS) {
        for (const repeat of [0, 1]) {
          const t = await ranTrialMf(h.db, s, slug, w, repeat, walls[slug]! + repeat);
          // Two priced calls by this key, one unpriced, plus another key's call and one from
          // before the key existed: neither counts.
          const at = (sec: number) => new Date(t.proxyKeyCreatedAt!.getTime() + sec * 1000);
          ledger
            .add({
              actorKeyId: t.proxyKeyId,
              billedMicroUsd: spendOf[slug]! - 10_000n,
              createdAt: at(30).toISOString(),
            })
            .add({
              actorKeyId: t.proxyKeyId,
              billedMicroUsd: 10_000n,
              createdAt: at(40).toISOString(),
            })
            .add({
              actorKeyId: t.proxyKeyId,
              billedMicroUsd: null,
              createdAt: at(41).toISOString(),
            })
            .add({
              actorKeyId: "key_someoneelse0000000000000",
              billedMicroUsd: 999n,
              createdAt: at(35).toISOString(),
            })
            .add({
              actorKeyId: t.proxyKeyId,
              billedMicroUsd: 777n,
              createdAt: at(-60).toISOString(),
            });
          const p95 = slug === "tandem" ? 3.6 : 2.5;
          const r = await gateTrial(depsMf(p95, { proxySpend: ledger }), {
            trial_id: t.id,
            attempt: 1,
          });
          expect(r).toMatchObject({ outcome: "scored", to: "done" });
        }
      }
    }

    const rows = await h.db.select().from(trials).where(eq(trials.runId, s.runId));
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      const slug = row.contenderId === s.contenderIds.tandem ? "tandem" : "claude-code-solo";
      const m = row.metrics as Record<string, number>;
      expect(m.wall_s).toBe(walls[slug]! + row.repeat);
      expect(m.wall_ms).toBe((walls[slug]! + row.repeat) * 1000);
      expect(m.compute_cost_micro_usd).toBe(Number(COMPUTE));
      expect(m.proxy_cost_micro_usd).toBe(Number(spendOf[slug]!));
      expect(m.proxy_calls).toBe(3);
      expect(m.proxy_unpriced_calls).toBe(1);
      expect(m.proxy_cost_missing).toBeUndefined();
      expect(m.hidden_tests_passed).toBe(16);
      expect(row.costMicroUsd).toBe(COMPUTE + spendOf[slug]!);
      if (row.workloadId === "todo-api") expect(m.api_p95_ms).toBe(slug === "tandem" ? 3.6 : 2.5);
      else expect(m.api_p95_ms).toBeUndefined();
      const gate = row.gate as TrialGateRecord;
      if (row.workloadId === "todo-api") expect(gate.gates["api-load"]!.metrics).toBeDefined();
    }

    const score = await scoreOf(s.runId);
    for (const slug of SLUGS) {
      for (const id of ["tests-pass", "wall", "cost", "api-p95"]) {
        expect(req(score, slug, id), `${slug} ${id}`).toMatchObject({ scored: true });
      }
      expect(req(score, slug, "quality")).toMatchObject({ scored: false, code: "not_reviewed" });
    }
    const wall = req(score, "tandem", "wall");
    expect(wall.scored && wall.byWorkload.find((c) => c.workloadId === "bug-hunt")?.value).toBe(
      300.5,
    );
    const p95 = req(score, "tandem", "api-p95");
    expect(p95.scored && p95.byWorkload.map((c) => c.value)).toEqual([3.6]);
  });

  it("proxy spend that can't be read leaves cost unscored, never compute alone", async () => {
    const s = await seedMf(h.db);
    for (const slug of SLUGS) {
      for (const w of WORKLOADS) {
        const t = await ranTrialMf(h.db, s, slug, w, 0, 60);
        await gateTrial(depsMf(2, { proxySpend: null }), { trial_id: t.id, attempt: 1 });
      }
    }
    const rows = await h.db.select().from(trials).where(eq(trials.runId, s.runId));
    for (const row of rows) {
      expect((row.metrics as Record<string, number>).proxy_cost_missing).toBe(1);
      expect(row.costMicroUsd).toBe(COMPUTE);
    }
    const score = await scoreOf(s.runId);
    expect(req(score, "tandem", "cost")).toMatchObject({ scored: false, code: "metric_missing" });
    expect(req(score, "tandem", "wall")).toMatchObject({ scored: true });
  });

  it("a failed_subject trial gets its cost (compute + proxy) from trial.execute", async () => {
    const s = await seedMf(h.db);
    const t = await ranTrialMf(h.db, s, "tandem", "bug-hunt", 0, 3600, {
      state: "failed_subject",
    });
    const ledger = new FakeProxySpend().add({
      actorKeyId: t.proxyKeyId,
      billedMicroUsd: 5_000_000n,
      createdAt: new Date(t.proxyKeyCreatedAt!.getTime() + 5000).toISOString(),
    });
    await recordFailedSubjectMetrics(h.db, t.id, ledger);
    const [row] = await h.db.select().from(trials).where(eq(trials.id, t.id));
    expect(row!.costMicroUsd).toBe(COMPUTE + 5_000_000n);
    expect((row!.metrics as Record<string, number>).wall_s).toBe(3600);
  });

  it("the backfill recovers tonight's shape of trial, idempotently, and re-scores + rebuilds the report", async () => {
    const s = await seedMf(h.db);
    const ledger = new FakeProxySpend();
    // Gate the trials, then strip them back to what the old code stored: no metrics, no gate
    // metric rows, cost = compute alone.
    for (const slug of SLUGS) {
      for (const w of WORKLOADS) {
        const t = await ranTrialMf(h.db, s, slug, w, 0, slug === "tandem" ? 250 : 80);
        ledger.add({
          actorKeyId: t.proxyKeyId,
          billedMicroUsd: 2_000_000n,
          createdAt: new Date(t.proxyKeyCreatedAt!.getTime() + 9000).toISOString(),
        });
        await gateTrial(depsMf(3.6), { trial_id: t.id, attempt: 1 });
      }
    }
    for (const row of await h.db.select().from(trials).where(eq(trials.runId, s.runId))) {
      const gate = row.gate as TrialGateRecord;
      for (const o of Object.values(gate.gates)) delete o.metrics;
      await h.db
        .update(trials)
        .set({ metrics: null, gate, costMicroUsd: COMPUTE })
        .where(eq(trials.id, row.id));
    }
    await h.db
      .insert(reports)
      .values({ ownerId: s.ownerId, runId: s.runId, json: { stale: true }, md: "stale" });
    const before = await scoreOf(s.runId);
    expect(req(before, "tandem", "wall")).toMatchObject({ scored: false, code: "metric_missing" });
    expect(req(before, "tandem", "api-p95")).toMatchObject({ code: "metric_missing" });

    // Dry run: computes, writes nothing.
    const dry = await backfillRunMetrics(h.db, {
      runId: s.runId,
      apply: false,
      proxySpend: ledger,
    });
    expect(dry.trials).toHaveLength(6);
    expect(dry.trials.every((l) => !l.written && l.missing.length === 0)).toBe(true);
    expect(dry.unscored.wall).toBeUndefined();
    expect(dry.unscored["api-p95"]).toBeUndefined();
    const [untouched] = await h.db.select().from(trials).where(eq(trials.runId, s.runId));
    expect(untouched!.metrics).toBeNull();

    const applied = await backfillRunMetrics(h.db, {
      runId: s.runId,
      apply: true,
      proxySpend: ledger,
    });
    expect(applied.trials.every((l) => l.written)).toBe(true);
    expect(applied.scoreWritten).toBe(true);
    expect(applied.report).toBe("rebuilt");
    const todo = applied.trials.find(
      (l) => l.contender === "tandem" && l.workloadId === "todo-api",
    )!;
    expect(todo).toMatchObject({ wall_s: 250, api_p95_ms: 3.6, cost_micro_usd: "2027600" });

    const rows = await h.db.select().from(trials).where(eq(trials.runId, s.runId));
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    const snapshot = [...rows].sort(byId).map((r) => [r.id, r.metrics, r.costMicroUsd]);
    for (const r of rows) expect(r.costMicroUsd).toBe(COMPUTE + 2_000_000n);
    const [run] = await h.db.select().from(runs).where(eq(runs.id, s.runId));
    const stored = (run!.stageOutputs as { score: StoredScore }).score;
    for (const slug of SLUGS) {
      for (const id of ["wall", "cost", "api-p95"]) {
        expect(req(stored, slug, id), `${slug} ${id}`).toMatchObject({ scored: true });
      }
    }
    const [rep] = await h.db.select().from(reports).where(eq(reports.runId, s.runId));
    expect(rep!.md).not.toBe("stale");
    expect((rep!.json as { run_id: string }).run_id).toBe(s.runId);

    // Idempotent: the compute share is read back from metrics, never added twice.
    await backfillRunMetrics(h.db, { runId: s.runId, apply: true, proxySpend: ledger });
    const again = await h.db.select().from(trials).where(eq(trials.runId, s.runId));
    expect(again.sort(byId).map((r) => [r.id, r.metrics, r.costMicroUsd])).toEqual(snapshot);
  });

  it("legacyGateMetrics reads p95 only from a passing api-load verdict", () => {
    const rec = (pass: boolean, reason: string) => ({
      version: 1,
      trial_id: newId(TrialIdSchema),
      workload_id: "todo-api",
      scored_at: new Date().toISOString(),
      scoring_computer: null,
      sandbox: "uid-split",
      outputs_sha256: null,
      gates: {
        "api-load": {
          result: { pass, applicable: true, reason, evidence: [] },
          status: "verdict",
          exit_code: 0,
          timed_out: false,
          duration_ms: 1,
          log_tail: "",
          kit_suspect: false,
        },
      },
    });
    expect(
      legacyGateMetrics(rec(true, "p95 3.6 ms at 50 req/s over 1000 requests, 0 errors")),
    ).toEqual({
      api_p95_ms: 3.6,
    });
    expect(legacyGateMetrics(rec(false, "p95 3.6 ms at 50 req/s"))).toEqual({});
    expect(legacyGateMetrics(null)).toEqual({});
  });
});
