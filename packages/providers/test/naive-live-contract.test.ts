// TDM-22 done condition (live half): NaiveProvider passes the shared contract against the real
// Naïve API. Runs ONLY with NAIVE_LIVE=1 and NAIVE_API_KEY set, and SPENDS MONEY: one 2 vCPU /
// 4 GiB computer plus one fork for a few minutes (27 600 µ$ per 10-minute block each, so about
// 0.03-0.06 USD a run). `NAIVE_LIVE=1 pnpm --filter @anybench/providers test naive-live`.
//
// Every computer it makes carries the tag prefix `ab-<runId>-`; afterAll destroys whatever still
// carries it (and only that), then fails the file if anything of this run is left.
import { afterAll, describe, expect, it } from "vitest";
import { runProviderContract } from "../src/contract.js";
import { legacyBackgroundedListCommand, trialTag } from "../src/helpers.js";
import { createNaiveProviderFromEnv, type NaiveProvider } from "../src/naive.js";

const live = process.env.NAIVE_LIVE === "1" && !!process.env.NAIVE_API_KEY;
const runId = `ct22${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let provider: NaiveProvider | undefined;
const makeTdm22LiveProvider = () => (provider = createNaiveProviderFromEnv());

afterAll(async () => {
  if (!live) return;
  const p = provider ?? createNaiveProviderFromEnv();
  const prefix = `ab-${runId}-`;
  const left = await p.list({ tagPrefix: prefix });
  for (const c of left) await p.destroy(c.id).catch(() => undefined);
  const after = await p.list({ tagPrefix: prefix });
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

// Probe for docs/findings/naive-provider.md: does a Naïve exec wait on a backgrounded
// `mkdir && setsid …` list (the pre-TDM-22 buildDetachedCommand), and does the current
// launch line return at once? (First run: the old line held the exec to its timeout.) One 1 vCPU / 512 MiB computer (9 750 µ$/block).
describe.skipIf(!live)("naive (live) detached-launch probe", () => {
  it("measures both launch lines", async () => {
    const p = createNaiveProviderFromEnv();
    const c = await p.waitReady(
      (
        await p.create({
          name: "detached probe",
          vcpu: 1,
          memoryMb: 512,
          tags: [trialTag(runId, "probe")],
        })
      ).id,
      { timeoutMs: 300_000, intervalMs: 2_000 },
    );
    try {
      const t0 = Date.now();
      const shared = await p.exec(
        c.id,
        legacyBackgroundedListCommand("sleep 45", `${c.home}/probe/shared.log`),
        {
          timeoutMs: 20_000,
        },
      );
      const sharedMs = Date.now() - t0;
      const t1 = Date.now();
      const own = await p.execDetached(c.id, "sleep 45", { logPath: "probe/own.log" });
      const ownMs = Date.now() - t1;
      const ps = await p.exec(c.id, "ps -eo pid,args | grep 'sleep 45' | grep -v grep || true");
      console.log(
        "TDM22-LIVE",
        JSON.stringify({
          shared: {
            exitCode: shared.exitCode,
            timedOut: shared.timedOut,
            durationMs: shared.durationMs,
            roundTripMs: sharedMs,
            stdout: shared.stdout,
            stderr: shared.stderr,
          },
          own: { pid: own.pid, roundTripMs: ownMs },
          sleeping: ps.stdout,
        }),
      );
      expect(ownMs).toBeLessThan(15_000);
    } finally {
      await p.destroy(c.id);
    }
  }, 420_000);
});
