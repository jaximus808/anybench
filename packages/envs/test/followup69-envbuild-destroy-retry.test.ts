// Follow-up 69: a network blip on the build computer's destroy must not leak it. The destroy is
// retried with backoff (destroy is idempotent); a refusal that cannot change is not retried.
import { FakeProvider, ProviderError, ProviderForbiddenError } from "@anybench/providers";
import { describe, expect, it } from "vitest";
import { buildEnvSnapshot } from "../src/index.js";

function provider() {
  const p = new FakeProvider();
  p.onExec("uname -m", () => "x86_64\n");
  return p;
}

const base = {
  spec: { vcpu: 2, memoryMb: 4096, diskGb: 20 },
  label: "f69",
  recipes: [],
  destroyBackoffMs: 1,
};

describe("env build destroy retry (follow-up 69)", () => {
  it("retries a failed destroy until the build computer is gone", async () => {
    const p = provider();
    p.failNext("destroy", new ProviderError("provider", "naive: fetch failed (ETIMEDOUT)"));
    p.failNext("destroy", new ProviderError("provider", "naive provider_error (503)"));
    const logs: string[] = [];
    const snap = await buildEnvSnapshot({ ...base, provider: p, log: (m) => void logs.push(m) });
    expect(snap.snapshotId).toMatch(/.+/);
    expect(await p.list()).toHaveLength(0);
    expect(logs.filter((m) => m === "env build destroy retry")).toHaveLength(2);
    expect(logs).not.toContain("env build computer destroy FAILED");
  });

  it("still retries the destroy after a failed build, and the build error wins", async () => {
    const p = provider();
    p.onExec(/./, () => ({ exitCode: 1, stderr: "boom" }));
    p.failNext("destroy", new ProviderError("provider", "naive: fetch failed"));
    await expect(buildEnvSnapshot({ ...base, provider: p })).rejects.toThrow();
    expect(await p.list()).toHaveLength(0);
  });

  it("is bounded, and does not retry a forbidden destroy", async () => {
    const p = provider();
    for (let i = 0; i < 3; i++) p.failNext("destroy", new ProviderError("provider", "down"));
    const logs: string[] = [];
    await buildEnvSnapshot({
      ...base,
      provider: p,
      destroyTries: 3,
      log: (m) => void logs.push(m),
    });
    expect(logs.filter((m) => m === "env build destroy retry")).toHaveLength(2);
    expect(logs).toContain("env build computer destroy FAILED");
    expect(await p.list()).toHaveLength(1);

    const q = provider();
    q.failNext("destroy", new ProviderForbiddenError("not yours"));
    const qlogs: string[] = [];
    await buildEnvSnapshot({ ...base, provider: q, log: (m) => void qlogs.push(m) });
    expect(qlogs).not.toContain("env build destroy retry");
    expect(qlogs).toContain("env build computer destroy FAILED");
  });
});
