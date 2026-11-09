// TDM-232 [18.11]: a failed_subject trial (stopped at the wall-clock or token cap, or its driver
// exited non-zero after work) whose attempt froze a workspace is graded on it by trial.gate and
// keeps its outcome. Pins: the frozen-workspace fact on the trial decides it (never the state or
// failure class alone); the gate writes the verdict and the hidden-test fraction without a state
// change; the run waits for a pending grade; a grade our scoring can't do is a fail with no
// partial credit, never failed_infra; a run with such a trial scores with no "gate missing" and
// the report and the trial view say what happened. Infra failures are unchanged.
import path from "node:path";
import { frozenWorkspaceOf, type FrozenWorkspace, type KitSpec } from "@anybench/core";
import { GateInfraError, type TrialGateRecord } from "@anybench/bench";
import { createComputerRegistry } from "@anybench/envs";
import { loadKit } from "@anybench/kit";
import { FakeProvider } from "@anybench/providers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import {
  contenders,
  events as eventsTable,
  kits,
  runs,
  trials,
  users,
} from "../src/db/schema/index.js";
import { enqueueFollowUp, TRIAL_EXECUTE_JOB, TRIAL_GATE_JOB } from "../src/jobs/trial-execute.js";
import { gateTrial, GATE_INFRA_MAX_ATTEMPTS, type GateTrialDeps } from "../src/jobs/trial-gate.js";
import { drizzleComputerStore } from "../src/lib/computer-store.js";
import { trialSettled } from "../src/orchestrator/advance.js";
import { defaultKitsDir } from "../src/orchestrator/curated.js";
import type { StageTrial } from "../src/orchestrator/ports.js";
import { buildSummary, storedScoreOf } from "../src/orchestrator/proof-score.js";
import { outcomeNoteOf, toTrialDetail } from "../src/routes/trials.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const available = await pgAvailableTdm11();

const PENDING_TDM232: FrozenWorkspace = {
  present: true,
  manifest: true,
  files: 4,
  workspace_files: 2,
  frozen_at: "2026-11-09T04:00:00.000Z",
  grading: "pending",
};
const NONE_TDM232: FrozenWorkspace = {
  present: false,
  manifest: false,
  files: 0,
  workspace_files: 0,
  frozen_at: null,
  grading: "none",
  reason: "no manifest.json for this attempt",
};

function kitSpecTdm232() {
  return {
    schema_version: 2,
    subject: {
      kind: "software",
      name: "tracker",
      summary: "builds an app",
      better_means: ["correct"],
    },
    contenders: [
      {
        id: "solo",
        role: "subject",
        source: { github: "example/solo", ref: "v1.0.0" },
        driver: { type: "cli", verbs: { run: "adapters/solo/driver.sh run" } },
      },
    ],
    workloads: [{ id: "project-tracker", instruction: "workloads/project-tracker/instruction.md" }],
    gates: [{ id: "hidden-tests", kind: "hidden-tests" }],
    requirements: [
      {
        id: "tests-fraction",
        type: "measured",
        title: "Share of hidden tests passed",
        metric: "hidden_test_fraction",
        better: "higher",
        gate_id: "hidden-tests",
      },
    ],
    proof: { oracle: { id: "ref", dir: "proof/oracle/" } },
    scoring: { weights: { "tests-fraction": 100 } },
    repeats: 1,
  };
}

/** The verdict a scoring computer gives a capped trial: 87 of 120 hidden tests pass. */
function recordTdm232(trialId: string, passed = 87, total = 120): TrialGateRecord {
  return {
    version: 1,
    trial_id: trialId,
    workload_id: "project-tracker",
    scored_at: "2026-11-09T04:10:00.000Z",
    scoring_computer: null,
    sandbox: "uid",
    outputs_sha256: null,
    gates: {
      "hidden-tests": {
        result: {
          pass: passed === total,
          reason: `${passed}/${total} hidden tests pass`,
          evidence: ["hidden-tests.json"],
          applicable: true,
        },
        status: "verdict",
        exit_code: 0,
        timed_out: false,
        duration_ms: 1200,
        log_tail: "",
        kit_suspect: false,
        metrics: {
          hidden_test_fraction: passed / total,
          hidden_tests_passed: passed,
          hidden_tests_total: total,
        },
      },
    },
  };
}

