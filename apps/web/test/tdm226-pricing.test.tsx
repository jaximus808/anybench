// TDM-226 [20.4]: /pricing renders every number from GET /billing/pricing and the live line from
// GET /billing/free-pool. The fixture is the API's answer at the server's default billing config
// (apps/server test pricing-public-tdm226 asserts publicPricingFor(defaults) equals it), so these
// assertions tie the page's rates to the billing config values.
import { cleanup, render, screen, within } from "@testing-library/react";
import { PublicPricingSchema, type PublicPricing } from "@anybench/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import PricingRoute from "../app/(marketing)/pricing/page";
import DocsOverviewPage from "../app/docs/page";
import { PricingPage } from "../components/marketing/PricingPage";
import { money, poolCopy, pricingCopy } from "../components/marketing/pricing-copy";
import { NAV_LINKS } from "../components/site/nav";
import { fetchFreePool, fetchPublicPricing } from "../lib/pricing/fetch";
import wire from "./fixtures/public-pricing-defaults.json";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DEFAULTS: PublicPricing = PublicPricingSchema.parse(wire);

function rate(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-rate="${key}"]`);
  if (!el) throw new Error(`no rate ${key}`);
  return el;
}

function example(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-example="${id}"]`);
  if (!el) throw new Error(`no example ${id}`);
  return el;
}

function line(ex: HTMLElement, key: string): string {
  return ex.querySelector(`[data-line="${key}"] dd`)?.textContent ?? "";
}

describe("pricing copy (TDM-226)", () => {
  it("words money from micro-USD without a float: whole dollars, cents, sub-cent blocks", () => {
    expect(money(2_000_000n)).toBe("$2");
    expect(money(3_324_800n)).toBe("$3.32");
    expect(money(22_865_600n)).toBe("$22.87");
    expect(money(27_600n)).toBe("$0.0276");
    expect(money(41_400n)).toBe("$0.0414");
    expect(money(500_000n)).toBe("$0.50");
  });

  it("says both pool states, and admits when it could not check", () => {
    expect(poolCopy({ state: "open" }).line).toBe("Free runs are open");
    expect(poolCopy({ state: "paused" }).line).toBe("Free runs are paused right now");
    expect(poolCopy(null).state).toBe("unknown");
  });
});

