// TDM-51 [5.6]: the trial.gate job on local Postgres. The scoring computer is a scripted
// FakeProvider (through the real @anybench/bench runGates) or a stubbed runGates. Pins: the job is
// the only writer of trials.gate, state edges collecting → gating → reviewing|done with events,
// fail-closed verdicts recorded as failure_class "gate", idempotency, stale attempts and
// subject snapshots refused for scoring.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { newId, TrialIdSchema } from "@anybench/core";
import { GateInfraError, runGates, SCORE_ROOT, type TrialGateRecord } from "@anybench/bench";
import { ArtifactTransferError, createComputerRegistry } from "@anybench/envs";
import { FakeProvider, type FakeExecContext } from "@anybench/providers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import {
  computers,
  contenders,
  events as eventsTable,
  kits,
  runs,
  trials,
  users,
} from "../src/db/schema/index.js";
import { JOBS } from "../src/jobs/index.js";
import {
  artifactFrozenOutputs,
  GATE_INFRA_MAX_ATTEMPTS,
  gateTrial,
  TRIAL_GATE_JOB,
  trialGateJob,
  trialGateJobKey,
  type GateTrialDeps,
  type KitFilesPort,
} from "../src/jobs/trial-gate.js";
import { drizzleComputerStore } from "../src/lib/computer-store.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const available = await pgAvailableTdm11();

/** A minimal ustar .tar.gz of these files (the runner's out.tar.gz shape). */
function tarGzTdm245(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}
const enc = new TextEncoder();
const SHA = "b".repeat(64);

function kitSpecTdm51(opts: { reviewed: boolean }) {
  return {
    schema_version: 2,
    subject: {
      kind: "software",
      name: "summer",
      summary: "sums numbers",
      better_means: ["correct"],
    },
    contenders: [
      {
        id: "summer",
        role: "subject",
        source: { github: "example/summer", ref: "v1.0.0" },
        driver: { type: "cli", verbs: { run: "adapters/summer/driver.sh run" } },
      },
    ],
    workloads: [{ id: "add", instruction: "workloads/add/instruction.md" }],
    gates: [
      { id: "sum-tests", kind: "hidden-tests" },
      { id: "db-state", kind: "db-state" },
    ],
    requirements: [
      {
        id: "solved",
        type: "measured",
        title: "Solved",
        metric: "gate_pass_rate",
        better: "higher",
        gate_id: "sum-tests",
      },
      ...(opts.reviewed
        ? [{ id: "quality", type: "reviewed", title: "Quality", gate_id: "sum-tests" }]
        : []),
    ],
    proof: { oracle: { id: "ref", dir: "proof/oracle/" } },
    scoring: { weights: opts.reviewed ? { solved: 80, quality: 20 } : { solved: 100 } },
    repeats: 1,
  };
}

const SCORING_TDM51 = [
  { path: "gates/sum-tests/check.sh", data: enc.encode("#!/bin/sh\n") },
  { path: "gates/db-state/check.sh", data: enc.encode("#!/bin/sh\n") },
];
const kitFilesTdm51: KitFilesPort = { scoringFiles: async () => SCORING_TDM51 };

interface SeedTdm51 {
  ownerId: string;
  runId: string;
  contenderId: string;
}

let loginSeq = 0;
async function seedTdm51(db: Database, reviewed: boolean): Promise<SeedTdm51> {
  const n = ++loginSeq;
  const [u] = await db
    .insert(users)
    .values({ githubLogin: `gate${n}`, githubId: 5100 + n })
    .returning();
  const [run] = await db
    .insert(runs)
    .values({ ownerId: u!.id, question: "correct?", budgetMicroUsd: 1_000_000n, state: "running" })
    .returning();
  const [kit] = await db
    .insert(kits)
    .values({
      ownerId: u!.id,
      runId: run!.id,
      version: 1,
      spec: kitSpecTdm51({ reviewed }),
      hash: `h${n}`,
    })
    .returning();
  await db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run!.id));
  const [c] = await db
    .insert(contenders)
    .values({ runId: run!.id, kitId: kit!.id, source: "github", role: "subject" })
    .returning();
  return { ownerId: u!.id, runId: run!.id, contenderId: c!.id };
}