let seq = 0;
async function seedTdm232(db: Database) {
  const n = ++seq;
  const [u] = await db
    .insert(users)
    .values({ githubLogin: `frozen${n}`, githubId: 23_200 + n })
    .returning();
  const [run] = await db
    .insert(runs)
    .values({ ownerId: u!.id, question: "better?", budgetMicroUsd: 1_000_000n, state: "running" })
    .returning();
  const [kit] = await db
    .insert(kits)
    .values({ ownerId: u!.id, runId: run!.id, version: 1, spec: kitSpecTdm232(), hash: `fw${n}` })
    .returning();
  await db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run!.id));
  const [c] = await db
    .insert(contenders)
    .values({ runId: run!.id, kitId: kit!.id, source: "github", role: "subject" })
    .returning();
  return { ownerId: u!.id, runId: run!.id, contenderId: c!.id };
}

async function trialTdm232(
  db: Database,
  s: Awaited<ReturnType<typeof seedTdm232>>,
  extra: Partial<typeof trials.$inferInsert>,
) {
  const [t] = await db
    .insert(trials)
    .values({
      ownerId: s.ownerId,
      runId: s.runId,
      contenderId: s.contenderId,
      workloadId: "project-tracker",
      repeat: seq * 10 + Math.floor(Math.random() * 9),
      state: "failed_subject",
      failureClass: "budget",
      costMicroUsd: 2_000_000n,
      ...extra,
    })
    .returning();
  return t!;
}

