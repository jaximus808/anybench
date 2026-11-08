// worker-hardening: the provider-outage breaker. The pure transitions, and the executor parking a
// trial (same state, same attempt, no computer, nothing billed) when a create / fork / mint gets a
// 5xx / 429 or the breaker is already open, then finishing normally once it closes.
import { FakeProxyKeys, FakeProxySpend, NaiveError } from "@anybench/naive";
import { ProviderError } from "@anybench/providers";
import { describe, expect, it } from "vitest";
import {
  breakerOnFailure,
  breakerOnProbe,
  breakerOnSuccess,
  CLOSED_BREAKER,
  executeTrial,
  memoryLaunchBreaker,
  outageMessage,
  TRIAL_MAX_OUTAGE_PAUSES,
} from "../src/index.js";
import { harnessTdm49, installFakeRunnerTdm49, preparedTdm49 } from "./executor-tdm49-fakes.js";

const CFG = { threshold: 3, windowMs: 1_000, probeIntervalMs: 500 };
const outage500 = () =>
  new ProviderError("provider", "naive internal (500): the sandbox request failed", {
    status: 500,
  });

describe("breaker transitions (worker-hardening)", () => {
  it("opens on N consecutive failures inside the window, not on spread-out ones", () => {
    let s = CLOSED_BREAKER;
    s = breakerOnFailure(s, 0, "e1", CFG).state;
    s = breakerOnFailure(s, 100, "e2", CFG).state;
    expect(s.status).toBe("closed");
    const r = breakerOnFailure(s, 200, "e3", CFG);
    expect(r.opened).toBe(true);
    expect(r.state).toMatchObject({ status: "open", failures: 3, nextProbeAt: 700 });

    // Outside the window the count starts over.
    let t = breakerOnFailure(CLOSED_BREAKER, 0, "a", CFG).state;
    t = breakerOnFailure(t, 100, "b", CFG).state;
    t = breakerOnFailure(t, 5_000, "c", CFG).state;
    expect(t).toMatchObject({ status: "closed", failures: 1 });
  });

  it("a success resets a closed breaker; only a passing probe closes an open one", () => {
    const one = breakerOnFailure(CLOSED_BREAKER, 0, "e", CFG).state;
    expect(breakerOnSuccess(one).failures).toBe(0);
    let open = CLOSED_BREAKER;
    for (let i = 0; i < 3; i++) open = breakerOnFailure(open, i, "e", CFG).state;
    expect(breakerOnSuccess(open).status).toBe("open");
    const failed = breakerOnProbe(open, 1_000, false, "still 500", CFG);
    expect(failed).toMatchObject({ closed: false, state: { status: "open", nextProbeAt: 1_500 } });
    expect(breakerOnProbe(failed.state, 2_000, true, null, CFG)).toMatchObject({
      closed: true,
      state: { status: "closed", failures: 0 },
    });
    expect(outageMessage("naive")).toBe("Naïve is having an outage; trials paused, nothing billed");
  });
});

