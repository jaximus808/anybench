// TDM-75: the live run page against the real API client and a fake SSE source. A recorded
// 60-trial run (test/fixtures/tdm75-run-stream.ts) is released into the fake step by step; each
// part of the page is checked against the fake server's own fold of the same events.
import { formatUsd } from "@anybench/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LiveRunPage } from "../components/live/LiveRunPage";
import {
  applyEvents,
  countTrials,
  initLive,
  mergeAgents,
  seedHistory,
  UNPLACED,
} from "../lib/live/model";
import { createWebApiClient } from "../lib/api";
import {
  AGENTS,
  ALERT_ID,
  CANCELLED,
  CONTENDERS,
  createFakeApi,
  EVIL_HTML,
  EVIL_URL,
  FAILED_INFRA_FINAL,
  fold,
  recordRun,
  RUN_ID,
  TRIALS,
  type FakeApiOptions,
  type Fold,
} from "./fixtures/tdm75-run-stream";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const OPTIONS = { reconnectDelayMs: 5, refreshMs: 600_000, historyEvents: 500 };

function setup(initialSeq: number, fakeOpts: FakeApiOptions = {}) {
  const rec = recordRun();
  const fake = createFakeApi(rec, initialSeq, fakeOpts);
  const client = createWebApiClient("https://api.test", { fetch: fake.fetch });
  window.history.replaceState(null, "", `/runs/${RUN_ID}`);
  const view = render(<LiveRunPage runId={RUN_ID} client={client} options={OPTIONS} />);
  return { rec, fake, ...view };
}

// --- reading the design's markup -------------------------------------------------------------

/** The phase the hero shows (one phase at a time, TDM-200). */
const stageNow = () =>
  screen.queryByTestId("phase-hero")?.querySelector("h2")?.textContent?.trim() ?? null;

/** The finished phases' labels, in order. */
const donePhases = () =>
  [...(screen.queryByRole("list", { name: "Finished phases" })?.querySelectorAll("li") ?? [])].map(
    (li) => li.querySelector("span:nth-child(3)")?.textContent ?? "",
  );

/** A counter chip's text ("3/60trials done"). */
const counter = (label: string) =>
  [...document.querySelectorAll("button[data-tone]")].find((b) => b.textContent?.includes(label))
    ?.textContent ?? "";

const spendText = () => screen.getByTestId("run-spend").textContent ?? "";

function trialName(i: number) {
  const t = TRIALS[i]!;
  const c = CONTENDERS.find((x) => x.id === t.contenderId)!;
  return `${c.name} · ${t.workloadId} #${t.repeat + 1}`;
}
const tile = (i: number) =>
  [...document.querySelectorAll<HTMLButtonElement>("button[data-key]")].find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith(`${trialName(i)}:`),
  );
const tileWord = (i: number) => (tile(i)?.getAttribute("aria-label") ?? "").split(": ")[1] ?? "";
const tiles = () => [...document.querySelectorAll<HTMLButtonElement>("button[data-key]")];

const agentLabel = (role: string) =>
  within(screen.getByRole("region", { name: "Agents" }))
    .queryAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? "")
    .find((l) => l.startsWith(`${role}:`));

const feedRows = () => [
  ...screen.getByRole("region", { name: "Activity" }).querySelectorAll("li[data-seq]"),
];

const alertBanner = () =>
  [...document.querySelectorAll<HTMLElement>("[role=alert]")].find((el) =>
    el.textContent?.includes("2 trials failed on the setup under test"),
  ) ?? null;

const streamRequests = (fake: ReturnType<typeof createFakeApi>) =>
  fake.requests.filter((r) => r.path.startsWith(`/runs/${RUN_ID}/stream`));

/** The design's counters, computed from the fake's fold. */
function designCounts(f: Fold) {
  const states = [...f.trials.values()].map((t) => t.state);
  const n = (p: (s: string) => boolean) => states.filter(p).length;
  return {
    total: states.length,
    done: n((s) => s === "done" || s === "failed_subject" || s === "cancelled"),
    infra: n((s) => s === "failed_infra"),
    running: n(
      (s) => !["queued", "done", "failed_subject", "failed_infra", "cancelled"].includes(s),
    ),
  };
}

async function expectCountersMatch(rec: ReturnType<typeof recordRun>, seq: number) {
  const f = fold(rec, seq);
  const c = designCounts(f);
  await waitFor(() => {
    expect(counter("trials done")).toBe(`${c.done}/${c.total}trials done`);
    expect(counter("running now")).toBe(`${c.running}running now`);
    expect(counter("our failures, not billed")).toBe(`${c.infra}our failures, not billed`);
    expect(spendText()).toContain(formatUsd(f.spent));
  });
}

