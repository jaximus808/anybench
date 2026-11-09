// TDM-250 [21.10]: a trial's recorded BYOK spend is Claude Code's own session totals once the
// bundle is read (each session's latest `total_cost_usd`, summed over sessions and kept per
// attempt), and the runner's live meter only the in-flight figure. Run 01a1c202 recorded $184.80
// from a stale meter that summed every result's running total; its sessions said $87.71.
//   - settledTokenSpend: which figure wins (all sessions reported / one stopped open / no transcript);
//   - bundleReadings: solo `stream.jsonl` and Tandem's `tandem/streams/*.jsonl` from one archive;
//   - settledByokOf: proxy-key trials untouched, a bundle not read keeps the stored figure;
//   - recordFailedSubjectMetrics settles a failed_subject trial's spend from its bundle;
//   - the ops backfill (local Postgres): a dry run writes nothing, --apply corrects the trials and
//     runs.byok_token_micro_usd (the BYOK limit's "spent"), and a second apply changes nothing.
import path from "node:path";
import { gzipSync } from "node:zlib";
import { newId, toJsonValue, TrialIdSchema, type KitSpec } from "@anybench/core";
import { claudeCodeSpend } from "@anybench/bench";
import { loadKit } from "@anybench/kit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { contenders, kits, runs, trials, users } from "../src/db/schema/index.js";
import { recordFailedSubjectMetrics } from "../src/jobs/trial-execute.js";
import { readRunBudget, type BudgetPricing } from "../src/orchestrator/budget.js";
import {
  CURATED_HARNESS_LEAGUE_KIT,
  defaultKitsDir,
  LEAGUE_V1_WORKLOAD,
  leagueProfile,
} from "../src/orchestrator/curated.js";
import { backfillTokenSpend } from "../src/orchestrator/token-spend-backfill.js";
import {
  bundleReadings,
  isSessionTranscript,
  settledByokOf,
  settledTokenSpend,
} from "../src/orchestrator/trial-metrics.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const available = await pgAvailableTdm11();