describe.skipIf(!available)(
  "grading failed_subject trials on their frozen workspace (TDM-232)",
  () => {
    let h: FreshDbTdm11;

    beforeAll(async () => {
      h = await freshMigratedDbTdm11({ max: 2 });
    }, 60_000);

    afterAll(async () => {
      await h?.drop();
    });

    function depsTdm232(over: Partial<GateTrialDeps> = {}): GateTrialDeps {
      return {
        db: h.db,
        registry: createComputerRegistry({
          provider: new FakeProvider({ name: `fake-tdm232-${++seq}` }),
          store: drizzleComputerStore(h.db),
          pricing: { pricePerBlockMicroUsd: 1000n },
        }),
        frozen: {
          frozen: async () => ({
            kind: "url",
            url: "https://r2.example.com/o?X-Amz-Signature=s",
            sha256: "b".repeat(64),
            sizeBytes: 9,
          }),
        },
        kitFiles: { scoringFiles: async () => [] },
        workerId: "worker-tdm232",
        ...over,
      };
    }

    const eventsOf = (runId: string) =>
      h.db.select().from(eventsTable).where(eq(eventsTable.runId, runId));

    it("a capped trial with a frozen workspace gets a gate result and a fraction, and stays failed_subject", async () => {
      const s = await seedTdm232(h.db);
      const t = await trialTdm232(h.db, s, { frozenWorkspace: PENDING_TDM232 });
      expect(trialSettled(t)).toBe(false); // the run waits for the grade
      let calls = 0;
      const report = await gateTrial(
        depsTdm232({
          runGates: async (input) => {
            calls++;
            return recordTdm232(input.trialId);
          },
        }),
        { trial_id: t.id, attempt: 1 },
      );
      expect(report).toMatchObject({ outcome: "scored", to: "failed_subject" });
      const [row] = await h.db.select().from(trials).where(eq(trials.id, t.id));
      expect(row).toMatchObject({ state: "failed_subject", failureClass: "budget" });
      expect((row!.gate as TrialGateRecord).gates["hidden-tests"]!.result.pass).toBe(false);
      const metrics = row!.metrics as Record<string, number>;
      expect(metrics.hidden_test_fraction).toBeCloseTo(87 / 120, 12);
      expect(metrics.hidden_tests_passed).toBe(87);
      expect(metrics.compute_cost_micro_usd).toBe(2_000_000);
      expect(frozenWorkspaceOf(row!.frozenWorkspace)?.grading).toBe("graded");
      expect(trialSettled(row!)).toBe(true);

      const evs = await eventsOf(s.runId);
      expect(evs.filter((e) => e.type === "trial.gate")).toHaveLength(1);
      // No state change: no phase edge, the outcome is still the subject's failure.
      expect(evs.filter((e) => e.type === "trial.phase")).toHaveLength(0);

      expect(outcomeNoteOf(row!)).toBe(
        "stopped at the token cap; graded on its frozen workspace (87 of 120 hidden tests)",
      );
      const detail = toTrialDetail(row!, []);
      expect(detail.frozen_workspace?.grading).toBe("graded");
      expect(detail.outcome_note).toContain("graded on its frozen workspace");

      // Idempotent: a repeated job grades nothing twice.
      expect(await gateTrial(depsTdm232(), { trial_id: t.id, attempt: 1 })).toMatchObject({
        outcome: "skipped",
      });
      expect(calls).toBe(1);
    });

    it("a failed_subject trial with no frozen workspace is not graded (unchanged)", async () => {
      const s = await seedTdm232(h.db);
      for (const fw of [NONE_TDM232, null]) {
        const t = await trialTdm232(h.db, s, {
          frozenWorkspace: fw,
          failureClass: "healthcheck_failed",
        });
        expect(trialSettled(t)).toBe(true);
        const report = await gateTrial(
          depsTdm232({
            runGates: async () => {
              throw new Error("must not score");
            },
          }),
          { trial_id: t.id, attempt: 1 },
        );
        expect(report).toMatchObject({ outcome: "skipped" });
        expect(outcomeNoteOf(t)).toBe(
          "its healthcheck failed; no frozen workspace to grade, counted as a fail",
        );
      }
    });

    it("our scoring failing on a frozen workspace leaves it failed_subject, ungraded, never failed_infra", async () => {
      const s = await seedTdm232(h.db);
      // No bundle in the store.
      const t1 = await trialTdm232(h.db, s, { frozenWorkspace: PENDING_TDM232 });
      const r1 = await gateTrial(
        depsTdm232({
          frozen: { frozen: async () => ({ kind: "missing", reason: "not in the store" }) },
        }),
        { trial_id: t1.id, attempt: 1 },
      );
      expect(r1).toMatchObject({ outcome: "ungraded" });
      const [row1] = await h.db.select().from(trials).where(eq(trials.id, t1.id));
      expect(row1).toMatchObject({ state: "failed_subject", failureClass: "budget", gate: null });
      expect(frozenWorkspaceOf(row1!.frozenWorkspace)).toMatchObject({
        grading: "unavailable",
        reason: expect.stringContaining("no frozen outputs"),
      });
      // Its cost and wall are recorded here (trial.execute left them to the gate).
      expect((row1!.metrics as Record<string, number>).compute_cost_micro_usd).toBe(2_000_000);
      expect(trialSettled(row1!)).toBe(true);
      expect(outcomeNoteOf(row1!)).toContain("could not be graded (our scoring failed");

      // The scoring computer failing past its retries.
      const t2 = await trialTdm232(h.db, s, { frozenWorkspace: PENDING_TDM232 });
      const flaky: GateTrialDeps["runGates"] = async () => {
        throw new GateInfraError("scoring computer could not be created: capacity");
      };
      await expect(
        gateTrial(depsTdm232({ runGates: flaky, infraAttempt: 1 }), {
          trial_id: t2.id,
          attempt: 1,
        }),
      ).rejects.toBeInstanceOf(GateInfraError);
      expect(
        await gateTrial(depsTdm232({ runGates: flaky, infraAttempt: GATE_INFRA_MAX_ATTEMPTS }), {
          trial_id: t2.id,
          attempt: 1,
        }),
      ).toMatchObject({
        outcome: "ungraded",
        reason: expect.stringMatching(/scoring failed 3 times/),
      });
      const [row2] = await h.db.select().from(trials).where(eq(trials.id, t2.id));
      expect(row2!.state).toBe("failed_subject");
      expect(frozenWorkspaceOf(row2!.frozenWorkspace)?.grading).toBe("unavailable");
      expect((await eventsOf(s.runId)).filter((e) => e.type === "trial.phase")).toHaveLength(0);
    });

    it("infra failures are unchanged: settled only out of tries, never graded", async () => {
      expect(
        trialSettled({ state: "failed_infra", attempt: 1, frozenWorkspace: PENDING_TDM232 }),
      ).toBe(false);
      expect(trialSettled({ state: "failed_infra", attempt: 3 })).toBe(true);
      const s = await seedTdm232(h.db);
      const t = await trialTdm232(h.db, s, {
        state: "failed_infra",
        failureClass: "heartbeat_lost",
        frozenWorkspace: null,
      });
      expect(await gateTrial(depsTdm232(), { trial_id: t.id, attempt: 1 })).toMatchObject({
        outcome: "skipped",
      });
      expect(outcomeNoteOf(t)).toBeNull();
    });
  },
);

