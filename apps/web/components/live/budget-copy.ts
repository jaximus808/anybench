// TDM-242: what the run page says about the budget. A user who sets "budget $20" expects that
// Anybench never charges more than $20 for this run. So the budget limits what we bill (run fee,
// computer time, model tokens we provide), a trial starts only when its worst case still fits,
// and tokens on the user's own API key are shown next to it but never counted: their provider
// bills them, not us. A free run is held to the compute we cover instead.
import type { LiveRun } from "../../lib/live/model";
import { usd } from "./format";

export interface BudgetCopy {
  /** "$3.10 spent · $1.40 held for running trials · of your $20 budget" */
  line: string;
  /** What the budget limits, in one or two sentences. */
  note: string;
  /** "$0.85 so far on your own API key (billed by your provider, not counted)", or null. */
  byok: string | null;
}

type BudgetFields = Pick<
  LiveRun,
  "spentMicroUsd" | "committedMicroUsd" | "limitMicroUsd" | "budgetBasis" | "byokTokenMicroUsd"
>;

export function budgetCopy(live: BudgetFields): BudgetCopy {
  const free = live.budgetBasis === "free_run";
  const held =
    live.committedMicroUsd > 0n ? ` · ${usd(live.committedMicroUsd)} held for running trials` : "";
  const of = free
    ? ` · of the ${usd(live.limitMicroUsd, 0)} of computer time your free run covers`
    : ` · of your ${usd(live.limitMicroUsd, 0)} budget`;
  const note = free
    ? "Free run: we pay for the computers, up to the cap. A trial starts only if its worst case still fits; when the next one can't, the run pauses and you can score what it has."
    : "Your budget is the most Anybench will charge for this run: the run fee, computer time and any model tokens we provide. A trial starts only if its worst case still fits; when the next one can't, the run pauses and asks you.";
  const byok =
    live.byokTokenMicroUsd > 0n
      ? `${usd(live.byokTokenMicroUsd)} so far on your own API key (billed by your provider, not counted in the budget)`
      : null;
  return { line: `${usd(live.spentMicroUsd)} spent${held}${of}`, note, byok };
}
