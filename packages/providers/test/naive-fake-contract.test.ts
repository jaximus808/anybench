// TDM-22 done condition (offline half): NaiveProvider passes the shared ComputeProvider contract
// against FakeNaive, whose computers model the live box we recorded: fs rooted at /home/naive while
// the shell's HOME is /home/tenki, async provisioning, and fs writes that reach exec late.
import { FakeNaive } from "@anybench/naive";
import { runProviderContract } from "../src/contract.js";
import { NaiveProvider } from "../src/naive.js";

const fast = { putFileCheck: { attempts: 20, intervalMs: 10 }, readyIntervalMs: 10 };

runProviderContract(
  "naive (FakeNaive, live-box quirks)",
  () =>
    new NaiveProvider({
      ...fast,
      client: new FakeNaive({
        computers: { timeScale: 0.01, provisionDelayMs: 40, fsVisibilityDelayMs: 25 },
      }),
    }),
  { readyTimeoutMs: 5_000, testTimeoutMs: 15_000, detachedWaitMs: 5_000 },
);

// The same contract where the shell already runs in the fs home, so no link is made.
runProviderContract(
  "naive (FakeNaive, shell home = fs home)",
  () =>
    new NaiveProvider({
      ...fast,
      client: new FakeNaive({ computers: { timeScale: 0.01, shellHome: "/home/naive" } }),
    }),
  { readyTimeoutMs: 5_000, testTimeoutMs: 15_000, detachedWaitMs: 5_000 },
);
