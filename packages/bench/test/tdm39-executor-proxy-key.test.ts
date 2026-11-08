// TDM-39 [4.7]: the executor revokes a trial's Naïve proxy key the moment a cap is hit and at the
// end of the attempt on every path (success, subject failure), never on a worker abort (the
// attempt is re-attached), polls the budget each heartbeat, and puts the proxy secret on the
// runner's redaction list (~/.anybench/env).
import { describe, expect, it } from "vitest";
import { parseEnvFile } from "@anybench/runner";
import { executeTrial, PROXY_SECRET_ENV_NAME, type TrialPrepared } from "../src/index.js";
import {
  harnessTdm49,
  installFakeRunnerTdm49,
  preparedTdm49,
  waitForTdm49,
} from "./executor-tdm49-fakes.js";

const PROXY_SECRET_TDM39 = "naive-proxy-tdm39-secret-0123456789";

function proxyPrepared(log: string[]): () => Promise<TrialPrepared> {
  return async () => ({
    ...preparedTdm49(),
    proxy_key: {
      secret: PROXY_SECRET_TDM39,
      revoke: async () => void log.push("revoke"),
      enforce: async () => void log.push("enforce"),
    },
  });
}

describe("executor: Naïve proxy key (TDM-39)", () => {
  it("polls the budget while it runs and revokes once at the end", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok");
    const log: string[] = [];
    const out = await executeTrial(
      h.deps({ source: { prepare: proxyPrepared(log) } }),
      h.newTrial(),
    );
    expect(out.kind).toBe("collected");
    expect(log.filter((l) => l === "enforce").length).toBeGreaterThan(0);
    expect(log.filter((l) => l === "revoke")).toHaveLength(1);
    expect(log.at(-1)).toBe("revoke");
  });

  it("puts the proxy secret on the runner's redaction list; an infra retry still revokes", async () => {
    const h = harnessTdm49();
    let envText = "";
    h.fake.onExec(/\.anybench\/bin\/runner' --trial/, (ctx) => {
      envText = ctx.readFile("/home/naive/.anybench/env") ?? "";
      return { exitCode: 0 }; // never writes status: runner_start, a retry
    });
    const log: string[] = [];
    const out = await executeTrial(
      h.deps({ source: { prepare: proxyPrepared(log) } }),
      h.newTrial(),
    );
    expect(out.kind).toBe("retry");
    expect(parseEnvFile(envText)[PROXY_SECRET_ENV_NAME]).toBe(PROXY_SECRET_TDM39);
    for (const c of h.fake.commands()) expect(c.command).not.toContain(PROXY_SECRET_TDM39);
    expect(log.filter((l) => l === "revoke")).toHaveLength(1);
  });

  it("revokes the moment the driver's token cap file appears, not only at the end", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok", 40);
    const log: string[] = [];
    let stateAtRevoke = "";
    const trialId = h.newTrial();
    const deps = h.deps({
      source: {
        prepare: async () => ({
          ...preparedTdm49(),
          proxy_key: {
            revoke: async () => {
              log.push("revoke");
              stateAtRevoke ||= (await h.store.get(trialId))!.state;
            },
          },
        }),
      },
    });
    const p = executeTrial(deps, trialId);
    await waitForTdm49(() => [...h.computers.rows.values()].some((r) => r.status === "running"));
    await waitForTdm49(() => h.fake.detached().length > 0);
    const row = [...h.computers.rows.values()][0]!;
    await h.fake.putFile(
      row.providerId!,
      "/home/naive/eval/out/coding-agent/token-cap.json",
      '{"token_cap_tokens":10,"tokens":11}\n',
    );
    const out = await p;
    expect(out.kind).toBe("collected");
    expect(log).toEqual(["revoke"]); // at the cap; the end-of-attempt call is a no-op
    expect(["running", "warming", "installing"]).toContain(stateAtRevoke);
  });

  it("revokes after a subject failure too", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "subject_fail");
    const log: string[] = [];
    const out = await executeTrial(
      h.deps({ source: { prepare: proxyPrepared(log) } }),
      h.newTrial(),
    );
    expect(out).toMatchObject({ kind: "final", state: "failed_subject" });
    expect(log.filter((l) => l === "revoke")).toHaveLength(1);
  });

  it("does not revoke when the worker aborts (the attempt is re-attached and still running)", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok", 40);
    const log: string[] = [];
    const ac = new AbortController();
    const p = executeTrial(h.deps({ source: { prepare: proxyPrepared(log) } }), h.newTrial(), {
      signal: ac.signal,
    });
    await waitForTdm49(() => h.fake.detached().length > 0);
    ac.abort();
    expect((await p).kind).toBe("aborted");
    expect(log).not.toContain("revoke");
  });
});