let repeatSeq = 0;
async function trialTdm51(
  db: Database,
  s: SeedTdm51,
  state: (typeof trials.$inferInsert)["state"],
  extra: Partial<typeof trials.$inferInsert> = {},
) {
  const [t] = await db
    .insert(trials)
    .values({
      ownerId: s.ownerId,
      runId: s.runId,
      contenderId: s.contenderId,
      workloadId: "add",
      repeat: repeatSeq++,
      state,
      ...extra,
    })
    .returning();
  return t!;
}

/** A FakeProvider scoring computer whose checks answer from `verdicts`. */
function fakeScoringTdm51(verdicts: Record<string, string | null>) {
  const fake = new FakeProvider({ name: `fake-tdm51-${++loginSeq}` });
  fake.onExec(/\.anybench\/score\/(fetch|setup)\.sh'$/, (ctx: FakeExecContext) =>
    ctx.command.includes("setup.sh") ? `AB_SETUP frozen=ok sha256=${SHA}\n` : "",
  );
  fake.onExec(/^printf '%s %s/, () => `9 ${SHA}\n`);
  fake.onExec(/bin\/gate-([a-z0-9._-]+)\.sh'/, (ctx: FakeExecContext) => {
    const id = ctx.match![1]!;
    const v = verdicts[id] ?? null;
    if (v !== null) ctx.writeFile(`${SCORE_ROOT}/status/${id}.verdict`, v);
    ctx.writeFile(
      `${SCORE_ROOT}/status/${id}.json`,
      JSON.stringify({ rc: 0, duration_ms: 2, verdict: v === null ? "missing" : "present" }),
    );
    return "";
  });
  fake.onExec(/cat '([^']+)'/, (ctx: FakeExecContext) => {
    const text = ctx.readFile(ctx.match![1]!);
    return text === undefined ? { exitCode: 1 } : { stdout: text };
  });
  return fake;
}

