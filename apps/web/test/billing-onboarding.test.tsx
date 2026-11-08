// stripe-onboarding: the add-a-card step (/billing), the live page's Go bar with the 402 → add-card
// link, and the New run screen's card notice, against a mocked API (fake fetch, same-origin /api).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingView } from "../app/billing/BillingView";
import { CardNotice } from "../app/runs/new/CardNotice";
import { GoBar, goCardHref } from "../components/live/GoBar";
import { resetSessionForTests } from "../lib/session";

const nav = { push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const API = "/api";
const NOW = "2026-11-07T12:00:00.000Z";
const RUN = "0190f0a0-0000-7000-8000-0000000000f1";
const USER = {
  id: "0190f0a0-0000-7000-8000-000000000001",
  github_login: "octocat",
  email: "octo@example.com",
  avatar_url: null,
  is_admin: false,
  created_at: NOW,
};

const runBody = (state: string) => ({
  run: {
    id: RUN,
    project_id: null,
    question: "Is it faster?",
    state,
    budget_micro_usd: "5000000",
    spent_micro_usd: "0",
    estimate_micro_usd: "2000000",
    kit_id: null,
    paused_reason: null,
    cancel_requested_at: null,
    comped: false,
    created_at: NOW,
    updated_at: NOW,
  },
});

function summary(card: boolean, status = card ? "ok" : "none") {
  return {
    account: {
      payment_status: status,
      has_payment_method: card,
      unbilled_micro_usd: "2500000",
      granted_remaining_micro_usd: "0",
      spend_limit_micro_usd: "100000000",
      daily_cap_micro_usd: null,
      invoice_threshold_micro_usd: "50000000",
    },
    period: { start: NOW, end: NOW, usage_micro_usd: "2500000" },
    grants: [],
    invoices: [],
    mode: "test",
  };
}

type Handler = (body: unknown) => { status: number; body?: unknown };
let routes: Record<string, Handler>;
let calls: { key: string; body: unknown }[];
const json = (status: number, body?: unknown) => ({ status, body });

function mockApi(overrides: Record<string, Handler>) {
  routes = {
    "GET /auth/me": () => json(200, { user: USER, via: { kind: "session" } }),
    ...overrides,
  };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url.slice(API.length), "http://web.test");
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ key, body });
    const h = routes[key];
    if (!h) return new Response("not found", { status: 404 });
    const r = h(body);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });
}

