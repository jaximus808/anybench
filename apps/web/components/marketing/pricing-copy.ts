// TDM-226: what /pricing says, from GET /billing/pricing (the server's billing config through
// packages/billing) and GET /billing/free-pool. Pure, so the rates and both pool states test
// without a DOM. No number is typed here: every amount, percentage, limit and block length comes
// from the API answer, and the copy only words it.
import {
  formatUsd,
  type PricingExample,
  type PublicFreePool,
  type PublicPricing,
} from "@anybench/core";
import { bpsPercent } from "../live/estimate-copy";

const MICRO_PER_USD = 1_000_000n;
const MICRO_PER_CENT = 10_000n;

/**
 * Dollars for the page: "$2" when whole, "$3.32" for a dollar or more, and every digit that is
 * there under a dollar ("$0.0276" for a block of computer time). Bigint only.
 */
export function money(amount: bigint): string {
  if (amount % MICRO_PER_USD === 0n) return formatUsd(amount, { decimals: 0 });
  if (amount >= MICRO_PER_USD || amount % MICRO_PER_CENT === 0n) return formatUsd(amount);
  let decimals = 6;
  let rest = amount;
  while (decimals > 2 && rest % 10n === 0n) {
    rest /= 10n;
    decimals -= 1;
  }
  return formatUsd(amount, { decimals });
}

/** "10 min", "1 h", "90 s". */
export function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface PoolCopy {
  state: PublicFreePool["state"] | "unknown";
  /** "Free runs are open" / "Free runs are paused right now". */
  line: string;
  detail: string;
}

/** The live status line from GET /billing/free-pool; null when it could not be read. */
export function poolCopy(pool: PublicFreePool | null): PoolCopy {
  if (pool?.state === "open") {
    return {
      state: "open",
      line: "Free runs are open",
      detail: "Sign up, add your model key and start your first benchmark. No card.",
    };
  }
  if (pool?.state === "paused") {
    return {
      state: "paused",
      line: "Free runs are paused right now",
      detail:
        "The pool that pays for free runs is used up for now. Runs are billed at the normal prices below until it reopens.",
    };
  }
  return {
    state: "unknown",
    line: "Free run status unavailable",
    detail:
      "We couldn't check whether free runs are open. Your run's page says before you press Go.",
  };
}

export interface RateRow {
  key: "run_fee" | "compute" | "own_tokens" | "managed_tokens";
  term: string;
  /** The rate itself: "$2 per run", "at cost + 50%". */
  rate: string;
  detail: string;
}

export interface ExampleLine {
  key: "run_fee" | "compute" | "total";
  label: string;
  detail: string;
  amount: string;
}

export interface ExampleCopy {
  id: PricingExample["id"];
  title: string;
  summary: string;
  /** "Free" or the total. */
  headline: string;
  /** Under the headline: "normally $3.32, before model tokens" / "before model tokens". */
  sub: string;
  lines: ExampleLine[];
  tokens: string;
}

export interface PricingCopy {
  free: {
    offered: boolean;
    title: string;
    includes: string[];
  };
  rates: RateRow[];
  examples: ExampleCopy[];
}

function exampleCopy(e: PricingExample, p: PublicPricing): ExampleCopy {
  const c = e.compute;
  const lines: ExampleLine[] = [
    {
      key: "run_fee",
      label: "Run fee",
      detail: e.kit_origin === "uploaded" ? "your own kit" : "kit design, proof and analysis",
      amount: money(e.run_fee_micro_usd),
    },
    {
      key: "compute",
      label: "Computer time",
      detail: `${plural(c.trials, "trial")} (warm-ups included) on ${plural(c.computers, "computer")}, ${plural(c.blocks, "block")} of ${duration(c.block_seconds)}, each trial priced at ${duration(c.est_trial_seconds)}`,
      amount: money(c.charge_micro_usd),
    },
    {
      key: "total",
      label: e.free ? "Normally" : "Total",
      detail: "before model tokens",
      amount: money(e.total_micro_usd),
    },
  ];
  const tokens =
    e.tokens === "own_key"
      ? "Model tokens run on your own key: your provider bills them, not Anybench."
      : `Model tokens run on Anybench's key: billed as used at cost + ${bpsPercent(p.rates.managed_token_markup_bps)}, on top of this. A card is required.`;
  return {
    id: e.id,
    title: e.title,
    summary: e.summary,
    headline: e.free ? "Free" : money(e.total_micro_usd),
    sub: e.free
      ? `with your free run; normally ${money(e.total_micro_usd)} before model tokens`
      : "before model tokens",
    lines,
    tokens,
  };
}