describe.skipIf(!available)("trial.gate (TDM-51, local Postgres)", () => {
  let h: FreshDbTdm11;

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 2 });
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  function depsTdm51(fake: FakeProvider, over: Partial<GateTrialDeps> = {}): GateTrialDeps {
    return {
      db: h.db,
      registry: createComputerRegistry({
        provider: fake,
        store: drizzleComputerStore(h.db),
        pricing: { pricePerBlockMicroUsd: 1000n },
      }),
      frozen: {
        frozen: async () => ({
          kind: "url",
          url: "https://r2.example.com/o?X-Amz-Signature=s",
          sha256: SHA,
          sizeBytes: 9,
        }),
      },
      kitFiles: kitFilesTdm51,
      gateOptions: { pollIntervalMs: 5, graceMs: 0, sleep: async () => undefined },
      workerId: "worker-tdm51",
      ...over,
    };
  }

  async function eventsOf(runId: string) {
    return h.db.select().from(eventsTable).where(eq(eventsTable.runId, runId));
  }

  it("is registered, with a job key distinct from trial.execute", () => {
    expect(JOBS).toContain(trialGateJob);
    expect(trialGateJob.name).toBe(TRIAL_GATE_JOB);
    const id = newId(TrialIdSchema);
    expect(trialGateJobKey(id, 2)).toBe(`trials:${id}:2:gate`);
  });

  it("collecting → gating → done: records every gate and emits trial.gate events", async () => {
    const s = await seedTdm51(h.db, false);
    const t = await trialTdm51(h.db, s, "collecting");
    const fake = fakeScoringTdm51({
      "sum-tests": JSON.stringify({ pass: true, reason: "3/3", evidence: ["workspace/sum.sh"] }),
      "db-state": JSON.stringify({ pass: false, applicable: false, reason: "no db", evidence: [] }),
    });
    const report = await gateTrial(depsTdm51(fake), { trial_id: t.id, attempt: 1 });
    expect(report).toMatchObject({ outcome: "scored", to: "done" });

    const [row] = await h.db.select().from(trials).where(eq(trials.id, t.id));
    expect(row!.state).toBe("done");
    expect(row!.endedAt).not.toBeNull();
    expect(row!.failureClass).toBeNull();
    const gate = row!.gate as TrialGateRecord;
    expect(gate.gates["sum-tests"]!.result).toMatchObject({ pass: true, applicable: true });
    expect(gate.gates["db-state"]!.result).toMatchObject({ pass: false, applicable: false });
    expect(gate.scoring_computer?.destroyed).toBe(true);

    const evs = await eventsOf(s.runId);
    const phases = evs
      .filter((e) => e.type === "trial.phase")
      .map((e) => `${(e.payload as { from: string }).from}>${(e.payload as { to: string }).to}`);
    expect(phases).toEqual(["collecting>gating", "gating>done"]);
    const gateEvents = evs.filter((e) => e.type === "trial.gate");
    expect(gateEvents.map((e) => (e.payload as { gate: string }).gate).sort()).toEqual([
      "db-state",
      "sum-tests",
    ]);
    for (const e of gateEvents) expect(e.actor).toMatch(/"kind":"worker","id":"worker-tdm51"/);

    // The scoring computer has its own row, destroyed, separate from any subject computer.
    const [comp] = await h.db
      .select()
      .from(computers)
      .where(eq(computers.id, gate.scoring_computer!.computer_id));
    expect(comp).toMatchObject({ status: "destroyed", trialId: t.id });

    // Idempotent: a retry of the same job changes nothing.
    expect(await gateTrial(depsTdm51(fake), { trial_id: t.id, attempt: 1 })).toMatchObject({
      outcome: "skipped",
    });
    expect((await eventsOf(s.runId)).length).toBe(evs.length);
  });

  it("a failing verdict is the contender's: failure_class gate, then done (review skipped until the reviewer ships)", async () => {
    const s = await seedTdm51(h.db, true);
    const t = await trialTdm51(h.db, s, "gating");
    const fake = fakeScoringTdm51({
      "sum-tests": JSON.stringify({ pass: false, reason: "1/3 hidden cases fail", evidence: [] }),
      "db-state": JSON.stringify({ pass: false, applicable: false, reason: "no db", evidence: [] }),
    });
    const report = await gateTrial(depsTdm51(fake), { trial_id: t.id, attempt: 1 });
    expect(report).toMatchObject({ outcome: "scored", to: "done" });
    const [row] = await h.db.select().from(trials).where(eq(trials.id, t.id));
    expect(row!.state).toBe("done");
    expect(row!.failureClass).toBe("gate");
    const gate = row!.gate as TrialGateRecord;
    expect(gate.gates["sum-tests"]).toMatchObject({
      status: "verdict",
      kit_suspect: false,
      result: { pass: false, reason: "1/3 hidden cases fail" },
    });
  });

  it("traces the trial after scoring from its bundle; a trace failure never changes the score", async () => {
    const bundle = new Uint8Array(
      readFileSync(new URL("./fixtures/trial-trace/solo-todo-api.tar.gz", import.meta.url)),
    );
    const s = await seedTdm51(h.db, true);
    const t = await trialTdm51(h.db, s, "gating");
    const fake = fakeScoringTdm51({});
    const put: { runId: string; trialId: string; actors: number }[] = [];
    const report = await gateTrial(
      depsTdm51(fake, {
        traces: {
          bundles: { bundle: async () => bundle },
          traces: {
            get: async () => null,
            put: async (runId, trialId, trace) => {
              put.push({ runId, trialId, actors: trace.actors.length });
            },
          },
        },
      }),
      { trial_id: t.id, attempt: 1 },
    );
    expect(report).toMatchObject({ outcome: "scored", to: "done" });
    expect(put).toEqual([{ runId: s.runId, trialId: t.id, actors: 1 }]);

    // A broken bundle source: the trial is still scored the same way.
    const t2 = await trialTdm51(h.db, s, "gating");
    const report2 = await gateTrial(
      depsTdm51(fakeScoringTdm51({}), {
        traces: {
          bundles: {
            bundle: async () => {
              throw new Error("store down");
            },
          },
          traces: { get: async () => null, put: async () => undefined },
        },
      }),
      { trial_id: t2.id, attempt: 1 },
    );
    expect(report2).toMatchObject({ outcome: "scored", to: "done" });
    const [row] = await h.db.select().from(trials).where(eq(trials.id, t2.id));
    expect(row!.state).toBe("done");
  });

  it("TDM-245: the headless policy's counts from the bundle's stream.jsonl go into trials.metrics with the verdict, read once", async () => {
    const policyStream = [
      { type: "system", subtype: "anybench_headless_policy", policy: "headless-v1" },
      { type: "system", subtype: "init", session_id: "s1", model: "claude-opus-5-5" },
      { type: "result", subtype: "success", session_id: "s1", num_turns: 3, total_cost_usd: 0.5 },
      { type: "system", subtype: "anybench_auto_answer", reply: "Yes, approved." },
      { type: "result", subtype: "success", session_id: "s1", num_turns: 5, total_cost_usd: 0.9 },
      { type: "system", subtype: "anybench_auto_answer", reply: "Yes, approved." },
      { type: "result", subtype: "success", session_id: "s1", num_turns: 6, total_cost_usd: 1.1 },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const s = await seedTdm51(h.db, false);
    // A stored value from an earlier scoring is replaced, the rest of the metrics kept.
    const t = await trialTdm51(h.db, s, "gating", {
      metrics: { questions_auto_answered: 9, some_gate_metric: 1 },
    });
    let reads = 0;
    const traced: number[] = [];
    const bundle = tarGzTdm245({ "stream.jsonl": policyStream, "versions.json": "{}" });
    const report = await gateTrial(
      depsTdm51(fakeScoringTdm51({}), {
        traces: {
          bundles: {
            bundle: async () => {
              reads++;
              return bundle;
            },
          },
          traces: {
            get: async () => null,
            put: async (_r, _t, trace) => void traced.push(trace.actors.length),
          },
        },
      }),
      { trial_id: t.id, attempt: 1 },
    );
    expect(report).toMatchObject({ outcome: "scored", to: "done" });
    const [row] = await h.db.select().from(trials).where(eq(trials.id, t.id));
    expect(row!.metrics).toMatchObject({
      questions_auto_answered: 2,
      auto_answer_cap_reached: 0,
      some_gate_metric: 1,
    });
    // The trace reuses the bytes the metrics read: one download per trial.
    expect(reads).toBe(1);
    expect(traced).toHaveLength(1);

    // A transcript without the policy (Tandem's, any other kit's): the counts are cleared, not kept.
    const plain = tarGzTdm245({
      "stream.jsonl": JSON.stringify({ type: "result", subtype: "success", num_turns: 1 }),
    });
    const t2 = await trialTdm51(h.db, s, "gating", { metrics: { questions_auto_answered: 4 } });
    await gateTrial(
      depsTdm51(fakeScoringTdm51({}), {
        traces: {
          bundles: { bundle: async () => plain },
          traces: { get: async () => null, put: async () => undefined },
        },
      }),
      { trial_id: t2.id, attempt: 1 },
    );
    const [row2] = await h.db.select().from(trials).where(eq(trials.id, t2.id));
    expect(row2!.metrics).not.toHaveProperty("questions_auto_answered");
    expect(row2!.metrics).not.toHaveProperty("auto_answer_cap_reached");

    // The bundle could not be read: the stored counts stay and the trial is scored the same way.
    const t3 = await trialTdm51(h.db, s, "gating", { metrics: { questions_auto_answered: 3 } });
    const report3 = await gateTrial(
      depsTdm51(fakeScoringTdm51({}), {
        traces: {
          bundles: {
            bundle: async () => {
              throw new Error("store down");
            },
          },
          traces: { get: async () => null, put: async () => undefined },
        },
      }),
      { trial_id: t3.id, attempt: 1 },
    );
    expect(report3).toMatchObject({ outcome: "scored", to: "done" });
    const [row3] = await h.db.select().from(trials).where(eq(trials.id, t3.id));
    expect(row3!.metrics).toMatchObject({ questions_auto_answered: 3 });
  });

  it("a check that broke on the outputs is the contender's counted FAIL plus trial.kit_suspect, never a re-roll", async () => {
    const s = await seedTdm51(h.db, true);
    const t = await trialTdm51(h.db, s, "gating");
    const fake = fakeScoringTdm51({
      "sum-tests": null,
      "db-state": JSON.stringify({ pass: false, reason: "db rows differ", evidence: [] }),
    });
    const report = await gateTrial(depsTdm51(fake), { trial_id: t.id, attempt: 1 });
    expect(report).toMatchObject({ outcome: "scored", to: "done" });
    const [row] = await h.db.select().from(trials).where(eq(trials.id, t.id));
    expect(row!.state).toBe("done");
    expect(row!.failureClass).toBe("gate");
    const gate = row!.gate as TrialGateRecord;
    expect(gate.gates["sum-tests"]).toMatchObject({
      status: "no_verdict",
      kit_suspect: true,
      result: { pass: false },
    });
    // The suspect gate does not erase the other gate's real FAIL.
    expect(gate.gates["db-state"]).toMatchObject({
      status: "verdict",
      kit_suspect: false,
      result: { pass: false, reason: "db rows differ" },
    });
    const evs = await eventsOf(s.runId);
    const suspects = evs.filter((e) => e.type === "trial.kit_suspect");
    expect(suspects).toHaveLength(1);
    expect(suspects[0]!.payload).toMatchObject({ gate: "sum-tests", status: "no_verdict" });
    expect(
      evs.some(
        (e) => e.type === "trial.phase" && (e.payload as { to: string }).to === "failed_infra",
      ),
    ).toBe(false);
  });

  it("a kit error (check not in the bundle) is failure_class kit, before any computer", async () => {
    const s = await seedTdm51(h.db, false);
    const t = await trialTdm51(h.db, s, "gating");
    const fake = fakeScoringTdm51({});
    const report = await gateTrial(
      depsTdm51(fake, { kitFiles: { scoringFiles: async () => [SCORING_TDM51[0]!] } }),
      { trial_id: t.id, attempt: 1 },
    );
    expect(report).toMatchObject({ outcome: "failed_infra", failureClass: "kit" });
    const [row] = await h.db.select().from(trials).where(eq(trials.id, t.id));
    expect(row).toMatchObject({ state: "failed_infra", failureClass: "kit", gate: null });
    expect(await fake.list({ includeDestroyed: true })).toEqual([]);
  });

  it("a missing out.tar.gz is our failure: failed_infra, failure_class infra, no scoring computer", async () => {
    const s = await seedTdm51(h.db, false);
    const t = await trialTdm51(h.db, s, "gating");
    const fake = fakeScoringTdm51({});
    const store = {
      createDownload: async () => {
        throw new ArtifactTransferError("not_found", "nope");
      },
    };
    const report = await gateTrial(depsTdm51(fake, { frozen: artifactFrozenOutputs(store) }), {
      trial_id: t.id,
      attempt: 1,
    });
    expect(report).toMatchObject({
      outcome: "failed_infra",
      failureClass: "infra",
      reason: expect.stringMatching(/out\.tar\.gz is not in the artifact store/),
    });
    const [row] = await h.db.select().from(trials).where(eq(trials.id, t.id));
    expect(row).toMatchObject({ state: "failed_infra", failureClass: "infra", gate: null });
    expect(await fake.list({ includeDestroyed: true })).toEqual([]);
  });

  it("skips stale attempts and trials outside collecting/gating", async () => {
    const s = await seedTdm51(h.db, false);
    const fake = fakeScoringTdm51({});
    const stale = await trialTdm51(h.db, s, "gating", { attempt: 2 });
    expect(await gateTrial(depsTdm51(fake), { trial_id: stale.id, attempt: 1 })).toMatchObject({
      outcome: "skipped",
      reason: expect.stringMatching(/stale attempt/),
    });
    const running = await trialTdm51(h.db, s, "running");
    expect(await gateTrial(depsTdm51(fake), { trial_id: running.id, attempt: 1 })).toMatchObject({
      outcome: "skipped",
    });
    const [row] = await h.db.select().from(trials).where(eq(trials.id, running.id));
    expect(row!.state).toBe("running");
    expect(row!.gate).toBeNull();
  });

  it("hands runGates every snapshot a subject ran on, and infra errors leave the trial in gating", async () => {
    const s = await seedTdm51(h.db, false);
    const [subj] = await h.db
      .insert(computers)
      .values({
        provider: "fake",
        providerId: `p-${loginSeq}`,
        runId: s.runId,
        snapshotId: "snap-subject",
        status: "destroyed",
      })
      .returning();
    const t = await trialTdm51(h.db, s, "gating", { computerId: subj!.id });
    let seen: string[] = [];
    const boom: typeof runGates = async (input) => {
      seen = input.subjectSnapshotIds ?? [];
      throw new Error("scoring computer never became ready");
    };
    await expect(
      gateTrial(depsTdm51(fakeScoringTdm51({}), { runGates: boom }), {
        trial_id: t.id,
        attempt: 1,
      }),
    ).rejects.toThrow(/never became ready/);
    expect(seen).toEqual(["snap-subject"]);
    const [row] = await h.db.select().from(trials).where(eq(trials.id, t.id));
    expect(row!.state).toBe("gating");
    expect(row!.gate).toBeNull();
  });

  it("GateInfraError retries are capped: the last allowed run fails the trial infra", async () => {
    const s = await seedTdm51(h.db, false);
    const t = await trialTdm51(h.db, s, "gating");
    let calls = 0;
    const flaky: typeof runGates = async () => {
      calls++;
      throw new GateInfraError("scoring computer could not be created: capacity");
    };
    const deps = (n: number) =>
      depsTdm51(fakeScoringTdm51({}), { runGates: flaky, infraAttempt: n });
    for (const n of [1, 2]) {
      await expect(gateTrial(deps(n), { trial_id: t.id, attempt: 1 })).rejects.toBeInstanceOf(
        GateInfraError,
      );
    }
    expect(
      await gateTrial(deps(GATE_INFRA_MAX_ATTEMPTS), { trial_id: t.id, attempt: 1 }),
    ).toMatchObject({
      outcome: "failed_infra",
      failureClass: "infra",
      reason: expect.stringMatching(/scoring failed 3 times/),
    });
    expect(calls).toBe(3);
    const [row] = await h.db.select().from(trials).where(eq(trials.id, t.id));
    expect(row).toMatchObject({ state: "failed_infra", failureClass: "infra" });
    // Once failed_infra, a stray job run does nothing (no new scoring computer).
    expect(await gateTrial(deps(4), { trial_id: t.id, attempt: 1 })).toMatchObject({
      outcome: "skipped",
    });
    expect(calls).toBe(3);
  });
});