/** A minimal ustar .tar.gz of these files (the runner's out.tar.gz shape). */
function tarGzTdm250(files: Record<string, string>): Uint8Array {
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

const jsonl = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n");
const init = (session: string) => ({ type: "system", subtype: "init", session_id: session });
const result = (session: string, usd: number) => ({
  type: "result",
  subtype: "success",
  session_id: session,
  total_cost_usd: usd,
});

/** B r0 of run 01a1c202: one session, five results each at the running total. */
const SUBAGENTS_STREAM = jsonl(
  init("b"),
  ...Array.from({ length: 5 }, () => result("b", 6.8140478)),
);
/** A Tandem trial: a planner and two workers, the workers with several results each. */
const TANDEM_FILES = {
  "tandem/streams/planner.jsonl": jsonl(init("p"), result("p", 1), result("p", 2.5)),
  "tandem/streams/worker-1.jsonl": jsonl(init("w1"), result("w1", 3), result("w1", 4)),
  "tandem/streams/worker-2.jsonl": jsonl(init("w2"), result("w2", 2.25)),
  "tandem/run.json": "{}",
};

describe("settled token spend (TDM-250)", () => {
  const sessions = (total: bigint, n: number, open: number) => ({
    total_micro_usd: total,
    sessions: n,
    open_sessions: open,
    results: n,
    per_session: [],
  });

  it("every session reported: their sum, whatever the meter said (stale or fresh)", () => {
    expect(settledTokenSpend(34_070_240n, sessions(6_814_048n, 1, 0))).toEqual({
      spend: 6_814_048n,
      source: "session_totals",
    });
    expect(settledTokenSpend(null, sessions(6_814_048n, 1, 0)).spend).toBe(6_814_048n);
  });

  it("a session stopped before it reported: the larger of the sum and the meter", () => {
    expect(settledTokenSpend(9_000_000n, sessions(5_000_000n, 2, 1))).toEqual({
      spend: 9_000_000n,
      source: "session_totals_and_meter",
    });
    expect(settledTokenSpend(4_000_000n, sessions(5_000_000n, 2, 1)).spend).toBe(5_000_000n);
    expect(settledTokenSpend(null, sessions(5_000_000n, 2, 1)).spend).toBe(5_000_000n);
  });

  it("no transcript: the meter (the in-flight figure) stands", () => {
    expect(settledTokenSpend(7n, null)).toEqual({ spend: 7n, source: "meter" });
    expect(settledTokenSpend(7n, sessions(0n, 0, 0))).toEqual({ spend: 7n, source: "meter" });
    expect(settledTokenSpend(null, null)).toEqual({ spend: null, source: "meter" });
  });

  it("is idempotent over its own output", () => {
    const s = sessions(5_000_000n, 2, 1);
    const once = settledTokenSpend(9_000_000n, s).spend;
    expect(settledTokenSpend(once, s).spend).toBe(once);
  });

  it("bundleReadings: solo stream.jsonl, and Tandem's sessions summed at each one's latest total", () => {
    expect(isSessionTranscript("stream.jsonl")).toBe(true);
    expect(isSessionTranscript("tandem/streams/worker-1.jsonl")).toBe(true);
    expect(isSessionTranscript("tandem/run.json")).toBe(false);
    expect(isSessionTranscript("workspace/stream.jsonl")).toBe(false);

    const solo = bundleReadings(tarGzTdm250({ "stream.jsonl": SUBAGENTS_STREAM }));
    expect(solo.sessions).toMatchObject({ total_micro_usd: 6_814_048n, sessions: 1, results: 5 });

    const tandem = bundleReadings(tarGzTdm250(TANDEM_FILES));
    expect(tandem.sessions).toMatchObject({
      total_micro_usd: 8_750_000n,
      sessions: 3,
      open_sessions: 0,
    });
    expect(tandem.autoAnswer).toEqual({});

    expect(bundleReadings(tarGzTdm250({ "versions.json": "{}" })).sessions).toBeNull();
  });

  it("settledByokOf: proxy-key trials untouched; an unread bundle keeps the stored figure", () => {
    const byAttempt = { "1": "100", "2": "34070240" };
    const s = claudeCodeSpend([{ name: "stream.jsonl", text: SUBAGENTS_STREAM }]);
    expect(
      settledByokOf({ attempt: 2, proxyKeyId: null, tokenSpendByAttempt: byAttempt }, s),
    ).toEqual({ byokTokens: 6_814_048n, store: 6_814_048n, source: "session_totals" });
    expect(
      settledByokOf({ attempt: 2, proxyKeyId: "k", tokenSpendByAttempt: byAttempt }, s),
    ).toEqual({});
    expect(
      settledByokOf({ attempt: 2, proxyKeyId: null, tokenSpendByAttempt: byAttempt }, undefined),
    ).toEqual({ byokTokens: 34_070_240n });
    // Already settled: nothing to store.
    expect(
      settledByokOf({ attempt: 1, proxyKeyId: null, tokenSpendByAttempt: { "1": "6814048" } }, s),
    ).toEqual({ byokTokens: 6_814_048n, source: "session_totals" });
  });
});

const PRICING: BudgetPricing = {
  runFeeMicroUsd: 2_000_000n,
  uploadedKitRunFeeMicroUsd: 0n,
  computeMarkupBps: 5000n,
  managedTokenMarkupBps: 2000n,
  blockPriceMicroUsd: 27_600n,
  proxyCapCeilingMicroUsd: 3_000_000n,
};

async function leagueSpec(): Promise<KitSpec> {
  const kit = (await loadKit(path.join(defaultKitsDir(), CURATED_HARNESS_LEAGUE_KIT))).spec;
  const cut = leagueProfile(kit, { workloads: [LEAGUE_V1_WORKLOAD], repeats: 1 });
  if (!cut.ok) throw new Error(cut.reason);
  return cut.spec;
}

let seq = 0;
async function seedRun(
  db: Database,
  spec: KitSpec,
  state: "running" | "delivered",
  rows: { contender: string; trial: Partial<typeof trials.$inferInsert> }[],
) {
  const n = ++seq;
  const [u] = await db
    .insert(users)
    .values({ githubLogin: `spend${n}`, githubId: 25_000 + n })
    .returning();
  const [run] = await db
    .insert(runs)
    .values({ ownerId: u!.id, question: "league", budgetMicroUsd: 50_000_000n, state })
    .returning();
  const [kit] = await db
    .insert(kits)
    .values({ ownerId: u!.id, runId: run!.id, version: 1, spec: toJsonValue(spec), hash: `h${n}` })
    .returning();
  await db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run!.id));
  const cids = new Map<string, string>();
  const ids: string[] = [];
  for (const [i, r] of rows.entries()) {
    let cid = cids.get(r.contender);
    if (!cid) {
      const [c] = await db
        .insert(contenders)
        .values({
          runId: run!.id,
          kitId: kit!.id,
          source: r.contender,
          role: "subject",
          foundBy: "kit",
        })
        .returning();
      cid = c!.id;
      cids.set(r.contender, cid);
    }
    const [t] = await db
      .insert(trials)
      .values({
        id: newId(TrialIdSchema),
        ownerId: u!.id,
        runId: run!.id,
        contenderId: cid,
        workloadId: LEAGUE_V1_WORKLOAD,
        repeat: i,
        state: "done",
        ...r.trial,
      })
      .returning();
    ids.push(t!.id);
  }
  return { runId: run!.id, ids };
}

