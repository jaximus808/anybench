// TDM-22 done condition (live half): NaiveProvider passes the shared contract against the real
// Naïve API. Runs ONLY with NAIVE_LIVE=1 and NAIVE_API_KEY set, and SPENDS MONEY: one 2 vCPU /
// 4 GiB computer plus one fork for a few minutes (27 600 µ$ per 10-minute block each, so about
// 0.03-0.06 USD a run). `NAIVE_LIVE=1 pnpm --filter @anybench/providers test naive-live`.
//
// Every computer it makes carries the tag prefix `ab-<runId>-`; afterAll destroys whatever still
// carries it (and only that), then fails the file if anything of this run is left.
import { afterAll, expect } from "vitest";
import { runProviderContract } from "../src/contract.js";
import { createNaiveProviderFromEnv, type NaiveProvider } from "../src/naive.js";

const live = process.env.NAIVE_LIVE === "1" && !!process.env.NAIVE_API_KEY;
const runId = `ct22${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let provider: NaiveProvider | undefined;
const makeTdm22LiveProvider = () => (provider = createNaiveProviderFromEnv());

afterAll(async () => {
  if (!live || !provider) return;
  const prefix = `ab-${runId}-`;
  const left = await provider.list({ tagPrefix: prefix });
  for (const c of left) await provider.destroy(c.id).catch(() => undefined);
  const after = await provider.list({ tagPrefix: prefix });
  expect(
    after.map((c) => c.id),
    "the live contract leaked computers",
  ).toEqual([]);
}, 120_000);

runProviderContract("naive (live)", makeTdm22LiveProvider, {
  enabled: live,
  runId,
  spec: { vcpu: 2, memoryMb: 4096, diskGb: 5 },
  readyTimeoutMs: 300_000,
  readyIntervalMs: 2_000,
  testTimeoutMs: 120_000,
  detachedWaitMs: 30_000,
  missingId: "cmp_00000000000000000000000000000000",
  missingSnapshotId: "snp_00000000000000000000000000000000",
});
