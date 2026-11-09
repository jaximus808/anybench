// TDM-218 [19.2]: a run from an uploaded kit skips kit generation but never skips proof.
//
//   - the state path: intake → understand → research → kit_draft pass straight through (no Naïve
//     agent session, no ingest), then env_build → proof (the six checks on our computers) →
//     awaiting_go; Go is refused until the proof passed, then running → … → delivered;
//   - a failed proof holds the run for the user (no kit designer repair, no agent spend);
//   - a curated kit's signed-off offline proof (stage_outputs.proof_basis) never applies to an
//     uploaded kit: not in the orchestrator, not at Go, not in proofStage;
//   - the estimate and the run fee carry no kit-generation cost (billingEstimate, ledgerCharges).
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  KitIdSchema,
  newId,
  PROOF_CHECKS,
  RunIdSchema,
  toJsonValue,
  withMarkupBps,
} from "@anybench/core";
import { loadKit, ProofInfraError } from "@anybench/kit";
import { FakeNaive } from "@anybench/naive/fake";
import { FakeProvider } from "@anybench/providers";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import {
  agentSessions,
  computers,
  events,
  kits,
  runs,
  usageEntries,
} from "../src/db/schema/index.js";
import { proofStage } from "../src/jobs/proof.js";
import type { RunChargesHook } from "../src/orchestrator/advance.js";
import { CURATED_TANDEM_KIT, defaultKitsDir } from "../src/orchestrator/curated.js";
import {
  billingEstimate,
  ledgerCharges,
  naiveSessionCanceller,
} from "../src/orchestrator/defaults.js";
import {
  FakeAgentStages,
  FakePipeline,
  failingProof,
  passingProof,
} from "../src/orchestrator/fake.js";
import { isUploadedKitRun, stageOk, type StageContext } from "../src/orchestrator/ports.js";
import { proofAccepted, TANDEM_PROOF_SIGNOFF } from "../src/orchestrator/proof-score.js";
import { kitSpecHash } from "../src/routes/kits.js";
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
import { configTdm14 } from "./helpers/server-tdm14.js";

const available = await pgAvailableTdm11();
const BASE = "http://api.test";

/** The curated checks as stored: oracle and do-less pass offline, the other four "not run". */
function curatedChecks() {
  return PROOF_CHECKS.map((check) => ({
    check,
    pass: check === "oracle_passes" || check === "do_less_fails",
    reason: "seeded curated",
    evidence: [],
  }));
}

function curatedBasis(kitId: string) {
  return {
    basis: "curated" as const,
    label: "proof: curated (verified offline at bebb77e)",
    source: TANDEM_PROOF_SIGNOFF.source,
    commit: TANDEM_PROOF_SIGNOFF.commit,
    sha256: TANDEM_PROOF_SIGNOFF.sha256,
    verified: ["oracle_passes" as const, "do_less_fails" as const],
    kit_id: kitId,
  };
}

/**
 * A run started from an uploaded kit, as POST /runs creates it for source {kind: 'kit'} when the
 * source kit row's origin is `uploaded`: intake.kit_origin = uploaded, the kit copied as version 1
 * with no proof, the run in intake.
 */
async function seedUploadedRunTdm218(
  db: Database,
  ownerId: string,
  opts: { origin?: "uploaded" | "generated"; autoGo?: boolean } = {},
): Promise<{ runId: string; kitId: string }> {
  const runId = newId(RunIdSchema);
  const kitId = newId(KitIdSchema);
  const spec = kitTdm54();
  await db.insert(runs).values({
    id: runId,
    ownerId,
    projectId: null,
    question: "Is my CLI faster than the old release?",
    state: "intake",
    budgetMicroUsd: 50_000_000n,
    intake: toJsonValue({
      source: { kind: "kit", kit_id: newId(KitIdSchema) },
      contenders: [],
      auto_go: opts.autoGo ?? false,
      kit_origin: opts.origin ?? "uploaded",
    }),
  });
  await db.insert(kits).values({
    id: kitId,
    ownerId,
    runId,
    version: 1,
    spec: toJsonValue(spec),
    filesUrl: null,
    proof: null,
    hash: kitSpecHash(spec),
  });
  await db.update(runs).set({ kitId }).where(eq(runs.id, runId));
  return { runId, kitId };
}

