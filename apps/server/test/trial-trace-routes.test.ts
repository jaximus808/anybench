// Trial trace routes against local Postgres (skips without it): GET /trials/:id/trace and
// GET /runs/:id/trace-summary are owner-scoped like the trial routes, parse with the contract, and
// serve the stored trace (a fake store here, holding a trace built from a real bundle fixture).
import { readFileSync } from "node:fs";
import {
  ApiClientError,
  apiRoutes,
  createApiClient,
  newId,
  RunIdSchema,
  TrialIdSchema,
  type ApiClient,
  type Contender,
  type RunId,
  type TrialId,
  type TrialTrace,
} from "@anybench/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contenders, trials } from "../src/db/schema/index.js";
import { traceFromBundle } from "../src/lib/trial-trace/parse.js";
import type { TrialTraceStore } from "../src/lib/trial-trace/store.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import {
  kitSpecTdm67,
  runsAppTdm67,
  seedApiKeyTdm67,
  seedUserTdm67,
  type RunsAppTdm67,
} from "./helpers/runs-tdm67.js";

const available = await pgAvailableTdm11();
const BASE = "http://api.test";

function clientFor(h: RunsAppTdm67, key: string): ApiClient {
  return createApiClient(
    BASE,
    { kind: "apiKey", key },
    { fetch: (url, init) => Promise.resolve(h.app.request(url, init)) },
  );
}

async function expectStatus(p: Promise<unknown>, status: number) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).status).toBe(status);
    return;
  }
  throw new Error(`expected HTTP ${status}`);
}

describe.skipIf(!available)("trial trace routes", () => {
  let db: FreshDbTdm11;
  let h: RunsAppTdm67;
  let alice: string;
  let a: ApiClient;
  let b: ApiClient;
  let runId: RunId;
  let traced: TrialId;
  let untraced: TrialId;
  const stored = new Map<string, TrialTrace>();
  const store: TrialTraceStore = {
    get: async (run, trial) => stored.get(`${run}/${trial}`) ?? null,
    put: async (run, trial, t) => void stored.set(`${run}/${trial}`, t),
  };

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    h = runsAppTdm67(db.url, { deps: { traces: store } });
    alice = await seedUserTdm67(db.db, "alice-tr");
    const bob = await seedUserTdm67(db.db, "bob-tr");
    a = clientFor(h, alice);
    b = clientFor(h, bob);
    const run = await a.runs.create({
      body: {
        question: "Is Tandem faster than Claude Code?",
        source: { kind: "github", github: "BurntSushi/ripgrep" },
        budget_micro_usd: 5_000_000n,
        contenders: [kitSpecTdm67().contenders[0] as Contender],
      },
    });
    runId = run.run.id;
    const [ct] = await db.db
      .select({ id: contenders.id })
      .from(contenders)
      .where(eq(contenders.runId, runId));
    traced = newId(TrialIdSchema);
    untraced = newId(TrialIdSchema);
    const gate = JSON.parse(
      readFileSync(
        new URL("./fixtures/trial-trace/tandem-todo-api-failed.gate.json", import.meta.url),
        "utf8",
      ),
    );
    await db.db.insert(trials).values([
      {
        id: traced,
        ownerId: alice,
        runId,
        contenderId: ct!.id,
        workloadId: "todo-api",
        repeat: 0,
        attempt: 1,
        state: "done",
        failureClass: "gate",
        gate,
      },
      {
        id: untraced,
        ownerId: alice,
        runId,
        contenderId: ct!.id,
        workloadId: "todo-api",
        repeat: 1,
        attempt: 1,
        state: "running",
      },
    ]);
    const bundle = new Uint8Array(
      readFileSync(
        new URL("./fixtures/trial-trace/tandem-todo-api-failed.tar.gz", import.meta.url),
      ),
    );
    // The fixture's trace, re-keyed to this trial.
    await store.put(runId, traced, { ...traceFromBundle(bundle, { trialId: traced, gate }) });
  }, 60_000);

  afterAll(async () => {
    await h?.dbh.close();
    await db?.drop();
  });

  it("trials.trace: the stored trace; 404 without one, for another tenant or an unknown trial", async () => {
    const { trace } = await a.call(apiRoutes.trials.trace, { params: { id: traced } });
    expect(trace.trial_id).toBe(traced);
    expect(trace.actors.map((x) => x.id)).toEqual(["planner", "worker-1", "worker-2", "worker-3"]);
    expect(trace.failure?.tests[0]?.file).toBe("persistence.test.ts");
    expect(typeof trace.actors[0]!.totals.cost_micro_usd).toBe("bigint");
    await expectStatus(a.call(apiRoutes.trials.trace, { params: { id: untraced } }), 404);
    await expectStatus(b.call(apiRoutes.trials.trace, { params: { id: traced } }), 404);
    await expectStatus(
      a.call(apiRoutes.trials.trace, { params: { id: newId(TrialIdSchema) } }),
      404,
    );
  });

  it("trials.trace: a key limited to another run is a 403", async () => {
    const key = await seedApiKeyTdm67(db.db, alice, ["runs:read"], [newId(RunIdSchema)]);
    await expectStatus(
      clientFor(h, key).call(apiRoutes.trials.trace, { params: { id: traced } }),
      403,
    );
  });

  it("trials.traceSummary: per setup, with n and the untraced trial counted as missing", async () => {
    const sum = await a.call(apiRoutes.trials.traceSummary, { params: { id: runId } });
    expect(sum.setups).toHaveLength(1);
    const s = sum.setups[0]!;
    expect(s.all.n).toBe(1);
    expect(s.all.passed).toBe(0);
    expect(s.missing).toBe(1);
    expect(s.all.sessions).toBe(4);
    await expectStatus(b.call(apiRoutes.trials.traceSummary, { params: { id: runId } }), 404);
  });
});