describe("/pricing at the default billing config (TDM-226)", () => {
  it("shows the config's rates: run fee, compute markup and block, token markup", () => {
    render(<PricingPage pricing={DEFAULTS} pool={{ state: "open" }} />);
    // RUN_FEE_MICRO_USD 2_000_000, COMPUTE_MARKUP_BPS 5000, MANAGED_TOKEN_MARKUP_BPS 2000,
    // a 600 s Naïve block of 2 vCPU / 4 GiB at 27_600 cost and 41_400 billed.
    expect(rate("run_fee").textContent).toContain("$2 per run");
    expect(rate("run_fee").textContent).toContain("free of the run fee");
    expect(rate("compute").textContent).toContain("at cost + 50%");
    expect(rate("compute").textContent).toContain("in 10 min blocks");
    expect(rate("compute").textContent).toContain("costs us $0.0276 a block; you pay $0.0414");
    expect(rate("own_tokens").textContent).toContain("free");
    expect(rate("managed_tokens").textContent).toContain("at cost + 20%");
    expect(rate("managed_tokens").textContent).toContain("A card is required.");
  });

  it("says what the free run includes, from the starter limits", () => {
    render(<PricingPage pricing={DEFAULTS} pool={{ state: "open" }} />);
    const list = screen.getByRole("list", { name: "What a free run includes" });
    const text = list.textContent ?? "";
    expect(text).toContain("Up to 2 setups compared, 24 trials in all");
    expect(text).toContain("Up to $10 of computer time, paid by us.");
    expect(text).toContain("Your own Anthropic or OpenAI key");
    expect(text).toContain("No card.");
    expect(text).toContain("older than 90 days");
  });

  it("prices both worked examples from the API's estimate", () => {
    render(<PricingPage pricing={DEFAULTS} pool={{ state: "open" }} />);
    const starter = example("starter");
    expect(within(starter).getByText("Free")).toBeTruthy();
    expect(starter.textContent).toContain("normally $3.32 before model tokens");
    expect(line(starter, "run_fee")).toBe("$2");
    expect(line(starter, "compute")).toBe("$1.32");
    expect(line(starter, "total")).toBe("$3.32");
    expect(starter.textContent).toContain(
      "16 trials (warm-ups included) on 16 computers, 32 blocks of 10 min",
    );
    expect(starter.textContent).toContain("your provider bills them");

    const h2h = example("head_to_head");
    expect(h2h.querySelector("p span")?.textContent).toBe("$22.87");
    expect(line(h2h, "compute")).toBe("$20.87");
    expect(line(h2h, "total")).toBe("$22.87");
    expect(h2h.textContent).toContain("each trial priced at 1 h");
    expect(h2h.textContent).toContain("billed as used at cost + 20%");
  });

  it("renders every amount from the data: other config values show other numbers", () => {
    const other: PublicPricing = {
      ...DEFAULTS,
      rates: {
        ...DEFAULTS.rates,
        run_fee_micro_usd: 3_500_000n,
        uploaded_kit_run_fee_micro_usd: 3_500_000n,
        compute_markup_bps: 2500,
        managed_token_markup_bps: 1250,
        machine: { ...DEFAULTS.rates.machine, block_charge_micro_usd: 34_500n },
      },
      free_run: { ...DEFAULTS.free_run, max_trials: 12, compute_cap_micro_usd: 4_000_000n },
    };
    const copy = pricingCopy(other);
    expect(copy.rates.find((r) => r.key === "run_fee")?.rate).toBe("$3.50 per run");
    expect(copy.rates.find((r) => r.key === "compute")?.rate).toBe("at cost + 25%");
    expect(copy.rates.find((r) => r.key === "managed_tokens")?.rate).toBe("at cost + 12.5%");
    expect(copy.free.includes.join(" ")).toContain("12 trials in all");
    expect(copy.free.includes.join(" ")).toContain("Up to $4 of computer time");
    expect(copy.rates.find((r) => r.key === "run_fee")?.detail).not.toContain("uploaded");
  });

  it("shows the live line for both pool states", () => {
    const { unmount } = render(<PricingPage pricing={DEFAULTS} pool={{ state: "open" }} />);
    let status = screen.getByRole("status");
    expect(status.getAttribute("data-state")).toBe("open");
    expect(status.textContent).toContain("Free runs are open");
    unmount();
    render(<PricingPage pricing={DEFAULTS} pool={{ state: "paused" }} />);
    status = screen.getByRole("status");
    expect(status.getAttribute("data-state")).toBe("paused");
    expect(status.textContent).toContain("Free runs are paused right now");
    expect(status.textContent).toContain("billed at the normal prices below");
    // The rates are still there when free runs are paused.
    expect(rate("run_fee").textContent).toContain("$2 per run");
  });

  it("never falls back to typed numbers when the API can't be read", () => {
    const { container } = render(<PricingPage pricing={null} pool={null} />);
    expect(screen.getByRole("heading", { name: /Prices are unavailable/ })).toBeTruthy();
    expect(container.textContent).not.toMatch(/\$\d|\d+%/);
    expect(screen.getByRole("status").textContent).toContain("Free run status unavailable");
  });

  it("states the rules: budgets as a hard cap, our failures and retries never billed", () => {
    render(<PricingPage pricing={DEFAULTS} pool={{ state: "open" }} />);
    const rules = screen.getByRole("region", { name: /The rules/ });
    expect(rules.textContent).toContain("Budgets are a hard cap");
    expect(rules.textContent).toContain(
      "Your budget is the most Anybench will charge for a run: the run fee, computer time and any model tokens we provide.",
    );
    expect(rules.textContent).toContain("neither it nor its retries are billed");
    expect(
      within(rules).getByRole("link", { name: "refunds and billing" }).getAttribute("href"),
    ).toBe("/refunds");
  });
});

describe("the /pricing route and its links (TDM-226)", () => {
  it("reads GET /billing/pricing and GET /billing/free-pool, no credentials", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      const body = String(url).endsWith("/billing/free-pool") ? { state: "paused" } : wire;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    render(await PricingRoute());
    expect(calls.sort()).toEqual([
      "https://anybench-api-sj1arspaf10q.vercel.app/billing/free-pool",
      "https://anybench-api-sj1arspaf10q.vercel.app/billing/pricing",
    ]);
    expect(screen.getByRole("status").textContent).toContain("Free runs are paused right now");
    expect(rate("run_fee").textContent).toContain("$2 per run");
  });

  it("gives null on an API error or an unreadable answer", async () => {
    const down = (async () => new Response("no", { status: 503 })) as typeof fetch;
    expect(await fetchPublicPricing({ fetcher: down, base: "http://api" })).toBeNull();
    const odd = (async () => new Response(JSON.stringify({ state: "maybe" }))) as typeof fetch;
    expect(await fetchFreePool({ fetcher: odd, base: "http://api" })).toBeNull();
    const thrown = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await fetchFreePool({ fetcher: thrown, base: "http://api" })).toBeNull();
  });

  it("is linked from the header and the docs index", () => {
    expect(NAV_LINKS.find((l) => l.label === "Pricing")?.href).toBe("/pricing");
    render(<DocsOverviewPage />);
    const section = screen.getByRole("region", { name: "What it costs" });
    expect(within(section).getByRole("link", { name: "Pricing" }).getAttribute("href")).toBe(
      "/pricing",
    );
  });
});