describe.skipIf(!available)("runs from an uploaded kit (TDM-218)", () => {
  let h: FreshDbTdm11;
  let api: RunsAppTdm67;
  let userId: string;
  let seq = 0;
  const naive = new FakeNaive();
  for (const role of ["understander", "researcher", "kit_designer", "analyst"]) {
    naive.scriptDefault(role, { output: { ok: true } });
  }

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 8 });
    api = runsAppTdm67(h.url, { billingGate: async () => ({ allowed: true }) });
    userId = await seedUserTdm67(h.db, "uploaded-kit");
  }, 60_000);

  afterAll(async () => {
    await api?.dbh.close();
    await h?.drop();
  });

  function rig(pipeline: FakePipeline) {
    const queue = new MemQueueTdm54();
    const fake = new FakeProvider({ name: `fake-tdm218-${seq}` });
    fakeRunnerTdm49(fake, { stepMs: 5 });
    const stages = new FakeAgentStages({ kit: kitTdm54(), naive: { client: naive, db: h.db } });
    const charges: Parameters<RunChargesHook["recordRunCharges"]>[0][] = [];
    const real = ledgerCharges(h.db, configTdm14(h.url));
    const w = workerTdm54(h.db, h.url, `tdm218-worker-${seq++}`, queue, fake, {
      agents: () => stages,
      pipeline: () => pipeline,
      sessions: (ctx) => naiveSessionCanceller(ctx.db, naive),
      billingGate: () => async () => ({ allowed: true }),
      charges: () => ({
        async recordRunCharges(input) {
          charges.push(input);
          return real.recordRunCharges(input);
        },
      }),
    });
    return { queue, w, stages, charges };
  }

  async function start(queue: MemQueueTdm54, runId: string) {
    await queue.add(
      "run.advance",
      { run_id: runId, reason: "created" },
      {
        jobKey: `runs:${runId}:created`,
      },
    );
  }

  async function runRow(id: string) {
    const [r] = await h.db.select().from(runs).where(eq(runs.id, id));
    return r!;
  }

  async function edges(id: string) {
    const rows = await h.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.runId, id), eq(events.type, "run.state_changed")))
      .orderBy(asc(events.seq));
    return rows.map((r) => {
      const p = r.payload as { from: string | null; to: string; reason?: string };
      return [p.from, p.to, p.reason ?? null];
    });
  }

  async function sessionsOf(id: string) {
    return h.db
      .select({ role: agentSessions.role })
      .from(agentSessions)
      .where(eq(agentSessions.runId, id));
  }

  async function go(id: string) {
    const before = api.jobs.jobs.length;
    const res = await api.app.request(`${BASE}/runs/${id}/go`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
      body: "{}",
    });
    return { status: res.status, body: await res.json(), jobs: api.jobs.jobs.slice(before) };
  }

  /** A kit row as POST /kits/uploads/:id/complete stores it (TDM-217): origin uploaded, no run. */
  async function uploadedKitRow(): Promise<string> {
    const id = newId(KitIdSchema);
    const spec = kitTdm54();
    await h.db.insert(kits).values({
      id,
      ownerId: userId,
      runId: null,
      version: 1,
      spec: toJsonValue(spec),
      filesUrl: `artifact:kits/files/${userId}/${id}.tar.gz`,
      proof: null,
      hash: "b".repeat(64),
      origin: "uploaded",
    });
    return id;
  }

  async function createFromKit(kitId: string, extra: Record<string, unknown> = {}) {
    const before = api.jobs.jobs.length;
    const res = await api.app.request(`${BASE}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
      body: JSON.stringify({
        question: "Is my CLI faster than the old release?",
        source: { kind: "kit", kit_id: kitId },
        budget_micro_usd: "50000000",
        auto_go: false,
        ...extra,
      }),
    });
    return {
      status: res.status,
      run: ((await res.json()) as { run?: { id: string; kit_id: string; kit_origin: string } }).run,
      jobs: api.jobs.jobs.slice(before),
    };
  }

  it("POST /runs from an uploaded kit (no run): 201, origin from the kit row, the kit copied unproven", async () => {
    const source = await uploadedKitRow();
    // A request cannot claim the origin: kit_origin in the body is not part of the contract.
    const created = await createFromKit(source, { kit_origin: "generated" });
    expect(created.status, JSON.stringify(created.run)).toBe(201);
    const run = created.run!;
    expect(run.kit_origin).toBe("uploaded");
    expect(run.kit_id).not.toBe(source);
    const row = await runRow(run.id);
    expect(row.projectId).toBeNull();
    expect((row.intake as { kit_origin?: string }).kit_origin).toBe("uploaded");
    const [copy] = await h.db.select().from(kits).where(eq(kits.id, run.kit_id));
    expect(copy).toMatchObject({
      runId: run.id,
      version: 1,
      origin: "uploaded",
      proof: null,
      filesUrl: `artifact:kits/files/${userId}/${source}.tar.gz`,
    });
    expect(created.jobs.map((j) => j.task)).toEqual(["run.advance"]);

    // A kit generated by a run reruns as generated.
    const generatedCopy = await createFromKit(run.kit_id);
    expect(generatedCopy.status).toBe(201);
    expect(generatedCopy.run!.kit_origin).toBe("uploaded"); // the copy keeps its origin
    const seeded = await seedUploadedRunTdm218(h.db, userId, { origin: "generated" });
    await h.db.update(kits).set({ origin: "generated" }).where(eq(kits.id, seeded.kitId));
    const rerun = await createFromKit(seeded.kitId);
    expect(rerun.status).toBe(201);
    expect(rerun.run!.kit_origin).toBe("generated");

    // Someone else's uploaded kit: 404 (RLS).
    const other = await seedUserTdm67(h.db, "other-uploader");
    const theirs = newId(KitIdSchema);
    await h.db.insert(kits).values({
      id: theirs,
      ownerId: other,
      runId: null,
      version: 1,
      spec: toJsonValue(kitTdm54()),
      filesUrl: null,
      proof: null,
      hash: "c".repeat(64),
      origin: "uploaded",
    });
    expect((await createFromKit(theirs)).status).toBe(404);
  }, 60_000);

  it("skips understand, research and kit design (no agent sessions), proves, and Go waits for a passing proof", async () => {
    const pipeline = new FakePipeline({ digest: digestTdm54(), proof: () => passingProof() });
    const r = rig(pipeline);
    const created = await createFromKit(await uploadedKitRow());
    expect(created.status).toBe(201);
    const runId = created.run!.id;
    const kitId = created.run!.kit_id;

    // Before the proof: the kit is unproven, so Go is refused.
    expect((await go(runId)).status).toBe(409);

    for (const j of created.jobs) await r.queue.add(j.task, j.payload, { jobKey: j.jobKey });
    await drainTdm54(r.w, r.queue);
    const waiting = await runRow(runId);
    expect(waiting.state).toBe("awaiting_go");

    // The state path: the three kit-generation stages pass straight through, then the proof.
    const skip = "uploaded kit: no kit generation";
    expect(await edges(runId)).toEqual([
      [null, "intake", "created"],
      ["intake", "understand", skip],
      ["understand", "research", skip],
      ["research", "kit_draft", skip],
      ["kit_draft", "env_build", null],
      ["env_build", "proof", null],
      ["proof", "awaiting_go", null],
    ]);
    // No agent ran and nothing was ingested; the env was built and the six checks ran on it.
    expect(r.stages.calls).toEqual([]);
    expect(await sessionsOf(runId)).toEqual([]);
    expect(
      naive.sessionCreates.filter(
        (s) => (s.body.metadata as { run_id?: string } | undefined)?.run_id === runId,
      ),
    ).toEqual([]);
    expect(pipeline.calls.map((c) => c.step)).toEqual(["buildEnv", "prove", "estimate"]);
    const [kit] = await h.db.select().from(kits).where(eq(kits.id, kitId));
    expect(kit!.proof).toEqual(passingProof());
    expect(isUploadedKitRun(waiting.intake)).toBe(true);
    // A proof computer of this run, as proof-runner.ts writes it for an uploaded kit
    // (billToRun: the run id, no trial), destroyed after one 2 vCPU / 4 GiB block.
    const proofComputer = newId(KitIdSchema);
    await h.db.insert(computers).values({
      id: proofComputer,
      provider: "fake",
      providerId: `proof-${proofComputer}`,
      runId,
      trialId: null,
      status: "destroyed",
      destroyedAt: new Date(),
      blocksBilled: 1,
      costMicroUsd: 27_600n,
    });

    // The run says where its kit came from (the run page shows "kit: uploaded by you").
    const detail = await api.app.request(`${BASE}/runs/${runId}`, {
      headers: { authorization: `Bearer ${userId}` },
    });
    expect(((await detail.json()) as { run: { kit_origin: string } }).run.kit_origin).toBe(
      "uploaded",
    );

    // Go now passes and the run delivers; the only agent is the analyst after the trials.
    const g = await go(runId);
    expect(g.status).toBe(200);
    for (const j of g.jobs) await r.queue.add(j.task, j.payload, { jobKey: j.jobKey });
    await drainTdm54(r.w, r.queue);
    expect((await runRow(runId)).state).toBe("delivered");
    expect((await sessionsOf(runId)).map((s) => s.role)).toEqual(["analyst"]);
    // Billing: the hook is told the kit was uploaded, and no run fee entry is written.
    expect(r.charges).toEqual([
      { runId, userId, state: "delivered", cancelCause: null, kitOrigin: "uploaded" },
    ]);
    const fees = await h.db
      .select()
      .from(usageEntries)
      .where(and(eq(usageEntries.runId, runId), eq(usageEntries.type, "run_fee")));
    expect(fees).toEqual([]);
    // The proof computer is billed like trial compute: cost + COMPUTE_MARKUP_BPS, no trial.
    const [proofCharge] = await h.db
      .select()
      .from(usageEntries)
      .where(eq(usageEntries.idempotencyKey, `computer:${proofComputer}:compute`));
    expect(proofCharge).toMatchObject({
      type: "compute",
      runId,
      trialId: null,
      amountMicroUsd: withMarkupBps(27_600n, 5000),
    });
  }, 60_000);

  it("a failed proof holds the run for the user: no kit designer repair, Go refused", async () => {
    const pipeline = new FakePipeline({ digest: digestTdm54(), proof: () => failingProof() });
    const r = rig(pipeline);
    const { runId } = await seedUploadedRunTdm218(h.db, userId, { autoGo: true });
    await start(r.queue, runId);
    await drainTdm54(r.w, r.queue);
    const run = await runRow(runId);
    expect(run.state).toBe("needs_human");
    expect(run.pausedReason).toBe(
      "the uploaded kit failed its proof: do_less_fails (the partial oracle passed)",
    );
    expect(r.stages.calls).toEqual([]);
    expect(await sessionsOf(runId)).toEqual([]);
    expect(pipeline.calls.filter((c) => c.step === "prove")).toHaveLength(1);
    expect((await edges(runId)).map((e) => e[1])).not.toContain("running");
    expect((await go(runId)).status).toBe(409);
  }, 60_000);

  it("a curated sign-off never applies to an uploaded kit: not from the proof stage, not at Go", async () => {
    // 1. The proof port answers with a curated proof (an uploaded copy of the curated kit): held,
    //    and nothing is stored on the kit row or in stage_outputs.
    const pipeline = new FakePipeline({ digest: digestTdm54() });
    pipeline.prove = async () =>
      stageOk({ ...curatedBasis("ignored"), checks: curatedChecks() }) as never;
    const r = rig(pipeline);
    const a = await seedUploadedRunTdm218(h.db, userId, { autoGo: true });
    await start(r.queue, a.runId);
    await drainTdm54(r.w, r.queue);
    const held = await runRow(a.runId);
    expect(held.state).toBe("needs_human");
    expect(held.pausedReason).toMatch(/never accepted on a curated sign-off/);
    expect((held.stageOutputs as { proof_basis?: unknown }).proof_basis).toBeUndefined();
    const [k] = await h.db.select().from(kits).where(eq(kits.id, a.kitId));
    expect(k!.proof).toBeNull();

    // 2. Go in awaiting_go on an uploaded kit that is unproven, or failed a check: refused.
    for (const proof of [null, failingProof()]) {
      const s = await seedUploadedRunTdm218(h.db, userId);
      await h.db.update(kits).set({ proof }).where(eq(kits.id, s.kitId));
      await h.db
        .update(runs)
        .set({ state: "awaiting_go", estimateMicroUsd: 1_000_000n })
        .where(eq(runs.id, s.runId));
      expect((await go(s.runId)).status).toBe(409);
    }

    // 3. A run in awaiting_go with curated checks and a basis for its exact kit row: Go refuses
    //    an uploaded run, and accepts the same state for a generated (curated) run.
    for (const origin of ["uploaded", "generated"] as const) {
      const s = await seedUploadedRunTdm218(h.db, userId, { origin });
      await h.db.update(kits).set({ proof: curatedChecks() }).where(eq(kits.id, s.kitId));
      await h.db
        .update(runs)
        .set({
          state: "awaiting_go",
          estimateMicroUsd: 1_000_000n,
          stageOutputs: { proof_basis: curatedBasis(s.kitId) },
        })
        .where(eq(runs.id, s.runId));
      const res = await go(s.runId);
      expect(res.status, `${origin}: ${JSON.stringify(res.body)}`).toBe(
        origin === "uploaded" ? 409 : 200,
      );
      if (origin === "uploaded") {
        expect(JSON.stringify(res.body)).toMatch(/has not passed all six proof checks/);
      }
    }

    // 4. proofAccepted itself.
    const kit = { id: "k1", proof: curatedChecks() };
    const outputs = { proof_basis: curatedBasis("k1") };
    expect(proofAccepted(kit, outputs, { kit_origin: "generated" })).toBe(true);
    expect(proofAccepted(kit, outputs, { kit_origin: "uploaded" })).toBe(false);
    expect(proofAccepted({ id: "k1", proof: passingProof() }, {}, { kit_origin: "uploaded" })).toBe(
      true,
    );
  }, 60_000);

  it("proofStage never gives an uploaded copy of the curated kit its curated proof", async () => {
    const dir = path.join(defaultKitsDir(), CURATED_TANDEM_KIT);
    const kit = await loadKit(dir);
    const ctx = (kitOrigin: "uploaded" | "generated"): StageContext => ({
      run: {
        id: newId(RunIdSchema),
        intake: { source: { kind: "kit", kit_id: newId(KitIdSchema) }, kit_origin: kitOrigin },
      } as unknown as StageContext["run"],
      idempotencyKey: "tdm218:proof:1",
      signal: new AbortController().signal,
      emit: async () => undefined,
    });
    const runnerCalls: string[] = [];
    const prove = (filesUrl: string | null) =>
      proofStage({
        db: {} as Database,
        provider: null,
        kitFilesUrl: async () => filesUrl,
        runner: () => ({
          async runTrial(req) {
            runnerCalls.push(req.label);
            throw new ProofInfraError("fake: no computer");
          },
          async runGates() {
            return { gates: {} };
          },
        }),
      });
    const env = { env_id: "snap", detail: {} };
    const curatedUrl = pathToFileURL(dir).href;

    // The control: a generated run keeps the curated proof, and no proof trial runs.
    const control = await prove(curatedUrl)(ctx("generated"), {
      kit_id: "k1",
      kit: kit.spec,
      env,
    });
    expect(control.ok && !Array.isArray(control.value)).toBe(true);
    expect(runnerCalls).toEqual([]);

    // Uploaded, files at the curated directory: the six checks run (here: infra, so it holds).
    const up = await prove(curatedUrl)(ctx("uploaded"), { kit_id: "k1", kit: kit.spec, env });
    expect(up.ok && !Array.isArray(up.value)).toBe(false);
    expect(runnerCalls.length).toBeGreaterThan(0);

    // Uploaded with no files: held, never the curated fallback a pre-C1 kit row gets.
    const none = await prove(null)(ctx("uploaded"), { kit_id: "k1", kit: kit.spec, env });
    expect(none).toMatchObject({ ok: false, outcome: "needs_human" });
    expect(!none.ok && none.reason).toMatch(/uploaded kit k1 has no files/);
  }, 60_000);

  it("the estimate carries no kit-generation fee for an uploaded kit", async () => {
    const config = configTdm14(h.url);
    const estimate = billingEstimate(config);
    const ctx = (kit_origin: string) =>
      ({ run: { intake: { kit_origin } } }) as unknown as StageContext;
    const input = { kit_id: "k1", kit: kitTdm54() };
    const gen = await estimate(ctx("generated"), input);
    const up = await estimate(ctx("uploaded"), input);
    if (!gen.ok || !up.ok) throw new Error("estimate held");
    expect(config.RUN_FEE_MICRO_USD).toBe(2_000_000n);
    expect(config.UPLOADED_KIT_RUN_FEE_MICRO_USD).toBe(0n);
    expect(gen.value - up.value).toBe(2_000_000n);
  });
});