describe("executor under a provider outage (worker-hardening)", () => {
  it("a 500 on create parks the trial without spending the attempt, then it runs", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok");
    const breaker = memoryLaunchBreaker(CFG);
    const id = h.newTrial();
    h.fake.failNext("create", outage500());

    const out = await executeTrial(h.deps({ breaker }), id);
    expect(out.kind).toBe("paused");
    const t = h.store.trials.get(id)!;
    expect(t).toMatchObject({ attempt: 1, state: "forking", computer_id: null, outage_pauses: 1 });
    expect(t.cost_micro_usd).toBe(0n);
    expect(breaker.state().failures).toBe(1);

    const again = await executeTrial(h.deps({ breaker }), id);
    expect(again.kind).toBe("collected");
    expect(h.store.trials.get(id)!.attempt).toBe(1);
    expect(breaker.state().failures).toBe(0); // the create that worked reset the count
  });

  it("while the breaker is open nothing is created; three 500s open it for everyone", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok");
    const breaker = memoryLaunchBreaker(CFG);
    const ids = [h.newTrial(), h.newTrial(), h.newTrial(), h.newTrial()];
    for (let i = 0; i < 3; i++) h.fake.failNext("create", outage500());
    for (const id of ids.slice(0, 3)) {
      expect((await executeTrial(h.deps({ breaker }), id)).kind).toBe("paused");
    }
    expect(breaker.state().status).toBe("open");
    const createsBefore = h.creates();
    const out = await executeTrial(h.deps({ breaker }), ids[3]!);
    expect(out).toMatchObject({ kind: "paused" });
    expect(h.creates()).toBe(createsBefore); // never asked the provider
    expect(h.store.trials.get(ids[3]!)!.outage_pauses ?? 0).toBe(0); // nothing was tried
    for (const id of ids) expect(h.store.trials.get(id)!.attempt).toBe(1);

    expect(breaker.probe(true)).toBe(true);
    for (const id of ids)
      expect((await executeTrial(h.deps({ breaker }), id)).kind).toBe("collected");
    for (const id of ids) expect(h.store.trials.get(id)!.attempt).toBe(1);
  });

  it("a 500 on the proxy-key mint parks the trial and destroys its computer", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok");
    h.fake.onExec(/proxy\.env|chmod 700/, (ctx) => {
      if (!ctx.command.includes("stat -c")) return { exitCode: 0 };
      const text = ctx.readFile(`${ctx.home}/.anybench/proxy.env`) ?? "";
      return { exitCode: 0, stdout: `600 ${new TextEncoder().encode(text).byteLength}\n` };
    });
    const keys = new FakeProxyKeys();
    let failMint = true;
    const create = keys.create.bind(keys);
    keys.create = async (body) => {
      if (failMint) {
        failMint = false;
        throw new NaiveError("the sandbox request failed", { status: 500, code: "internal" });
      }
      return create(body);
    };
    const breaker = memoryLaunchBreaker(CFG);
    const deps = h.deps({
      breaker,
      naiveProxy: { keys, spend: new FakeProxySpend() },
      source: {
        prepare: async () => ({
          ...preparedTdm49(),
          naive_proxy: { model: "anthropic/claude-sonnet-4.6", capMicroUsd: 1_000_000n },
        }),
      },
    });
    const id = h.newTrial();
    const out = await executeTrial(deps, id);
    expect(out.kind).toBe("paused");
    const t = h.store.trials.get(id)!;
    expect(t).toMatchObject({ attempt: 1, state: "installing", computer_id: null });
    expect([...h.computers.rows.values()].every((c) => c.status === "destroyed")).toBe(true);
    expect(h.fake.detached()).toHaveLength(0); // no runner was ever started

    const again = await executeTrial(deps, id);
    expect(again.kind).toBe("collected");
    expect(h.store.trials.get(id)!.attempt).toBe(1);
    expect(h.fake.detached()).toHaveLength(1);
  });

  it("a non-outage create error still spends the attempt; past the pause cap so does a 500", async () => {
    const h = harnessTdm49();
    const breaker = memoryLaunchBreaker({ ...CFG, threshold: 1_000 });
    const id = h.newTrial();
    h.fake.failNext("create", new ProviderError("validation", "bad spec", { status: 422 }));
    expect((await executeTrial(h.deps({ breaker }), id)).kind).toBe("retry");

    const id2 = h.newTrial();
    h.store.trials.set(id2, {
      ...h.store.trials.get(id2)!,
      outage_pauses: TRIAL_MAX_OUTAGE_PAUSES,
    });
    h.fake.failNext("create", outage500());
    const out = await executeTrial(h.deps({ breaker }), id2);
    expect(out.kind).toBe("retry");
    expect(h.store.trials.get(id2)).toMatchObject({
      state: "failed_infra",
      failure_class: "provider_outage",
    });
  });
});
