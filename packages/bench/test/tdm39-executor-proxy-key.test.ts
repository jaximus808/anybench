// TDM-39 [4.7]: the executor revokes a trial's Naïve proxy key the moment a cap is hit and at the
// end of the attempt on every path (success, subject failure), never on a worker abort (the
// attempt is re-attached), polls the budget each heartbeat, and puts the proxy secret on the
// runner's redaction list (~/.anybench/env).
import { describe, expect, it } from "vitest";
import { parseEnvFile } from "@anybench/runner";
import { FakeProxyKeys, FakeProxySpend } from "@anybench/naive";
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

  it("mints the key with TDM-16 at launch, enforces the budget, revokes at the cap and at the end", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok", 40);
    // The fake shell has no chmod / umask / stat: answer TDM-16's env-file checks.
    h.fake.onExec(/proxy\.env|chmod 700/, (ctx) => {
      if (!ctx.command.includes("stat -c")) return { exitCode: 0 };
      const text = ctx.readFile(`${ctx.home}/.anybench/proxy.env`) ?? "";
      return { exitCode: 0, stdout: `600 ${new TextEncoder().encode(text).byteLength}\n` };
    });
    let envText = "";
    let proxyText = "";
    h.fake.onExec(/\.anybench\/bin\/runner' --trial/, (ctx) => {
      envText = ctx.readFile(`${ctx.home}/.anybench/env`) ?? "";
      proxyText = ctx.readFile(`${ctx.home}/.anybench/proxy.env`) ?? "";
      return { exitCode: 0 };
    });
    const keys = new FakeProxyKeys();
    const spend = new FakeProxySpend();
    const out = await executeTrial(
      h.deps({
        naiveProxy: { keys, spend },
        source: {
          prepare: async () => ({
            ...preparedTdm49(),
            naive_proxy: { model: "anthropic/claude-sonnet-4.6", capMicroUsd: 1_000_000n },
          }),
        },
      }),
      h.newTrial(),
    );
    // This fake launch never writes status: runner_start, a retry. The key is still revoked.
    expect(out.kind).toBe("retry");
    const [key] = [...keys.keys.values()];
    expect(key!.name).toMatch(/^anybench-trial-/);
    expect(key!.revoked).toBe(true);
    expect(parseEnvFile(proxyText)).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: key!.secret,
      ANTHROPIC_MODEL: "anthropic/claude-sonnet-4.6",
      MAX_THINKING_TOKENS: "0",
    });
    expect(parseEnvFile(envText)[PROXY_SECRET_ENV_NAME]).toBe(key!.secret);
    for (const c of h.fake.commands()) expect(c.command).not.toContain(key!.secret);
  });

  it("revokes mid-run when the ledger says the key spent its cap", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok", 40);
    h.fake.onExec(/proxy\.env|chmod 700/, (ctx) => {
      if (!ctx.command.includes("stat -c")) return { exitCode: 0 };
      const text = ctx.readFile(`${ctx.home}/.anybench/proxy.env`) ?? "";
      return { exitCode: 0, stdout: `600 ${new TextEncoder().encode(text).byteLength}\n` };
    });
    const keys = new FakeProxyKeys();
    const spend = new FakeProxySpend();
    let revokedWhile = "";
    const trialId = h.newTrial();
    const realRevoke = keys.revoke.bind(keys);
    keys.revoke = async (id) => {
      revokedWhile ||= (await h.store.get(trialId))!.state;
      await realRevoke(id);
    };
    const p = executeTrial(
      h.deps({
        naiveProxy: { keys, spend },
        source: {
          prepare: async () => ({
            ...preparedTdm49(),
            naive_proxy: { model: "anthropic/claude-sonnet-4.6", capMicroUsd: 50_000n },
          }),
        },
      }),
      trialId,
    );
    await waitForTdm49(() => keys.keys.size > 0 && h.fake.detached().length > 0);
    const [key] = [...keys.keys.values()];
    spend.add({
      actorKeyId: key!.id,
      billedMicroUsd: 60_000n,
      createdAt: "2026-11-08T00:00:01.000Z",
    });
    await waitForTdm49(() => key!.revoked);
    expect(["installing", "warming", "running"]).toContain(revokedWhile);
    expect((await p).kind).toBe("collected");
  });
});