let assigned: string | null;
const navigate = (u: string) => {
  assigned = u;
};
beforeEach(() => {
  calls = [];
  assigned = null;
  nav.push.mockReset();
  resetSessionForTests();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

describe("/billing (stripe-onboarding)", () => {
  it("after sign-up: one step left, Add a card opens Stripe Checkout returning to this run", async () => {
    window.history.pushState({}, "", `/billing?welcome=1&run=${RUN}`);
    mockApi({
      "GET /billing/summary": () => json(200, summary(false)),
      "POST /billing/link-card": () =>
        json(200, { url: "https://checkout.stripe.com/c/pay/cs_test_1" }),
    });
    render(<BillingView navigate={navigate} />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "One step left: add a card" }),
    ).toBeTruthy();
    expect(screen.getByText(/Test mode: no real money moves/)).toBeTruthy();
    expect(screen.getByText(/If our pipeline or infrastructure fails the run, you pay nothing/));
    expect(screen.getByText("Add a card above, then start it from here.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a card" }));
    await waitFor(() => expect(assigned).toBe("https://checkout.stripe.com/c/pay/cs_test_1"));
    expect(calls.find((c) => c.key === "POST /billing/link-card")?.body).toEqual({
      success_path: `/billing?linked=1&run=${RUN}`,
      cancel_path: `/billing?run=${RUN}`,
    });
  });

  it("back from Checkout: waits for the card, then Start your run presses Go and opens the run", async () => {
    window.history.pushState({}, "", `/billing?linked=1&run=${RUN}`);
    let polls = 0;
    mockApi({
      "GET /billing/summary": () => json(200, summary(++polls >= 2)),
      [`POST /runs/${RUN}/go`]: () => json(200, runBody("running")),
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<BillingView navigate={navigate} />);
      expect(await screen.findByText("Confirming your card with Stripe…")).toBeTruthy();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(await screen.findByText("Card on file. You can start runs.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
    fireEvent.click(screen.getByRole("button", { name: "Start your run" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/runs/${RUN}`));
  });

  it("a past-due account is sent to the portal to update the card", async () => {
    mockApi({
      "GET /billing/summary": () => json(200, summary(true, "past_due")),
      "POST /billing/portal": () => json(200, { url: "https://billing.stripe.com/p/session/x" }),
    });
    render(<BillingView navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Update card" }));
    await waitFor(() => expect(assigned).toBe("https://billing.stripe.com/p/session/x"));
  });

  it("signed out: asks to sign in", async () => {
    mockApi({
      "GET /auth/me": () => json(401, { error: { code: "unauthorized", message: "sign in" } }),
    });
    render(<BillingView navigate={navigate} />);
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toBe(
      "/signin?redirect_to=%2Fbilling",
    );
  });
});

describe("Go bar (stripe-onboarding)", () => {
  it("a 402 from Go shows the add-card link from the gate", async () => {
    const link = `https://anybench.jaxonp.com/settings/billing?run=${RUN}`;
    mockApi({
      [`POST /runs/${RUN}/go`]: () =>
        json(402, { reason: "no_payment_method", link_card_url: link }),
    });
    render(<GoBar runId={RUN} estimate={2_000_000n} />);
    expect(screen.getByText(/Estimated cost \$2\.00/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    const a = await screen.findByRole("link", { name: "Add a card" });
    expect(a.getAttribute("href")).toBe(link);
    expect(screen.getByText(/Add a card to start this run/)).toBeTruthy();
  });

  it("a card on file (or an admin comp): Go starts the run", async () => {
    mockApi({ [`POST /runs/${RUN}/go`]: () => json(200, runBody("running")) });
    render(<GoBar runId={RUN} estimate={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText("Starting the run…")).toBeTruthy();
  });

  it("Go, and don't ask again: presses Go, turns on auto_start_runs, and can undo it", async () => {
    mockApi({
      [`POST /runs/${RUN}/go`]: () => json(200, runBody("running")),
      "PATCH /auth/me/settings": (body) => json(200, body),
    });
    render(<GoBar runId={RUN} estimate={null} />);
    fireEvent.click(screen.getByRole("link", { name: "Go, and don’t ask again" }));
    expect(await screen.findByText("Starting the run…")).toBeTruthy();
    expect(await screen.findByText(/Future runs start automatically/)).toBeTruthy();
    expect(calls.map((c) => c.key)).toContain(`POST /runs/${RUN}/go`);
    expect(calls.find((c) => c.key === "PATCH /auth/me/settings")?.body).toEqual({
      auto_start_runs: true,
    });
    fireEvent.click(screen.getByRole("link", { name: "undo" }));
    expect(await screen.findByText("Future runs wait for Go")).toBeTruthy();
    expect(calls.filter((c) => c.key === "PATCH /auth/me/settings").at(-1)?.body).toEqual({
      auto_start_runs: false,
    });
  });

  it("only follows an https link; anything else goes to our billing page", () => {
    expect(goCardHref("http://evil.test/", RUN)).toBe(`/billing?run=${RUN}`);
    expect(goCardHref("javascript:alert(1)", RUN)).toBe(`/billing?run=${RUN}`);
    expect(goCardHref("https://anybench.jaxonp.com/settings/billing", RUN)).toBe(
      "https://anybench.jaxonp.com/settings/billing",
    );
  });
});

describe("New run card notice (stripe-onboarding)", () => {
  it("shows for a signed-in user without a card, and not once a card is on file", async () => {
    mockApi({ "GET /billing/summary": () => json(200, summary(false)) });
    const { unmount } = render(<CardNotice />);
    expect((await screen.findByRole("link", { name: "Add a card" })).getAttribute("href")).toBe(
      "/billing",
    );
    unmount();
    cleanup();
    resetSessionForTests();
    mockApi({ "GET /billing/summary": () => json(200, summary(true)) });
    render(<CardNotice />);
    await waitFor(() => expect(calls.some((c) => c.key === "GET /billing/summary")).toBe(true));
    expect(screen.queryByRole("link", { name: "Add a card" })).toBeNull();
  });
});