const phaseSeq = (rec: ReturnType<typeof recordRun>, i: number, to: string) =>
  rec.events.find(
    (e) => e.type === "trial.phase" && e.source_id === TRIALS[i]!.id && e.payload.to === to,
  )!.seq;

// --- the replay ------------------------------------------------------------------------------

describe("live run page against a fake API (TDM-75)", () => {
  it("replays a 60-trial run: stages, counters, tiles, agents, feed, alert ack, resume", async () => {
    const { rec, fake } = setup(1);

    // Snapshot at seq 1, then the stream resumes after it with the Last-Event-ID header.
    await waitFor(() => expect(stageNow()).toBe("Intake"));
    await waitFor(() => expect(streamRequests(fake)).toHaveLength(1));
    expect(streamRequests(fake)[0]!.headers["last-event-id"]).toBe("1");
    expect(streamRequests(fake)[0]!.path).not.toContain("after=");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Does Tandem");

    // Understand: the understander appears with its last tool.
    fake.release(rec.marks.understand + 2);
    await waitFor(() => expect(stageNow()).toBe("Understand"));
    await waitFor(() => expect(agentLabel("understander")).toBeTruthy());

    // Research: the researcher appears; re-reading the sessions marks the understander done.
    fake.release(rec.marks.research + 1);
    await waitFor(() => expect(stageNow()).toBe("Research"));
    await waitFor(() => expect(agentLabel("researcher")).toBeTruthy());
    await waitFor(() => expect(agentLabel("understander")).toMatch(/^understander: done/));
    expect(donePhases()).toEqual(["Intake", "Understand"]);

    // Kit, then running: 60 queued tiles once trials.list places them.
    fake.release(rec.marks.kit + 1);
    await waitFor(() => expect(stageNow()).toBe("Kit"));
    fake.release(rec.marks.queued + 2);
    await waitFor(() => expect(stageNow()).toBe("Running"));
    await waitFor(() => expect(tiles()).toHaveLength(60));
    await waitFor(() =>
      expect(tiles().every((b) => b.getAttribute("aria-label")?.endsWith(": queued"))).toBe(true),
    );
    await expectCountersMatch(rec, rec.marks.queued + 2);
    await waitFor(() => expect(agentLabel("kit designer")).toMatch(/: done/));

    // Wave 1: tiles change by phase and gate; counters match the stream.
    fake.release(rec.marks.wave1);
    await waitFor(() => expect(tileWord(0)).toBe("passed gate"));
    expect(tileWord(3)).toBe("failed");
    expect(tileWord(10)).toBe("passed gate, attempt 2"); // our failure, retried
    expect(tileWord(14)).toBe("failed"); // done, gate failed
    expect(tileWord(20)).toBe("queued");
    await expectCountersMatch(rec, rec.marks.wave1);
    expect(spendText()).toContain(`estimate ${formatUsd(113_000_000n)}`);

    // A trial mid-way: running, then gating.
    fake.release(phaseSeq(rec, 15, "running"));
    await waitFor(() => expect(tileWord(15)).toBe("running (running)"));
    expect(counter("running now")).toBe("1running now");
    fake.release(phaseSeq(rec, 15, "gating"));
    await waitFor(() => expect(tileWord(15)).toBe("running (gating)"));

    // The alert banner, acked through POST /alerts/<the alert.fired source_id>/ack.
    fake.release(rec.marks.wave2);
    await waitFor(() => expect(alertBanner()).not.toBeNull());
    fireEvent.click(within(alertBanner()!).getByText("Acknowledge"));
    await waitFor(() => expect(alertBanner()).toBeNull());
    expect(
      fake.requests.some((r) => r.method === "POST" && r.path === `/alerts/${ALERT_ID}/ack`),
    ).toBe(true);
    await expectCountersMatch(rec, rec.marks.wave2);

    // The connection drops: reconnect with Last-Event-ID = last seq seen; nothing double counted.
    const before = streamRequests(fake).length;
    fake.failStreams();
    const mid = rec.marks.wave2 + 40;
    fake.release(mid);
    await waitFor(() => expect(streamRequests(fake).length).toBe(before + 1));
    expect(streamRequests(fake).at(-1)!.headers["last-event-id"]).toBe(String(rec.marks.wave2));
    await expectCountersMatch(rec, mid);

    // A clean close without `end` (function max duration): the client resumes on its own.
    fake.closeStreams();
    await waitFor(() => expect(streamRequests(fake).length).toBe(before + 2));
    expect(streamRequests(fake).at(-1)!.headers["last-event-id"]).toBe(String(mid));

    // The feed filters by text, source and severity.
    const feed = screen.getByRole("region", { name: "Activity" });
    fireEvent.change(within(feed).getByRole("searchbox"), { target: { value: "gate" } });
    expect(feedRows().length).toBeGreaterThan(0);
    for (const r of feedRows()) expect(r.textContent?.toLowerCase()).toContain("gate");
    fireEvent.change(within(feed).getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(within(feed).getByRole("button", { name: "trials" }));
    for (const r of feedRows())
      expect(r.querySelector("[data-source]")?.getAttribute("data-source")).toBe("trial");
    fireEvent.click(within(feed).getByRole("button", { name: "trials" }));
    fireEvent.change(within(feed).getByRole("combobox"), { target: { value: "warn" } });
    expect(feedRows().length).toBeGreaterThan(0);
    for (const r of feedRows())
      expect(["warn", "error", "critical"]).toContain(r.getAttribute("data-sev"));
    expect(feedRows().some((r) => r.textContent?.includes("failed (the setup under test)"))).toBe(
      true,
    );
    fireEvent.change(within(feed).getByRole("combobox"), { target: { value: "debug" } });
    expect(feedRows().some((r) => /heartbeat/.test(r.textContent ?? ""))).toBe(false);

    // To the end: delivered, every stage done, the stream finished.
    fake.release(rec.events.length);
    await waitFor(() => expect(screen.getByText("ended")).toBeTruthy());
    await waitFor(() => expect(stageNow()).toBe("Delivered"));
    expect(donePhases()).toHaveLength(11);
    expect(stageNow()).toBe("Delivered");
    await expectCountersMatch(rec, rec.events.length);
    expect(tileWord(FAILED_INFRA_FINAL)).toBe("our failure, not billed");
    expect(tileWord(CANCELLED)).toBe("cancelled");
    expect(agentLabel("reviewer")).toMatch(/^reviewer: done/);
  }, 90_000);

  it("opened mid-run: history fills the feed and the phase without moving the counters", async () => {
    const r2 = recordRun();
    const { fake } = setup(r2.marks.wave1);
    await waitFor(() => expect(stageNow()).toBe("Running"));
    await waitFor(() => expect(feedRows().length).toBeGreaterThan(100));
    // History came from events.list, not the stream.
    expect(fake.requests.some((r) => r.path.startsWith(`/runs/${RUN_ID}/events?`))).toBe(true);
    expect(streamRequests(fake)[0]!.headers["last-event-id"]).toBe(String(r2.marks.wave1));
    await expectCountersMatch(r2, r2.marks.wave1);
  });

  it("degrades on an API without trials.list, runs.contenders or alert ack", async () => {
    const { rec, fake } = setup(1, { missing: ["trials.list", "runs.contenders", "alerts.ack"] });
    await waitFor(() => expect(stageNow()).toBe("Intake"));
    fake.release(rec.marks.wave2);
    // Trials still count, in a row that says they aren't placed yet.
    await waitFor(() => expect(tiles()).toHaveLength(60));
    expect(screen.getByText("not placed yet")).toBeTruthy();
    await expectCountersMatch(rec, rec.marks.wave2);
    // The ack fails honestly and the alert comes back.
    await waitFor(() => expect(alertBanner()).not.toBeNull());
    fireEvent.click(within(alertBanner()!).getByText("Acknowledge"));
    await waitFor(() => expect(screen.getByText(/Couldn't acknowledge the alert/)).toBeTruthy());
    expect(alertBanner()).not.toBeNull();
    expect(UNPLACED).toBe("unplaced");
  });

  it("renders runner- and agent-provided text escaped: no HTML, no runner URLs", async () => {
    const { rec, fake, container } = setup(1);
    await waitFor(() => expect(stageNow()).toBe("Intake"));
    fake.release(rec.marks.wave1);
    await waitFor(() => expect(tileWord(0)).toBe("passed gate"));
    fireEvent.click(tile(0)!);
    const drawer = await screen.findByRole("dialog", { name: trialName(0) });
    // The log tail is polled through the same client and shown as text.
    await waitFor(() =>
      expect(within(drawer).getByText(/building/).textContent).toContain(EVIL_HTML),
    );
    expect(fake.requests.some((r) => r.path.startsWith(`/trials/${TRIALS[0]!.id}/log`))).toBe(true);
    expect(container.ownerDocument.querySelector("img")).toBeNull();
    expect(container.ownerDocument.querySelector("main script, [role=dialog] script")).toBeNull();
    for (const a of container.ownerDocument.querySelectorAll("a"))
      expect(a.getAttribute("href") ?? "").not.toMatch(/evil/);
    expect(document.body.innerHTML).not.toContain(EVIL_URL);
    expect(document.body.innerHTML).not.toContain("runner.evil.example");
    expect(document.body.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(document.body.textContent).toContain('<script>alert("x")</script>');
  });

  it("keeps polling the log of a live trial past eof, until the trial is final", async () => {
    const { rec, fake } = setup(1);
    await waitFor(() => expect(stageNow()).toBe("Intake"));
    fake.release(phaseSeq(rec, 0, "running"));
    await waitFor(() => expect(tileWord(0)).toBe("running (running)"));
    fireEvent.click(tile(0)!);
    const logCalls = () =>
      fake.requests.filter((r) => r.path.startsWith(`/trials/${TRIALS[0]!.id}/log`)).length;
    await waitFor(() => expect(logCalls()).toBe(1));
    // The fake says eof only once the trial is final; the first answer was not eof, so it polls.
    await waitFor(() => expect(logCalls()).toBeGreaterThanOrEqual(2), { timeout: 8000 });
  }, 30_000);

  it("shows a fatal API error honestly and stops", async () => {
    const client = createWebApiClient("https://api.test", {
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: "not_found", message: "no run" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    });
    render(<LiveRunPage runId={RUN_ID} client={client} options={OPTIONS} />);
    await waitFor(() => expect(screen.getByText("Couldn’t open this run")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("doesn't exist");
  });
});

// --- the reducer -----------------------------------------------------------------------------

describe("live model additions (TDM-75)", () => {
  const rec = recordRun();
  const parsed = rec.events.map((e) => ({
    ...e,
    cost_delta_micro_usd: BigInt(String(e.cost_delta_micro_usd ?? "0")),
  })) as unknown as Parameters<typeof applyEvents>[1];
  const snap = (lastSeq: number) =>
    initLive({
      run: {
        id: RUN_ID as never,
        question: "q",
        state: "running",
        budget_micro_usd: 120_000_000n,
        spent_micro_usd: fold(rec, lastSeq).spent,
        estimate_micro_usd: null,
        created_at: new Date(0).toISOString(),
      },
      contenders: [],
      trials: [],
      agents: [],
      alerts: [],
      lastSeq,
    });

  it("history adds feed, stages and unplaced trials but never spend", () => {
    const m0 = snap(rec.marks.wave1);
    const h = seedHistory(m0, parsed.slice(0, rec.marks.wave1));
    expect(h.spentMicroUsd).toBe(m0.spentMicroUsd);
    expect(h.feed.length).toBeGreaterThan(100);
    expect(h.stateHistory.map((s) => s.state)).toContain("understand");
    expect(countTrials(h).total).toBe(60);
    // Replaying history again is a no-op.
    expect(seedHistory(h, parsed.slice(0, rec.marks.wave1)).feed.length).toBe(h.feed.length);
  });

  it("stream trials the snapshot didn't have are counted; alert ids come from source_id", () => {
    const live = applyEvents(snap(0), parsed.slice(0, rec.marks.alert));
    expect(countTrials(live).total).toBe(60);
    expect(live.needsTrialRefresh).toBe(true);
    expect(live.alerts[0]?.id).toBe(ALERT_ID);
    expect(live.feed.some((f) => f.text.includes("our failure, not billed"))).toBe(true);
  });

  it("re-reading sessions updates status but keeps the stream's last tool", () => {
    const live = applyEvents(snap(0), parsed.slice(0, rec.marks.understand + 1));
    const merged = mergeAgents(live, [
      {
        id: AGENTS.understander as never,
        run_id: RUN_ID as never,
        role: "understander",
        status: "done",
        budget_micro_usd: 5_000_000n,
        cost_micro_usd: 0n,
        last_tool: null,
        stop_reason: null,
        pending_action: null,
        started_at: null,
        ended_at: new Date(0).toISOString(),
      },
    ]);
    const a = merged.agents[AGENTS.understander]!;
    expect(a.status).toBe("done");
    expect(a.lastTool).toBe("Read");
    expect(a.costMicroUsd).toBe(400_000n);
  });
});
