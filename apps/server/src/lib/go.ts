// The Go decision (TDM-243): ONE function for POST /runs/:id/go and the orchestrator's auto-go,
// so a run starts (or is refused) for exactly the same reasons either way:
//
//   1. the free starter run first (lib/free-run.ts freeRunAtGo, TDM-224): `reserved` = no card
//      needed and the billing gate is not asked; `conflict` = the run moved under us;
//   2. otherwise the billing gate (lib/billing-gate.ts, incl. TDM-244's rule that a kit on our
//      model tokens needs a card on file); a refusal is the contract's 402 body plus the one
//      plain-words sentence the Go button shows (core paymentRequiredMessage);
//   3. then the caller's transition (the route's tenant transaction, or the orchestrator store's
//      leased commit). If this call reserved the free run (`created`) and the run does not leave
//      awaiting_go (the transition declined or threw), the reservation and the entitlement go back
//      (packages/billing releaseFreeRun, reason `go_failed`) before the answer.
//
// The reservation and the transition are two transactions (billing's on the pool role), so a crash
// in between leaves the run in awaiting_go holding its reservation: the next Go (or auto-go sweep)
// finds it (`duplicate`) and goes on free, and a cancel before Go releases it (routes/runs.ts).
import { releaseFreeRun } from "@anybench/billing";
import { paymentRequiredMessage, type PaymentRequired } from "@anybench/core";
import type { BillingGate } from "./billing-gate.js";
import {
  freeRunAtGo,
  type FreeRunAtGo,
  type FreeRunGoDeps,
  type FreeRunGoRun,
} from "./free-run.js";

export interface GoLogger {
  warn(obj: object, msg?: string): void;
}

export interface GoDeps {
  db: FreeRunGoDeps["db"];
  /** The free run's config; null = the free run is not in play (orchestrator tests and tools). */
  config: FreeRunGoDeps["config"] | null;
  billingGate: BillingGate;
  log?: GoLogger;
}

export interface GoInput {
  /** The run's owner (the account that pays, or whose free run it is). */
  userId: string;
  run: FreeRunGoRun;
  /** The run's estimate (integer micro-USD), already checked against its budget by the caller. */
  estimateMicroUsd: bigint;
}

/** What the transition is told: `free` = this run starts on the free starter run. */
export interface GoContext {
  free: boolean;
}

/** The caller's state change: `moved` = the run left awaiting_go; `value` is passed back as is. */
export type GoTransition<T> = (ctx: GoContext) => Promise<{ moved: boolean; value: T }>;

export type GoResult<T> =
  /** The run left awaiting_go. */
  | { kind: "started"; free: boolean; value: T }
  /** The transition declined (the run moved meanwhile); any reservation made here was released. */
  | { kind: "not_moved"; value: T }
  /** The billing gate refused: the 402 body, and the sentence the Go button shows. */
  | { kind: "payment_required"; payment: PaymentRequired; message: string }
  /** The free run saw the run move under us (not awaiting_go, kit origin changed): 409. */
  | { kind: "conflict"; message: string };

export async function startRunAtGo<T>(
  deps: GoDeps,
  input: GoInput,
  transition: GoTransition<T>,
): Promise<GoResult<T>> {
  const free: FreeRunAtGo = deps.config
    ? await freeRunAtGo(
        { db: deps.db, config: deps.config },
        { userId: input.userId, run: input.run },
      )
    : { kind: "skip" };
  if (free.kind === "conflict") return { kind: "conflict", message: free.message };
  if (free.kind !== "reserved") {
    const gate = await deps.billingGate(
      { userId: input.userId, runId: input.run.id },
      input.estimateMicroUsd,
    );
    if (!gate.allowed) {
      const payment: PaymentRequired = {
        reason: gate.reason,
        link_card_url: gate.link_card_url,
        ...(free.kind === "refused" ? { free_run: free.refusal } : {}),
        // TDM-244: e.g. a kit on our model tokens with no card on file, in plain words.
        ...(gate.message ? { message: gate.message } : {}),
      };
      return { kind: "payment_required", payment, message: paymentRequiredMessage(payment) };
    }
  }

  const reservedHere = free.kind === "reserved" && free.created;
  let moved: { moved: boolean; value: T };
  try {
    moved = await transition({ free: free.kind === "reserved" });
  } catch (err) {
    if (reservedHere) await releaseAfterFailedGo(deps, input.run.id);
    throw err;
  }
  if (!moved.moved) {
    if (reservedHere) await releaseAfterFailedGo(deps, input.run.id);
    return { kind: "not_moved", value: moved.value };
  }
  return { kind: "started", free: free.kind === "reserved", value: moved.value };
}

/**
 * Go reserved the free run but the run did not leave awaiting_go: give the reservation and the
 * entitlement back (releaseFreeRun only releases a run still in awaiting_go, or one the user
 * cancelled there, so a concurrent Go that did start the run keeps it). A failure here is logged,
 * never hides the Go's own answer.
 */
async function releaseAfterFailedGo(deps: GoDeps, runId: string): Promise<void> {
  try {
    await releaseFreeRun(deps.db, { runId, reason: "go_failed" });
  } catch (err) {
    deps.log?.warn({ err, runId }, "go: releasing the free run after a failed transition failed");
  }
}