describe("trial.execute follow-up (TDM-232)", () => {
  const exec = (state: "failed_subject" | "done", fw: FrozenWorkspace | null) => ({
    id: "0190f5a0-0000-7000-8000-000000232001",
    run_id: "r",
    owner_id: "o",
    state,
    attempt: 2,
    computer_id: null,
    provider: null,
    lease_owner: null,
    lease_until: null,
    started_at: null,
    ended_at: null,
    failure_class: "budget",
    exit_code: null,
    logs_url: null,
    machine: null,
    cost_micro_usd: 0n,
    log_offset: 0,
    frozen_workspace: fw,
  });

  it("enqueues trial.gate for a failed_subject trial that froze a workspace, nothing otherwise", async () => {
    const added: { task: string; payload: unknown; key?: string }[] = [];
    const addJob = (async (task: string, payload: unknown, spec?: { jobKey?: string }) => {
      added.push({ task, payload, ...(spec?.jobKey ? { key: spec.jobKey } : {}) });
      return {} as never;
    }) as Parameters<typeof enqueueFollowUp>[0];
    const t = exec("failed_subject", PENDING_TDM232);
    await enqueueFollowUp(addJob, {
      kind: "final",
      trial: t,
      state: "failed_subject",
      cost_micro_usd: 0n,
      kept_computer_id: null,
    });
    expect(added).toEqual([
      {
        task: TRIAL_GATE_JOB,
        payload: { trial_id: t.id, attempt: 2 },
        key: `trials:${t.id}:2:gate`,
      },
    ]);
    added.length = 0;
    await enqueueFollowUp(addJob, {
      kind: "final",
      trial: exec("failed_subject", NONE_TDM232),
      state: "failed_subject",
      cost_micro_usd: 0n,
      kept_computer_id: null,
    });
    expect(added).toEqual([]);
    await enqueueFollowUp(addJob, {
      kind: "retry",
      trial: { ...exec("failed_subject", null), state: "failed_infra" },
      retry_at: 0,
      delay_ms: 30_000,
      next_attempt: 3,
    });
    expect(added.map((a) => a.task)).toEqual([TRIAL_EXECUTE_JOB]);
  });
});

describe("a run with one capped, graded trial (TDM-232)", () => {
  it("produces a valid report with no 'gate missing', and says what happened", async () => {
    const kit: KitSpec = (await loadKit(path.join(defaultKitsDir(), "tandem-long-horizon"))).spec;
    const ids = kit.contenders.map((c, i) => [c.id, `0190f5a0-0000-7000-8000-00000023210${i}`]);
    const idOf = Object.fromEntries(ids) as Record<string, string>;
    const w = kit.workloads[0]!.id;
    const trialsIn: StageTrial[] = [];
    for (const c of kit.contenders) {
      for (let repeat = 0; repeat < 3; repeat++) {
        const capped = c.id === "claude-code-solo" && repeat === 2;
        const passed = capped ? 87 : 120 - repeat;
        trialsIn.push({
          id: `${c.id}-${repeat}`,
          contender: c.id,
          contender_id: idOf[c.id]!,
          workload_id: w,
          repeat,
          state: capped ? "failed_subject" : "done",
          attempt: 1,
          metrics: {
            wall_s: capped ? 9000 : 3000 + repeat,
            hidden_test_fraction: passed / 120,
            hidden_tests_passed: passed,
            hidden_tests_total: 120,
          },
          gate: recordTdm232(`${c.id}-${repeat}`, passed),
          cost_micro_usd: capped ? 25_000_000n : 5_000_000n,
          failure_class: capped ? "budget" : passed < 120 ? "gate" : null,
          frozen_workspace: { ...PENDING_TDM232, grading: "graded" },
        });
      }
    }
    // Our infra failure: left out of scoring, as before.
    trialsIn.push({
      id: "infra",
      contender: "tandem",
      contender_id: idOf.tandem!,
      workload_id: w,
      repeat: 3,
      state: "failed_infra",
      attempt: 3,
      metrics: null,
      gate: null,
      cost_micro_usd: 0n,
      failure_class: "heartbeat_lost",
      frozen_workspace: null,
    });
    const score = storedScoreOf(kit, trialsIn);
    expect(score.trials).toMatchObject({ scored: 3 * kit.contenders.length, infra: 1 });
    const solo = score.kit_score.contenders.find((c) => c.contenderId === "claude-code-solo")!;
    for (const r of solo.requirements) {
      expect(r.scored ? null : r.reason).not.toBe("no score: gate missing");
    }
    expect(solo.gates["hidden-tests"]).toMatchObject({ failed: 2, missing: 0, total: 3 });
    const frac = solo.requirements.find((r) => r.requirementId === "tests-fraction")!;
    if (!frac.scored) throw new Error(frac.reason);
    expect(frac.byWorkload[0]!.samples).toEqual([1, 119 / 120, 87 / 120]);
    const wall = solo.requirements.find((r) => r.requirementId === "wall")!;
    if (!wall.scored) throw new Error(wall.reason);
    expect(wall.byWorkload[0]!.samples).toEqual([3000, 10_800, 10_800]);

    const built = buildSummary({ kit, score, proof: [], trials: trialsIn });
    if (!built.ok) throw new Error(built.reason);
    const { md, report } = built.analysis;
    expect(md).not.toContain("gate missing");
    expect(md).toContain("1 infra failures (ours)");
    expect(md).toContain(
      "A · Claude Code solo, project-tracker #3: stopped at the token cap; graded on its frozen workspace (87 of 120 hidden tests)",
    );
    expect(report.failures.subject).toBe(1);
    expect(report.failures.infra).toBe(1);
  });
});
