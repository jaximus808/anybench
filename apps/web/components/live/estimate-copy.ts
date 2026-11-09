// TDM-225: what the Go screen says about the price, from GET /runs/:id/estimate. Pure, so the
// three states test without a DOM:
//   free    the account's free starter run covers this run: "Free", plus what the same run would
//           normally cost, line by line (run fee, computer time at the billed price).
//   paid    past a starter limit (which one, in numbers from the API), the free run already used
//           or in use, or free runs paused (said honestly): the normal price, and whether Go will
//           ask for a card.
// Model tokens on the user's own key are never part of our price: their provider bills them, and
// we show the bound we have (each trial at its spend cap) next to the price, never inside it.
// The starter limits come from the API (estimate.free_run.limits), never from this file.
// TDM-244: model tokens on Anybench's key are a real charge, billed as used at our cost + markup:
// a "Model tokens (ours): at cost + 20%" line (the markup from the API), and when Go needs a card
// for them, the server's own sentence (card_message).
import type { RunEstimate } from "@anybench/core";
import { usd } from "./format";

export interface EstimateLine {
  key: "run_fee" | "compute" | "total" | "managed_tokens";
  label: string;
  detail: string | null;
  amount: string;
}

export interface EstimateCopy {
  price: RunEstimate["price"];
  /** "Free" or "$17.20". */
  headline: string;
  /** One sentence: why it is free, or why not. */
  summary: string;
  /** Over the lines: "What the same run would normally cost" or "What this run costs". */
  linesTitle: string;
  lines: EstimateLine[];
  /** Model tokens on the user's own key: billed by their provider. Null when none. */
  tokens: string | null;
  /** Contenders on Anybench's tokens: billed as used at cost + markup, not in this total. */
  managed: string | null;
  /** "A card is needed to start it." (or the server's reason) when Go will ask for one. */
  card: string | null;
}

const PROVIDER: Record<RunEstimate["tokens"]["byok_providers"][number], string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Basis points as a percentage: 2000 -> "20%", 1250 -> "12.5%" (no float arithmetic). */
export function bpsPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = bps % 100;
  if (rest === 0) return `${whole}%`;
  return `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}%`;
}

function blockLength(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

/** The starter limits this run passes, in numbers ("40 trials; a free run has at most 24"). */
export function passedLimits(e: RunEstimate): string[] {
  const free = e.free_run;
  if (!free?.refusal) return [];
  const out: string[] = [];
  for (const r of free.refusal.reasons) {
    if (r.code === "too_many_setups")
      out.push(`${free.setups} setups; a free run compares at most ${free.limits.max_setups}`);
    else if (r.code === "too_many_trials")
      out.push(
        `${e.normal.compute.trials} trials; a free run has at most ${free.limits.max_trials}`,
      );
    else if (r.code === "over_compute_cap")
      out.push(
        `more computer time than the ${usd(free.limits.compute_cap_micro_usd, 0)} a free run covers`,
      );
  }
  return out;
}

const LIMIT_CODES = new Set(["too_many_setups", "too_many_trials", "over_compute_cap"]);

function paidSummary(e: RunEstimate): string {
  const free = e.free_run;
  if (!free) return "Estimated before model tokens.";
  const normal = "so this run is billed at the normal price";
  switch (free.status) {
    case "paused":
      return `Free runs are paused right now (the pool that pays for them is used up), ${normal}.`;
    case "used":
      return `You've used your free run, ${normal}.`;
    case "in_use":
      return `Your free run is in use on another run, ${normal}.`;
    case "not_eligible":
      return `This account has no free run, ${normal}.`;
    case "available": {
      const limits = passedLimits(e);
      if (limits.length > 0) return `Past the free run's limits (${limits.join("; ")}), ${normal}.`;
      // Not a size limit: the model key or token source. The server's sentence says what to do.
      const other = free.refusal?.reasons.find((r) => !LIMIT_CODES.has(r.code));
      return other ? `Not free yet: ${other.message}` : `Not free, ${normal}.`;
    }
  }
}

export function estimateCopy(e: RunEstimate): EstimateCopy {
  const free = e.price === "free";
  const c = e.normal.compute;
  const lines: EstimateLine[] = [
    {
      key: "run_fee",
      label: "Run fee",
      detail:
        e.kit_origin === "uploaded" ? "your own kit: no kit design" : "kit design and analysis",
      amount: usd(e.normal.run_fee_micro_usd),
    },
    {
      key: "compute",
      label: "Computer time",
      detail: `${plural(c.computers, "computer")} · ${plural(c.blocks, "block")} of ${blockLength(c.block_seconds)} · ${plural(c.trials, "trial")}`,
      amount: usd(c.charge_micro_usd),
    },
    {
      key: "total",
      label: free ? "Normally" : "Total",
      detail: "before model tokens",
      amount: usd(e.normal.total_micro_usd),
    },
  ];
  const ours = e.normal.managed_tokens;
  if (ours) {
    lines.push({
      key: "managed_tokens",
      label: "Model tokens (ours)",
      detail: `${ours.contenders.join(", ")}: billed as used`,
      amount: `at cost + ${bpsPercent(ours.markup_bps)}`,
    });
  }

  const providers = e.tokens.byok_providers.map((p) => PROVIDER[p]);
  const ceiling = e.tokens.byok_ceiling_micro_usd;
  const tokens =
    providers.length > 0
      ? `Model tokens run on your own ${providers.join(" and ")} key: billed by your provider, not by Anybench${
          ceiling !== null
            ? `. At most ${usd(ceiling)} for this run (every trial at its spend cap)`
            : ""
        }.`
      : null;
  const markup = ours ? ` at cost + ${bpsPercent(ours.markup_bps)}` : "";
  const managed =
    e.tokens.managed_contenders.length > 0
      ? `${e.tokens.managed_contenders.join(", ")} ${e.tokens.managed_contenders.length === 1 ? "runs" : "run"} on Anybench's model tokens: billed as used${markup}, on top of this estimate.`
      : null;

  return {
    price: e.price,
    headline: free ? "Free" : usd(e.total_micro_usd),
    summary: free ? "Your free run covers this run: no card needed." : paidSummary(e),
    linesTitle: free ? "What the same run would normally cost" : "What this run costs",
    lines,
    tokens,
    managed,
    card: e.card_needed ? (e.card_message ?? "A card is needed to start it.") : null,
  };
}