describe.skipIf(!available)("BYOK spend from session totals (TDM-250, local Postgres)", () => {
  let h: FreshDbTdm11;
  let spec: KitSpec;

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 4 });
    spec = await leagueSpec();
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  it("recordFailedSubjectMetrics settles a failed_subject trial's spend from its bundle", async () => {
    const { runId, ids } = await seedRun(h.db, spec, "running", [
      {
        contender: "claude-code-subagents",
        trial: {
          state: "failed_subject",
          failureClass: "budget",
          tokenSpendByAttempt: { "1": "34070240" },
          tokenSpendMicroUsd: 34_070_240n,
        },
      },
    ]);
    const bundle = tarGzTdm250({ "stream.jsonl": SUBAGENTS_STREAM });
    await recordFailedSubjectMetrics(h.db, ids[0]!, null, { bundle: async () => bundle });
    const [row] = await h.db.select().from(trials).where(eq(trials.id, ids[0]!));
    expect(row!.tokenSpendByAttempt).toEqual({ "1": "6814048" });
    expect(row!.tokenSpendMicroUsd).toBe(6_814_048n);
    expect(row!.metrics).toMatchObject({ byok_token_cost_micro_usd: 6_814_048 });
    // The run's BYOK spent (the limit's) reads the corrected figure.
    expect((await readRunBudget(h.db, runId, PRICING))!.byokTokens).toBe(6_814_048n);
  });

  it("the backfill: a dry run writes nothing; --apply corrects trials and runs.byok_token_micro_usd; again changes nothing", async () => {
    const { runId, ids } = await seedRun(h.db, spec, "delivered", [
      // B: the stale meter summed five running totals.
      {
        contender: "claude-code-subagents",
        trial: {
          state: "failed_subject",
          attempt: 2,
          tokenSpendByAttempt: { "1": "0", "2": "34070240" },
          tokenSpendMicroUsd: 34_070_240n,
          metrics: { byok_token_cost_micro_usd: 34_070_240, wall_s: 900 },
        },
      },
      // D: Tandem, the meter summed every worker's results.
      {
        contender: "tandem",
        trial: {
          tokenSpendByAttempt: { "1": "17052340" },
          tokenSpendMicroUsd: 17_052_340n,
          metrics: { byok_token_cost_micro_usd: 17_052_340 },
        },
      },
      // A: already right.
      {
        contender: "claude-code-solo",
        trial: {
          tokenSpendByAttempt: { "1": "2880000" },
          tokenSpendMicroUsd: 2_880_000n,
          metrics: { byok_token_cost_micro_usd: 2_880_000 },
        },
      },
      // Cancelled before it ran: no bundle, nothing changes.
      { contender: "gstack", trial: { state: "cancelled" } },
      // A Naïve proxy trial is never touched.
      {
        contender: "superpowers",
        trial: {
          proxyKeyId: "key-1",
          proxyKeyAttempt: 1,
          tokenSpendByAttempt: { "1": "5" },
          tokenSpendMicroUsd: 5n,
        },
      },
    ]);
    await h.db.update(runs).set({ byokTokenMicroUsd: 54_002_580n }).where(eq(runs.id, runId));
    const bundles = new Map<string, Uint8Array>([
      [ids[0]!, tarGzTdm250({ "stream.jsonl": SUBAGENTS_STREAM })],
      [ids[1]!, tarGzTdm250(TANDEM_FILES)],
      [ids[2]!, tarGzTdm250({ "stream.jsonl": jsonl(init("a"), result("a", 2.88)) })],
    ]);
    const source = { bundle: async (_r: string, t: string) => bundles.get(t) ?? null };

    const before = await h.db.select().from(trials).where(eq(trials.runId, runId));
    const dry = await backfillTokenSpend(h.db, { runId, apply: false, bundles: source });
    expect(await h.db.select().from(trials).where(eq(trials.runId, runId))).toEqual(before);
    expect(dry.run).toEqual({
      stored_micro_usd: "54002580",
      new_micro_usd: String(6_814_048 + 8_750_000 + 2_880_000),
      written: false,
    });
    const line = (id: string) => dry.trials.find((l) => l.trialId === id)!;
    expect(line(ids[0]!)).toMatchObject({
      source: "session_totals",
      attempt_old_micro_usd: "34070240",
      attempt_new_micro_usd: "6814048",
      trial_new_micro_usd: "6814048",
      metric_new_micro_usd: 6_814_048,
      written: false,
    });
    expect(line(ids[1]!)).toMatchObject({ sessions: 3, trial_new_micro_usd: "8750000" });
    expect(line(ids[3]!)).toMatchObject({ source: "meter", note: "no bundle" });
    expect(line(ids[4]!)).toMatchObject({ source: "proxy_key", trial_new_micro_usd: "5" });
    expect(dry.byContender["claude-code-subagents"]).toEqual({
      trials: 1,
      old_micro_usd: "34070240",
      new_micro_usd: "6814048",
    });

    const applied = await backfillTokenSpend(h.db, {
      runId,
      apply: true,
      bundles: source,
      pricing: PRICING,
    });
    expect(applied.run).toMatchObject({ new_micro_usd: "18444048", written: true });
    const rows = new Map(
      (await h.db.select().from(trials).where(eq(trials.runId, runId))).map((r) => [r.id, r]),
    );
    expect(rows.get(ids[0]!)!.tokenSpendByAttempt).toEqual({ "1": "0", "2": "6814048" });
    expect(rows.get(ids[0]!)!.tokenSpendMicroUsd).toBe(6_814_048n);
    expect(rows.get(ids[0]!)!.metrics).toEqual({
      byok_token_cost_micro_usd: 6_814_048,
      wall_s: 900,
    });
    expect(rows.get(ids[1]!)!.tokenSpendMicroUsd).toBe(8_750_000n);
    expect(rows.get(ids[4]!)!.tokenSpendMicroUsd).toBe(5n);
    const [run] = await h.db.select().from(runs).where(eq(runs.id, runId));
    expect(run!.byokTokenMicroUsd).toBe(18_444_048n);

    const again = await backfillTokenSpend(h.db, {
      runId,
      apply: true,
      bundles: source,
      pricing: PRICING,
    });
    expect(again.trials.filter((l) => l.written)).toEqual([]);
    expect(again.run).toMatchObject({ new_micro_usd: "18444048", written: false });
  });
});
