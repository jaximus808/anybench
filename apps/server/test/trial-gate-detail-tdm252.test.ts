// TDM-252 [21.12]: GET /trials/:id returned `gate: null` for every trial, graded ones included.
// The gate job stores a bench TrialGateRecord in trials.gate (one outcome per kit gate); the route
// parsed it as one plain GateResult, which never matched. Now `gates` lists each gate's verdict as
// its trial.gate event has it (passed, summary, the hidden-test counts) and `gate` is the verdict
// over all of them. The route half runs against local Postgres (skips without it).
import type { TrialGateRecord } from "@anybench/bench";
import {
  apiRoutes,
  createApiClient,
  newId,
  TrialIdSchema,
  type ApiClient,
  type Contender,
  type TrialId,
} from "@anybench/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contenders, trials } from "../src/db/schema/index.js";
import { gateVerdictsOf, overallGate } from "../src/routes/trials.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import {
  kitSpecTdm67,
  runsAppTdm67,
  seedUserTdm67,
  type RunsAppTdm67,
} from "./helpers/runs-tdm67.js";

type Outcome = TrialGateRecord["gates"][string];

function outcomeTdm252(o: {
  pass: boolean;
  reason: string;
  applicable?: boolean;
  status?: Outcome["status"];
  metrics?: Record<string, number>;
  evidence?: string[];
}): Outcome {
  return {
    result: {
      pass: o.pass,
      reason: o.reason,
      evidence: o.evidence ?? [],
      applicable: o.applicable ?? true,
    },
    status: o.status ?? "verdict",
    exit_code: 0,
    timed_out: false,
    duration_ms: 1100,
    log_tail: "",
    kit_suspect: false,
    ...(o.metrics ? { metrics: o.metrics } : {}),
  };
}

function recordTdm252(trialId: string, gates: Record<string, Outcome>): TrialGateRecord {
  return {
    version: 1,
    trial_id: trialId,
    workload_id: "project-tracker",
    scored_at: "2026-11-09T21:40:00.000Z",
    scoring_computer: null,
    sandbox: "uid",
    outputs_sha256: null,
    gates,
  };
}

const hiddenPass = outcomeTdm252({
  pass: true,
  reason: "120/120 hidden tests passed",
  evidence: ["hidden-tests.json"],
  metrics: { hidden_test_fraction: 1, hidden_tests_passed: 120, hidden_tests_total: 120 },
});
const hiddenFail = outcomeTdm252({
  pass: false,
  reason: "87/120 hidden tests passed; first failure: api › creates a project: 500",
  evidence: ["hidden-tests.json"],
  metrics: { hidden_test_fraction: 0.725, hidden_tests_passed: 87, hidden_tests_total: 120 },
});
const noWorkspace = outcomeTdm252({
  pass: false,
  reason: "the outputs have no workspace/",
});

describe("trial gate verdicts from trials.gate (TDM-252)", () => {
  it("a graded trial's record gives each gate's verdict with its hidden-test counts", () => {
    const verdicts = gateVerdictsOf(recordTdm252("t1", { "hidden-tests": hiddenFail }));
    expect(verdicts).toEqual([
      {
        gate: "hidden-tests",
        passed: false,
        applicable: true,
        summary: "87/120 hidden tests passed; first failure: api › creates a project: 500",
        status: "verdict",
        evidence: ["hidden-tests.json"],
        hidden_tests_passed: 87,
        hidden_tests_total: 120,
        hidden_test_fraction: 0.725,
      },
    ]);
    expect(overallGate(verdicts)).toEqual({
      pass: false,
      reason: "87/120 hidden tests passed; first failure: api › creates a project: 500",
      evidence: ["hidden-tests.json"],
    });
  });

  it("a gate that refused the outputs is a fail with no counts", () => {
    const verdicts = gateVerdictsOf(recordTdm252("t2", { "hidden-tests": noWorkspace }));
    expect(verdicts[0]).toMatchObject({
      passed: false,
      summary: "the outputs have no workspace/",
      hidden_tests_passed: null,
      hidden_tests_total: null,
      hidden_test_fraction: null,
    });
    expect(overallGate(verdicts)?.pass).toBe(false);
  });

  it("several gates: pass only when every applicable gate passed; a not-applicable gate is left out", () => {
    const api = outcomeTdm252({
      pass: false,
      applicable: false,
      reason: "no API on this workload",
      metrics: { hidden_tests_passed: 3 },
    });
    const both = gateVerdictsOf(
      recordTdm252("t3", { "hidden-tests": hiddenPass, "api-load": api }),
    );
    expect(both.find((v) => v.gate === "api-load")).toMatchObject({
      applicable: false,
      // a not-applicable gate never vouches for a number
      hidden_tests_passed: null,
    });
    expect(overallGate(both)).toEqual({
      pass: true,
      reason: "hidden-tests: 120/120 hidden tests passed; api-load: no API on this workload",
      evidence: ["hidden-tests.json"],
    });

    const failing = gateVerdictsOf(
      recordTdm252("t4", {
        "hidden-tests": hiddenPass,
        lint: outcomeTdm252({ pass: false, reason: "lint failed" }),
      }),
    );
    expect(overallGate(failing)?.pass).toBe(false);

    const none = gateVerdictsOf(recordTdm252("t5", { "api-load": api }));
    expect(overallGate(none)).toEqual({
      pass: false,
      reason: "no API on this workload",
      evidence: [],
      applicable: false,
    });
  });

  it("not gated (null, or not a record) gives no verdicts", () => {
    expect(gateVerdictsOf(null)).toEqual([]);
    expect(gateVerdictsOf({ not: "a record" })).toEqual([]);
    expect(overallGate([])).toBeNull();
  });
});

