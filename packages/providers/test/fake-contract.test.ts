// TDM-12 done condition: FakeProvider passes the shared ComputeProvider contract.
import { runProviderContract } from "../src/contract.js";
import { FakeProvider } from "../src/fake.js";

runProviderContract("fake", () => new FakeProvider({ timeScale: 0.01 }), {
  readyTimeoutMs: 2_000,
  testTimeoutMs: 10_000,
  detachedWaitMs: 5_000,
});

// Same contract against a provider that provisions asynchronously and lacks snapshot/pause,
// so the capability-gated tests and the creating→running path are both exercised.
runProviderContract(
  "fake (slow provision, no snapshot/pause)",
  () =>
    new FakeProvider({
      timeScale: 0.01,
      provisionDelayMs: 50,
      capabilities: { snapshot: false, fork: false, pause: false, maxExecTimeoutMs: 60_000 },
    }),
  { readyTimeoutMs: 2_000, testTimeoutMs: 10_000, detachedWaitMs: 5_000 },
);
