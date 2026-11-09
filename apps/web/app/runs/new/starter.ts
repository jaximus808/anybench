// TDM-225: the free starter run on the New run screen. When the account still has its free run
// (billing.summary `free_run.status` available), the flow proposes a starter-sized run: at most
// `max_setups` setups (the subject plus one alternative) and few enough runs per setup to stay
// within `max_trials`, and tells the kit designer those limits. Enlarge the run past them and the
// screen says it will be paid and need a card. Free runs paused: it says so, and the run is paid.
// The limits always come from the API (free_run.limits, from FREE_RUN_MAX_TRIALS etc.), never
// from this file. The real price, line by line, is on the run page before Go (runs.estimate).
import type { BillingSummary, FreeRunStatus } from "@anybench/core";
import { RUNS_PER_SETUP_MAX, RUNS_PER_SETUP_MIN } from "./new-run";

export type StarterLimits = FreeRunStatus["limits"];

export type StarterOffer =
  | { kind: "available"; limits: StarterLimits; hasModelKey: boolean }
  | { kind: "paused"; limits: StarterLimits }
  | null;

/** What the billing summary says about the free run, for this screen. Null: not in play. */
export function starterOffer(s: BillingSummary | null): StarterOffer {
  if (!s || s.mode === "off" || !s.free_run) return null;
  const f = s.free_run;
  if (f.status === "available")
    return { kind: "available", limits: f.limits, hasModelKey: f.has_model_key };
  if (f.status === "paused") return { kind: "paused", limits: f.limits };
  return null;
}

/**
 * Tasks a proposed starter leaves room for. The kit designer picks the tasks; the proposed runs
 * per setup are sized so that this many fit in `max_trials` over `max_setups` setups.
 */
export const STARTER_TASKS = 4;

/** Runs per setup the starter proposes: max_trials / (max_setups x STARTER_TASKS), at least 1. */
export function starterRunsPerSetup(limits: StarterLimits): number {
  const n = Math.floor(limits.max_trials / (limits.max_setups * STARTER_TASKS));
  return Math.max(RUNS_PER_SETUP_MIN, Math.min(RUNS_PER_SETUP_MAX, n));
}

/** Setups the run will compare: the subject plus what the user named (Anybench adds one if none). */
export function plannedSetups(compared: number): number {
  return 1 + Math.max(1, compared);
}

/** Alternatives a starter run has room for besides the subject. */
export function starterAlternatives(limits: StarterLimits): number {
  return Math.max(0, limits.max_setups - 1);
}

export type StarterFit = { fits: true } | { fits: false; passed: string[] };

/** Whether the form, as it stands, is still a starter run; if not, which limits it passes. */
export function starterFit(
  limits: StarterLimits,
  run: { setups: number; runsPerSetup: number },
): StarterFit {
  const passed: string[] = [];
  if (run.setups > limits.max_setups)
    passed.push(`${run.setups} setups; a free run compares at most ${limits.max_setups}`);
  // Every setup runs every task at least once: runs per setup x setups is the least it can be.
  if (Number.isInteger(run.runsPerSetup) && run.runsPerSetup * run.setups > limits.max_trials)
    passed.push(
      `${run.runsPerSetup} runs per setup is more than a free run's ${limits.max_trials} trials allow`,
    );
  return passed.length === 0 ? { fits: true } : { fits: false, passed };
}

/** The preference line the kit designer reads for a starter run (composeQuestion). */
export function starterPreference(limits: StarterLimits): string {
  const alts = starterAlternatives(limits);
  return `Free starter run: compare against at most ${alts} ${alts === 1 ? "alternative" : "alternatives"} (${limits.max_setups} setups in all) and keep the plan to at most ${limits.max_trials} trials in all, warm-ups included`;
}

export type StarterPrice =
  | { kind: "free"; text: string; needsKey: boolean }
  | { kind: "paid_past_limits"; text: string }
  | { kind: "paid_paused"; text: string };

/** The price line on the review step, or null when the free run is not in play. */
export function starterPrice(
  offer: StarterOffer,
  run: { setups: number; runsPerSetup: number },
): StarterPrice | null {
  if (!offer) return null;
  const l = offer.limits;
  if (offer.kind === "paused")
    return {
      kind: "paid_paused",
      text: "Free runs are paused right now, so this run is billed at the normal price. A card will be needed before Go; you see the estimate first.",
    };
  const fit = starterFit(l, run);
  if (!fit.fits)
    return {
      kind: "paid_past_limits",
      text: `Paid: past the free run's limits (${fit.passed.join("; ")}). A card will be needed before Go; you see the estimate first.`,
    };
  return {
    kind: "free",
    text: `Free: your first benchmark, sized as a starter run (${l.max_setups} setups, up to ${l.max_trials} trials, on your own model key). No card needed.`,
    needsKey: !offer.hasModelKey,
  };
}