const available = await pgAvailableTdm11();
const BASE = "http://api.test";

describe.skipIf(!available)("GET /trials/:id returns the stored gate verdict (TDM-252)", () => {
  let db: FreshDbTdm11;
  let h: RunsAppTdm67;
  let a: ApiClient;
  let passed: TrialId;
  let failed: TrialId;
  let pending: TrialId;

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    h = runsAppTdm67(db.url);
    const alice = await seedUserTdm67(db.db, "alice-g252");
    a = createApiClient(
      BASE,
      { kind: "apiKey", key: alice },
      { fetch: (url, init) => Promise.resolve(h.app.request(url, init)) },
    );
    const run = await a.runs.create({
      body: {
        question: "Is the harness better?",
        source: { kind: "github", github: "BurntSushi/ripgrep" },
        budget_micro_usd: 5_000_000n,
        contenders: [kitSpecTdm67().contenders[0] as Contender],
      },
    });
    const runId = run.run.id;
    const [ct] = await db.db
      .select({ id: contenders.id })
      .from(contenders)
      .where(eq(contenders.runId, runId));
    passed = newId(TrialIdSchema);
    failed = newId(TrialIdSchema);
    pending = newId(TrialIdSchema);
    const base = {
      ownerId: alice,
      runId,
      contenderId: ct!.id,
      workloadId: "project-tracker",
      attempt: 1,
    };
    await db.db.insert(trials).values([
      {
        ...base,
        id: passed,
        repeat: 0,
        state: "done",
        gate: recordTdm252(passed, { "hidden-tests": hiddenPass }),
      },
      {
        ...base,
        id: failed,
        repeat: 1,
        state: "failed_subject",
        failureClass: "gate",
        gate: recordTdm252(failed, { "hidden-tests": noWorkspace }),
      },
      { ...base, id: pending, repeat: 2, state: "running" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await h?.dbh.close();
    await db?.drop();
  });

  it("a passing trial: gate.pass and the gate's hidden-test counts", async () => {
    const { trial } = await a.call(apiRoutes.trials.get, { params: { id: passed } });
    expect(trial.gate).toEqual({
      pass: true,
      reason: "120/120 hidden tests passed",
      evidence: ["hidden-tests.json"],
    });
    expect(trial.gates).toEqual([
      {
        gate: "hidden-tests",
        passed: true,
        applicable: true,
        summary: "120/120 hidden tests passed",
        status: "verdict",
        evidence: ["hidden-tests.json"],
        hidden_tests_passed: 120,
        hidden_tests_total: 120,
        hidden_test_fraction: 1,
      },
    ]);
  });

  it("a gated fail: the verdict the trial.gate event carries, not null", async () => {
    const { trial } = await a.call(apiRoutes.trials.get, { params: { id: failed } });
    expect(trial.gate).toEqual({
      pass: false,
      reason: "the outputs have no workspace/",
      evidence: [],
    });
    expect(trial.gates?.[0]).toMatchObject({
      gate: "hidden-tests",
      passed: false,
      summary: "the outputs have no workspace/",
    });
  });

  it("a trial not gated yet: gate null, no verdicts", async () => {
    const { trial } = await a.call(apiRoutes.trials.get, { params: { id: pending } });
    expect(trial.gate).toBeNull();
    expect(trial.gates).toEqual([]);
  });
});