export function pricingCopy(p: PublicPricing): PricingCopy {
  const r = p.rates;
  const f = p.free_run;
  const block = duration(r.block_seconds);
  const uploaded =
    r.uploaded_kit_run_fee_micro_usd === r.run_fee_micro_usd
      ? ""
      : ` A run from a kit you built and uploaded yourself is ${r.uploaded_kit_run_fee_micro_usd === 0n ? "free of the run fee" : `${money(r.uploaded_kit_run_fee_micro_usd)}`}.`;
  return {
    free: {
      offered: f.offered,
      title: "Your first benchmark is free",
      includes: [
        `Up to ${plural(f.max_setups, "setup")} compared, ${plural(f.max_trials, "trial")} in all, warm-ups included.`,
        `Up to ${money(f.compute_cap_micro_usd)} of computer time, paid by us.`,
        "Your own Anthropic or OpenAI key for the model tokens. Your provider bills them.",
        `No card. One per account, for GitHub accounts older than ${f.min_github_age_days} days.`,
        "The same correctness gate and statistics as any run. A small run may honestly say “not significant”.",
      ],
    },
    rates: [
      {
        key: "run_fee",
        term: "Run fee",
        rate: `${money(r.run_fee_micro_usd)} per run`,
        detail: `Charged when a run is delivered or fails because of the software under test. It pays for our agents: understanding your project, finding rivals, designing and proving the kit, analysing the results.${uploaded}`,
      },
      {
        key: "compute",
        term: "Computer time",
        rate: `at cost + ${bpsPercent(r.compute_markup_bps)}`,
        detail: `Only while your trials run, in ${block} blocks. A ${r.machine.vcpu} vCPU / ${r.machine.memory_gb} GB computer costs us ${money(r.machine.block_cost_micro_usd)} a block; you pay ${money(r.machine.block_charge_micro_usd)}.`,
      },
      {
        key: "own_tokens",
        term: "Model tokens, your key",
        rate: "free",
        detail:
          "The agent under test runs on your own Anthropic or OpenAI key, and your provider bills you at their price. Anybench charges nothing for those tokens.",
      },
      {
        key: "managed_tokens",
        term: "Model tokens, ours",
        rate: `at cost + ${bpsPercent(r.managed_token_markup_bps)}`,
        detail:
          "If you run on Anybench's tokens instead, they are billed as used. A card is required.",
      },
    ],
    examples: p.examples.map((e) => exampleCopy(e, p)),
  };
}

/** The billing rules that hold on every run (TDM-242 budgets, TDM-171 failures). */
export const PRICING_RULES: readonly { term: string; desc: string }[] = [
  {
    term: "Budgets are a hard cap",
    desc: "Your budget is the most Anybench will charge for a run: the run fee, computer time and any model tokens we provide. A trial starts only if its worst case still fits; when the next one can't, the run pauses and asks you.",
  },
  {
    term: "Our failures are never billed",
    desc: "A trial that fails because of our infrastructure is retried automatically, and neither it nor its retries are billed. A run that fails because of our pipeline bills nothing at all.",
  },
  {
    term: "Cancelling",
    desc: "If you cancel mid-run, you pay for the computer time used, and no run fee.",
  },
  {
    term: "Estimate before Go",
    desc: "Every run shows its price line by line before it starts. Each trial is priced at its time cap unless the kit says how long it takes, so a run usually costs less than its estimate.",
  },
  {
    term: "Billing",
    desc: "By usage, through Stripe, to the card on file. Free runs never reach your card.",
  },
];
