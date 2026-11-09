// TDM-224 [20.2]: no card for the free run. Sign-up lands on onboarding (/welcome), which asks for a
// model key (stored write-only through PUT /secrets), shows the free run, offers the card as
// optional, and goes on to /runs/new without a card. The New run notice and the Go bar say the
// free-run words. Against a mocked API (fake fetch, same-origin /api).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingView } from "../app/billing/BillingView";
import { CardNotice } from "../app/runs/new/CardNotice";
import SignUpPage from "../app/signup/page";
import { WelcomeView } from "../app/welcome/WelcomeView";
import { GoBar } from "../components/live/GoBar";
import { POST_SIGN_UP_PATH } from "../lib/api";
import { resetSessionForTests } from "../lib/session";

const nav = { push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const API = "/api";
const NOW = "2026-11-09T12:00:00.000Z";
const RUN = "0190f0a0-0000-7000-8000-0000000002f4";
const USER = {
  id: "0190f0a0-0000-7000-8000-000000000224",
  github_login: "octocat",
  email: "octo@example.com",
  avatar_url: null,
  is_admin: false,
  created_at: NOW,
};

type FreeStatus = "available" | "in_use" | "used" | "not_eligible" | "paused";

function freeRun(status: FreeStatus, hasKey: boolean) {
  const messages: Record<FreeStatus, string> = {
    available: hasKey
      ? "Your first benchmark is free: no card needed."
      : "Your first benchmark is free: no card needed. Add your Anthropic or OpenAI key to use it.",
    in_use: "Your free run is in progress.",
    used: "You've used your free run. Add a card to keep benchmarking.",
    not_eligible: "Free runs are for GitHub accounts older than 90 days. Add a card to continue.",
    paused: "Free runs are paused right now. Add a card to run at the normal price.",
  };
  return {
    status,
    reason:
      status === "available"
        ? null
        : status === "in_use"
          ? "in_use"
          : status === "used"
            ? "already_used"
            : status === "paused"
              ? "pool_exhausted"
              : "github_account_too_new",
    message: messages[status],
    run_id: status === "in_use" || status === "used" ? RUN : null,
    has_model_key: hasKey,
    limits: { max_setups: 2, max_trials: 24, compute_cap_micro_usd: "10000000" },
  };
}

function summary(opts: { card?: boolean; free?: FreeStatus; key?: boolean } = {}) {
  const card = opts.card ?? false;
  return {
    account: {
      payment_status: card ? "ok" : "none",
      has_payment_method: card,
      unbilled_micro_usd: "0",
      granted_remaining_micro_usd: "0",
      spend_limit_micro_usd: "100000000",
      daily_cap_micro_usd: null,
      invoice_threshold_micro_usd: "50000000",
    },
    period: { start: NOW, end: NOW, usage_micro_usd: "0" },
    grants: [],
    invoices: [],
    mode: "test",
    ...(opts.free ? { free_run: freeRun(opts.free, opts.key ?? false) } : {}),
  };
}

type Handler = (body: unknown) => { status: number; body?: unknown };
let routes: Record<string, Handler>;
let calls: { key: string; body: unknown }[];
const json = (status: number, body?: unknown) => ({ status, body });

function mockApi(overrides: Record<string, Handler>) {
  routes = {
    "GET /auth/me": () => json(200, { user: USER, via: { kind: "session" } }),
    "GET /secrets": () => json(200, { items: [] }),
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

describe("sign-up reaches /runs/new without a card (TDM-224)", () => {
  it("sign-up sends GitHub's round trip back to /welcome", () => {
    expect(POST_SIGN_UP_PATH).toBe("/welcome");
    mockApi({ "GET /auth/me": () => json(401, { error: { code: "unauthorized", message: "x" } }) });
    render(<SignUpPage />);
    expect(screen.getByRole("link", { name: "Continue with GitHub" }).getAttribute("href")).toBe(
      `${API}/auth/github?redirect_to=${encodeURIComponent("/welcome")}`,
    );
  });

  it("/welcome's next step is /runs/new with no card on file, and /runs/new asks for none", async () => {
    // Back from GitHub: onboarding. No card, the free run available.
    mockApi({ "GET /billing/summary": () => json(200, summary({ free: "available" })) });
    render(<WelcomeView navigate={navigate} />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your first benchmark is free" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Payment card (optional)" })).toBeTruthy();
    expect(screen.getByText(/You don’t need a card for your free run/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start your first run" }).getAttribute("href")).toBe(
      "/runs/new",
    );
    // Nothing on the way asked Stripe for anything.
    expect(calls.some((c) => c.key.startsWith("POST /billing"))).toBe(false);
    cleanup();
    resetSessionForTests();

    // On /runs/new: the free-run line, not "add a card before you press Go".
    mockApi({ "GET /billing/summary": () => json(200, summary({ free: "available", key: true })) });
    render(<CardNotice />);
    expect(await screen.findByText("Your first benchmark is free: no card needed.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Add a card" })).toBeNull();
  });

  it("onboarding stores the model key through PUT /secrets (write-only) and re-reads the free run", async () => {
    let hasKey = false;
    mockApi({
      "GET /billing/summary": () => json(200, summary({ free: "available", key: hasKey })),
      "PUT /secrets/anthropic": (body) => {
        hasKey = true;
        expect(body).toEqual({ value: "sk-ant-api03-test-1234" });
        return json(200, {
          secret: { provider: "anthropic", last4: "1234", created_at: NOW, last_used_at: null },
        });
      },
    });
    render(<WelcomeView navigate={navigate} />);
    expect(await screen.findByText(/Add your Anthropic or OpenAI key to use it/)).toBeTruthy();
    const input = await screen.findByLabelText("Anthropic");
    fireEvent.change(input, { target: { value: "sk-ant-api03-test-1234" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);
    expect(await screen.findByText("1234")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText("Your first benchmark is free: no card needed.")).toBeTruthy(),
    );
    expect(calls.filter((c) => c.key === "GET /billing/summary").length).toBeGreaterThanOrEqual(2);
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("Add a card stays available on onboarding and opens the existing Stripe Checkout", async () => {
    mockApi({
      "GET /billing/summary": () => json(200, summary({ free: "available" })),
      "POST /billing/link-card": () =>
        json(200, { url: "https://checkout.stripe.com/c/pay/cs_test_224" }),
    });
    render(<WelcomeView navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a card" }));
    await waitFor(() => expect(assigned).toBe("https://checkout.stripe.com/c/pay/cs_test_224"));
    expect(calls.find((c) => c.key === "POST /billing/link-card")?.body).toEqual({
      success_path: "/billing?linked=1",
      cancel_path: "/welcome",
    });
  });

  it("shows whether the free run is left: used, paused, not eligible", async () => {
    for (const [free, text] of [
      ["used", "You've used your free run. Add a card to keep benchmarking."],
      ["paused", "Free runs are paused right now. Add a card to run at the normal price."],
      [
        "not_eligible",
        "Free runs are for GitHub accounts older than 90 days. Add a card to continue.",
      ],
    ] as const) {
      mockApi({ "GET /billing/summary": () => json(200, summary({ free })) });
      render(<WelcomeView navigate={navigate} />);
      expect(await screen.findByRole("heading", { level: 1, name: "Welcome to Anybench" }));
      expect(await screen.findByText(text)).toBeTruthy();
      expect(screen.getByRole("link", { name: "Start your first run" })).toBeTruthy();
      cleanup();
      resetSessionForTests();
    }
    // Billing shows it too.
    mockApi({ "GET /billing/summary": () => json(200, summary({ free: "in_use", card: true })) });
    render(<BillingView navigate={navigate} />);
    expect(await screen.findByText("Your free run is in progress.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open your free run" }).getAttribute("href")).toBe(
      `/runs/${RUN}`,
    );
  });

  it("once the free run is used, the New run notice asks for a card again", async () => {
    mockApi({ "GET /billing/summary": () => json(200, summary({ free: "used" })) });
    render(<CardNotice />);
    expect((await screen.findByRole("link", { name: "Add a card" })).getAttribute("href")).toBe(
      "/billing",
    );
  });
});

describe("Go bar: why the run is not free (TDM-224)", () => {
  it("shows the 402's free_run message in plain words, with the add-card link", async () => {
    const link = `https://anybench.jaxonp.com/settings/billing?run=${RUN}`;
    const message =
      "A free run has at most 24 trials, and this test plan has more. Lower the repeats, or add a card to run it as is.";
    mockApi({
      [`POST /runs/${RUN}/go`]: () =>
        json(402, {
          reason: "no_payment_method",
          link_card_url: link,
          free_run: {
            reason: "too_many_trials",
            reasons: [{ code: "too_many_trials", message }],
            message,
          },
        }),
    });
    render(<GoBar runId={RUN} estimate={2_000_000n} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText(new RegExp("A free run has at most 24 trials"))).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add a card" }).getAttribute("href")).toBe(link);
  });

  it("free runs paused: says so", async () => {
    const message = "Free runs are paused right now. Add a card to run at the normal price.";
    mockApi({
      [`POST /runs/${RUN}/go`]: () =>
        json(402, {
          reason: "no_payment_method",
          link_card_url: `https://anybench.jaxonp.com/settings/billing?run=${RUN}`,
          free_run: {
            reason: "pool_exhausted",
            reasons: [{ code: "pool_exhausted", message }],
            message,
          },
        }),
    });
    render(<GoBar runId={RUN} estimate={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText(/Free runs are paused right now/)).toBeTruthy();
  });
});
