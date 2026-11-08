// Scheduler (plan.md P3, P1 fairness, section 8 run gate).
//
// Two halves:
//   1. `expandTrials(input)`: a pure planner. Kit → TrialPlan[] (contender × workload × repeat,
//      plus warm-ups marked `warmup: true`), interleaved A B A B, and grouped into `block`s. A block
//      is one computer: without packing every trial gets its own fork; with `packing: true` short
//      software trials share one fork per paid billing block (Naïve: 600 s), and a block never holds
//      two repeats of the same contender × workload, so repeats are spread across computers.
//   2. `Scheduler`: a small loop over the blocks with injected ports: `launch(trial, ctx)` runs one
//      trial to a final state (the trial executor, 5.4), `budget` (cap, already spent, per-trial
//      estimate, all micro-USD), `billingGate()`, `killSwitch()`, a shared `ComputerPool` for the
//      concurrency caps (global `max_computers`, per user, per run) and an event `sink`.
//
// Before every trial launch the scheduler checks, in order: kill switch, billing gate, budget
// (spent + in-flight estimates + this trial's estimate <= cap). The first "no" stops all new
// launches; trials already running finish. A kill switch cancels every trial not yet launched
// (trial.phase queued → cancelled); a budget or gate stop leaves them queued so the run can resume
// (the run orchestrator moves the run to `paused_budget` / holds it; the scheduler only reports why).
//
// Input type: `SchedulableKit` is a minimal local stand-in for the kit (TDM-7 KitSpec is not merged
// yet). A later ticket can map KitSpec onto it or replace it.
import {
  AnybenchEventSchema,
  isFinalTrialState,
  mulMicro,
  newId,
  NonNegativeMicroUsdSchema,
  TrialIdSchema,
  TrialStateSchema,
  type AnybenchEvent,
  type EventActor,
  type MicroUsd,
  type TrialId,
  type TrialState,
} from "@anybench/core";
import { z } from "zod";

// ---------- input ----------

const kitId = z.string().min(1).max(128);

function unique(list: readonly string[]): boolean {
  return new Set(list).size === list.length;
}

/** The part of a kit the scheduler needs. Stand-in for KitSpec (TDM-7) until it lands. */
export const SchedulableKitSchema = z.strictObject({
  /** Contender ids in interleave order (A, B, …). */
  contenders: z.array(kitId).min(1).refine(unique, "contender ids must be unique"),
  workloads: z.array(kitId).min(1).refine(unique, "workload ids must be unique"),
  /** Measured repeats per contender × workload. */
  repeats: z.int().min(1).max(1000),
  /** Discarded warm-up trials per contender × workload, run before the measured ones. */
  warmups: z.int().min(0).max(100).default(0),
  /** Expected wall time of one trial, used for packing. */
  est_trial_seconds: z.int().positive(),
  /** Pack several short trials onto one computer per billing block (software kits only). */
  packing: z.boolean().default(false),
  /**
   * Rotate the contender order every round (kit `schedule.order_seed`, TDM-178). Omit for kit
   * order in every round.
   */
  order_seed: z.int().min(0).max(0xffff_ffff).optional(),
});
export type SchedulableKitInput = z.input<typeof SchedulableKitSchema>;
export type SchedulableKit = z.output<typeof SchedulableKitSchema>;

export const DEFAULT_BILLING_BLOCK_SECONDS = 600;

export const ExpandTrialsInputSchema = z.strictObject({
  run_id: z.string().min(1),
  kit: SchedulableKitSchema,
  /** Provider billing block (Naïve: 600 s, `capabilities.billing.blockSeconds`). */
  block_seconds: z.int().positive().default(DEFAULT_BILLING_BLOCK_SECONDS),
});
export type ExpandTrialsInput = z.input<typeof ExpandTrialsInputSchema>;

export interface ExpandTrialsOptions {
  /** Id factory, for deterministic tests. Default: a fresh UUIDv7 TrialId. */
  newTrialId?: () => TrialId;
}

// ---------- plan ----------

export interface TrialPlan {
  trial_id: TrialId;
  run_id: string;
  /** Launch order, 0-based, over the whole plan (warm-ups included). */
  index: number;
  contender_id: string;
  workload_id: string;
  /** 0-based: the warm-up number when `warmup`, else the measured repeat number. */
  repeat: number;
  /** Warm-ups are run and discarded: never scored. */
  warmup: boolean;
  /** The computer this trial runs on (0-based). Trials sharing a block share one fork, in order. */
  block: number;
}

/** One computer's worth of trials, in launch order. */
export interface TrialBlock {
  block: number;
  trials: TrialPlan[];
}

/** How many trials one packed computer holds: whole interleave rounds when they fit. */
export function packCapacity(kit: SchedulableKit, blockSeconds: number): number {
  if (!kit.packing) return 1;
  const raw = Math.floor(blockSeconds / kit.est_trial_seconds);
  if (raw < 2) return 1;
  const n = kit.contenders.length;
  // Keep complete A B rounds on one machine so contenders see the same box.
  return raw >= n ? Math.floor(raw / n) * n : raw;
}

/** mulberry32: a small deterministic PRNG, so a seed gives the same plan on every machine. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The contender order for every round. Without a seed: kit order each round. With one: a seeded
 * shuffle of the contenders, rotated by one place per round, so over any n consecutive rounds
 * each of the n contenders runs in each position exactly once.
 */
export function contenderOrders(
  contenders: readonly string[],
  rounds: number,
  seed?: number,
): string[][] {
  if (seed === undefined) return Array.from({ length: rounds }, () => [...contenders]);
  const rand = seededRandom(seed);
  const base = [...contenders];
  for (let i = base.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [base[i], base[j]] = [base[j]!, base[i]!];
  }
  const n = base.length;
  return Array.from({ length: rounds }, (_, r) => base.map((_, k) => base[(k + r) % n]!));
}

/**
 * Expand a kit into its trial plan. Pure apart from id generation.
 *
 * Order: all warm-ups first, then for each repeat, for each workload, every contender once,
 * so the sequence is A B A B … within each workload and every repeat is one full round. With
 * `order_seed` the contender order rotates per round (see `contenderOrders`).
 */
export function expandTrials(
  input: ExpandTrialsInput,
  opts: ExpandTrialsOptions = {},
): TrialPlan[] {
  const { run_id, kit, block_seconds } = ExpandTrialsInputSchema.parse(input);
  const makeId = opts.newTrialId ?? (() => newId(TrialIdSchema));

  const cells: Omit<TrialPlan, "trial_id" | "run_id" | "index" | "block">[] = [];
  const orders = contenderOrders(
    kit.contenders,
    (kit.warmups + kit.repeats) * kit.workloads.length,
    kit.order_seed,
  );
  let round = 0;
  for (const [warmup, count] of [
    [true, kit.warmups],
    [false, kit.repeats],
  ] as const) {
    for (let repeat = 0; repeat < count; repeat++) {
      for (const workload_id of kit.workloads) {
        for (const contender_id of orders[round++]!) {
          cells.push({ contender_id, workload_id, repeat, warmup });
        }
      }
    }
  }

  const capacity = packCapacity(kit, block_seconds);
  const plans: TrialPlan[] = [];
  let block = -1;
  let inBlock = new Set<string>();
  for (const [index, cell] of cells.entries()) {
    const key = `${cell.warmup ? "w" : "m"}\u0000${cell.contender_id}\u0000${cell.workload_id}`;
    // New computer when the block is full, or when it already ran this contender × workload:
    // two repeats of one cell never share a machine.
    if (block < 0 || inBlock.size >= capacity || inBlock.has(key)) {
      block++;
      inBlock = new Set();
    }
    inBlock.add(key);
    plans.push({ trial_id: makeId(), run_id, index, block, ...cell });
  }
  return plans;
}

/** Group a plan into its blocks, each in launch order. */
export function groupBlocks(plans: readonly TrialPlan[]): TrialBlock[] {
  const byBlock = new Map<number, TrialPlan[]>();
  for (const p of [...plans].sort((a, b) => a.index - b.index)) {
    const list = byBlock.get(p.block) ?? [];
    list.push(p);
    byBlock.set(p.block, list);
  }
  return [...byBlock.entries()]
    .sort(([a], [b]) => a - b)
    .map(([block, trials]) => ({ block, trials }));
}

/** Worst-case cost of a plan: per-trial estimate × trials (for the run gate on Go). */
export function estimatePlanCost(plans: readonly TrialPlan[], perTrial: MicroUsd): MicroUsd {
  return mulMicro(perTrial, plans.length);
}

// ---------- concurrency caps ----------

export const ConcurrencyCapsSchema = z.strictObject({
  /** Global cap on live computers (spike 2.1). */
  max_computers: z.int().positive(),
  max_computers_per_user: z.int().positive(),
  max_computers_per_run: z.int().positive(),
});
export type ConcurrencyCaps = z.infer<typeof ConcurrencyCapsSchema>;

export interface ComputerLease {
  readonly user_id: string;
  readonly run_id: string;
  /** Give the computer slot back. Idempotent. */
  release(): void;
}

interface PoolWaiter {
  user_id: string;
  run_id: string;
  runCap: number;
  grant: (lease: ComputerLease) => void;
}

/**
 * Counting semaphores for computers: global, per user and per run. Share one pool across every
 * run's Scheduler in a worker so the global and per-user caps hold across runs. Waiters are
 * served FIFO, skipping any whose user or run is still at its cap.
 */
export class ComputerPool {
  readonly caps: ConcurrencyCaps;
  private inUse = 0;
  private readonly byUser = new Map<string, number>();
  private readonly byRun = new Map<string, number>();
  private readonly waiters: PoolWaiter[] = [];
  private peakGlobal = 0;
  private readonly peakUser = new Map<string, number>();
  private readonly peakRun = new Map<string, number>();

  constructor(caps: ConcurrencyCaps) {
    this.caps = ConcurrencyCapsSchema.parse(caps);
  }

  /** Wait for a computer slot. `runCap` can only lower the pool's per-run cap. */
  acquire(user_id: string, run_id: string, runCap?: number): Promise<ComputerLease> {
    const cap = Math.min(runCap ?? Number.POSITIVE_INFINITY, this.caps.max_computers_per_run);
    const lease = this.tryAcquire(user_id, run_id, cap);
    if (lease) return Promise.resolve(lease);
    return new Promise((grant) => this.waiters.push({ user_id, run_id, runCap: cap, grant }));
  }

  /** A slot now, or null when any cap is reached. */
  tryAcquire(user_id: string, run_id: string, runCap?: number): ComputerLease | null {
    const cap = Math.min(runCap ?? Number.POSITIVE_INFINITY, this.caps.max_computers_per_run);
    if (!this.fits(user_id, run_id, cap)) return null;
    return this.take(user_id, run_id);
  }

  /** Live slots: global, or for one user / run. */
  inUseCount(scope?: { user_id?: string; run_id?: string }): number {
    if (scope?.run_id !== undefined) return this.byRun.get(scope.run_id) ?? 0;
    if (scope?.user_id !== undefined) return this.byUser.get(scope.user_id) ?? 0;
    return this.inUse;
  }

  /** Highest concurrency seen: global, or for one user / run. */
  peak(scope?: { user_id?: string; run_id?: string }): number {
    if (scope?.run_id !== undefined) return this.peakRun.get(scope.run_id) ?? 0;
    if (scope?.user_id !== undefined) return this.peakUser.get(scope.user_id) ?? 0;
    return this.peakGlobal;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  private fits(user_id: string, run_id: string, runCap: number): boolean {
    return (
      this.inUse < this.caps.max_computers &&
      (this.byUser.get(user_id) ?? 0) < this.caps.max_computers_per_user &&
      (this.byRun.get(run_id) ?? 0) < runCap
    );
  }

  private take(user_id: string, run_id: string): ComputerLease {
    this.inUse++;
    const u = (this.byUser.get(user_id) ?? 0) + 1;
    const r = (this.byRun.get(run_id) ?? 0) + 1;
    this.byUser.set(user_id, u);
    this.byRun.set(run_id, r);
    this.peakGlobal = Math.max(this.peakGlobal, this.inUse);
    this.peakUser.set(user_id, Math.max(this.peakUser.get(user_id) ?? 0, u));
    this.peakRun.set(run_id, Math.max(this.peakRun.get(run_id) ?? 0, r));
    let released = false;
    return {
      user_id,
      run_id,
      release: () => {
        if (released) return;
        released = true;
        this.give(user_id, run_id);
      },
    };
  }

  private give(user_id: string, run_id: string): void {
    this.inUse--;
    this.byUser.set(user_id, (this.byUser.get(user_id) ?? 1) - 1);
    this.byRun.set(run_id, (this.byRun.get(run_id) ?? 1) - 1);
    for (let i = 0; i < this.waiters.length;) {
      const w = this.waiters[i]!;
      if (this.fits(w.user_id, w.run_id, w.runCap)) {
        this.waiters.splice(i, 1);
        w.grant(this.take(w.user_id, w.run_id));
      } else {
        i++;
      }
    }
  }
}

// ---------- ports ----------

export interface LaunchContext {
  /** Stable id of the computer this trial runs on: trials with the same key share one fork. */
  computer_key: string;
  /** 0-based position of this trial in its block. */
  position_in_block: number;
  /** Trials planned for this block. The block may end early if the scheduler stops. */
  block_size: number;
}

export const LaunchResultSchema = z.object({
  /** Where the trial ended: done | failed_infra | failed_subject | cancelled. */
  state: TrialStateSchema.refine(isFinalTrialState, "launch must resolve with a final trial state"),
  /** What this trial actually cost the run (billed to the user), integer micro-USD. */
  cost_micro_usd: NonNegativeMicroUsdSchema,
});
export type LaunchResult = z.input<typeof LaunchResultSchema>;

/** Runs one trial to a final state (the trial executor). Infra retries happen inside it. */
export type LaunchFn = (trial: TrialPlan, ctx: LaunchContext) => Promise<LaunchResult>;

export interface BudgetPort {
  /** Run budget (`runs.budget_micro_usd`). */
  cap_micro_usd: MicroUsd;
  /** Already spent on this run before this scheduler started (resume). Default 0. */
  spent_micro_usd?: MicroUsd;
  /** Reserved per launched trial until it reports its actual cost. */
  estimate_per_trial_micro_usd: MicroUsd;
}

export interface GateDecision {
  allowed: boolean;
  reason?: string;
}

export interface KillSwitchState {
  engaged: boolean;
  scope?: "global" | "run" | "user";
  reason?: string;
}

export type MaybePromise<T> = T | Promise<T>;

export interface EventSink {
  emit(event: AnybenchEvent): MaybePromise<void>;
}

export interface SchedulerOptions {
  run_id: string;
  user_id: string;
  plans: readonly TrialPlan[];
  launch: LaunchFn;
  budget: BudgetPort;
  /** Section 8 run gate, re-checked before every launch (payment failure blocks new trials). */
  billingGate: () => MaybePromise<GateDecision>;
  /** `kill_switches` (global | run | user), checked before every launch. */
  killSwitch: () => MaybePromise<KillSwitchState>;
  pool: ComputerPool;
  /** Lower per-run cap for this run than the pool's. */
  max_computers_for_run?: number;
  sink: EventSink;
  /**
   * Called once when a block is over (all its trials ran, or the scheduler stopped early), before
   * its computer slot is released: destroy the shared computer here. Errors are swallowed.
   */
  onBlockEnd?: (computer_key: string, trialsRun: number) => MaybePromise<void>;
  /** Emit `trial.phase ∅ → queued` for every plan at start. Default true; false on resume. */
  emitQueued?: boolean;
  /** Event `seq` source. Default: a counter starting at `seqStart` (default 0). */
  nextSeq?: () => number;
  seqStart?: number;
  actor?: EventActor;
  now?: () => number;
}

// ---------- result ----------

export type StopKind = "budget" | "billing_gate" | "kill_switch";

export interface StopReason {
  kind: StopKind;
  reason: string;
}

export interface TrialOutcome {
  trial: TrialPlan;
  state: TrialState;
  cost_micro_usd: MicroUsd;
  computer_key: string;
  error?: string;
}

export interface SchedulerResult {
  /** Why launching stopped early, or null when every trial was launched. */
  stop: StopReason | null;
  /** Every launched trial with its final state, in completion order. */
  outcomes: TrialOutcome[];
  /** Planned but never launched: still `queued` after a budget / gate stop. */
  queued: TrialPlan[];
  /** Planned but never launched and cancelled by the kill switch. */
  cancelled: TrialPlan[];
  /** Spent on this run including `budget.spent_micro_usd`. */
  spent_micro_usd: MicroUsd;
  /** Computers this run used at once, at most. */
  peak_computers: number;
}

// ---------- scheduler ----------

export class Scheduler {
  private readonly o: SchedulerOptions;
  private readonly blocks: TrialBlock[];
  private readonly estimate: MicroUsd;
  private spent: MicroUsd;
  private reserved: MicroUsd = 0n;
  private stopReason: StopReason | null = null;
  private readonly launched = new Set<string>();
  private readonly outcomes: TrialOutcome[] = [];
  private readonly nextSeq: () => number;
  private started = false;

  constructor(opts: SchedulerOptions) {
    this.o = opts;
    for (const p of opts.plans) {
      if (p.run_id !== opts.run_id) {
        throw new Error(`trial ${p.trial_id} belongs to run ${p.run_id}, not ${opts.run_id}`);
      }
    }
    if (new Set(opts.plans.map((p) => p.trial_id)).size !== opts.plans.length) {
      throw new Error("trial ids in the plan must be unique");
    }
    this.blocks = groupBlocks(opts.plans);
    this.estimate = NonNegativeMicroUsdSchema.parse(opts.budget.estimate_per_trial_micro_usd);
    NonNegativeMicroUsdSchema.parse(opts.budget.cap_micro_usd);
    this.spent = NonNegativeMicroUsdSchema.parse(opts.budget.spent_micro_usd ?? 0n);
    let seq = opts.seqStart ?? 0;
    this.nextSeq = opts.nextSeq ?? (() => seq++);
  }

  /** Run every block, honoring caps, budget, gate and kill switch. Call once. */
  async run(): Promise<SchedulerResult> {
    if (this.started) throw new Error("Scheduler.run() may only be called once");
    this.started = true;

    if (this.o.emitQueued ?? true) {
      for (const b of this.blocks) {
        for (const t of b.trials) await this.emitPhase(t, null, "queued");
      }
    }

    const inflight = new Set<Promise<void>>();
    for (const block of this.blocks) {
      if (await this.checkStop()) break;
      const lease = await this.o.pool.acquire(
        this.o.user_id,
        this.o.run_id,
        this.o.max_computers_for_run,
      );
      // Conditions may have changed while waiting for a slot.
      if (await this.checkStop()) {
        lease.release();
        break;
      }
      this.reserve(block.trials[0]!);
      const p: Promise<void> = this.runBlock(block, lease).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    while (inflight.size > 0) await Promise.all([...inflight]);

    const pending = this.o.plans
      .filter((t) => !this.launched.has(t.trial_id))
      .sort((a, b) => a.index - b.index);
    const killed = this.stopReason?.kind === "kill_switch";
    if (killed) {
      for (const t of pending)
        await this.emitPhase(t, "queued", "cancelled", this.stopReason!.reason);
    }
    return {
      stop: this.stopReason,
      outcomes: [...this.outcomes],
      queued: killed ? [] : pending,
      cancelled: killed ? pending : [],
      spent_micro_usd: this.spent,
      peak_computers: this.o.pool.peak({ run_id: this.o.run_id }),
    };
  }

  /**
   * Run a block's trials in order on one computer. The first trial was already checked and
   * reserved by the caller; later ones are checked here.
   */
  private async runBlock(block: TrialBlock, lease: ComputerLease): Promise<void> {
    const computer_key = `${this.o.run_id}:b${block.block}`;
    let ran = 0;
    try {
      for (const [i, trial] of block.trials.entries()) {
        if (i > 0) {
          if (await this.checkStop()) break;
          this.reserve(trial);
        }
        await this.launchOne(trial, {
          computer_key,
          position_in_block: i,
          block_size: block.trials.length,
        });
        ran++;
      }
    } finally {
      try {
        await this.o.onBlockEnd?.(computer_key, ran);
      } catch {
        // Cleanup is the executor's and the reaper's job; never wedge the scheduler on it.
      } finally {
        lease.release();
      }
    }
  }

  private reserve(trial: TrialPlan): void {
    this.launched.add(trial.trial_id);
    this.reserved += this.estimate;
  }

  private async launchOne(trial: TrialPlan, ctx: LaunchContext): Promise<void> {
    let outcome: TrialOutcome;
    try {
      const raw = await this.o.launch(trial, ctx);
      const parsed = LaunchResultSchema.safeParse(raw);
      if (parsed.success) {
        outcome = { trial, computer_key: ctx.computer_key, ...parsed.data };
      } else {
        // Unknown spend: count the estimate, so a bad report can never loosen the budget.
        outcome = {
          trial,
          computer_key: ctx.computer_key,
          state: "failed_infra",
          cost_micro_usd: this.estimate,
          error: `invalid launch result: ${parsed.error.message}`,
        };
      }
    } catch (err) {
      // The executor threw instead of resolving: an infra failure, never billed.
      outcome = {
        trial,
        computer_key: ctx.computer_key,
        state: "failed_infra",
        cost_micro_usd: 0n,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.reserved -= this.estimate;
    this.spent += outcome.cost_micro_usd;
    this.outcomes.push(outcome);
  }

  /** Sets and returns the stop reason when a launch must not happen. Budget check is last and sync. */
  private async checkStop(): Promise<StopReason | null> {
    if (this.stopReason) return this.stopReason;
    const kill = await this.o.killSwitch();
    if (this.stopReason) return this.stopReason;
    if (kill.engaged) {
      return this.setStop({
        kind: "kill_switch",
        reason: kill.reason ?? `kill switch engaged (${kill.scope ?? "global"})`,
      });
    }
    const gate = await this.o.billingGate();
    if (this.stopReason) return this.stopReason;
    if (!gate.allowed) {
      return this.setStop({ kind: "billing_gate", reason: gate.reason ?? "billing gate closed" });
    }
    const committed = this.spent + this.reserved + this.estimate;
    if (committed > this.o.budget.cap_micro_usd) {
      return this.setStop({
        kind: "budget",
        reason: `next trial would exceed the run budget (${committed} > ${this.o.budget.cap_micro_usd} micro-USD)`,
      });
    }
    return null;
  }

  private setStop(stop: StopReason): StopReason {
    this.stopReason ??= stop;
    return this.stopReason;
  }

  private async emitPhase(
    trial: TrialPlan,
    from: TrialState | null,
    to: TrialState,
    reason?: string,
  ): Promise<void> {
    const event = AnybenchEventSchema.parse({
      run_id: this.o.run_id,
      seq: this.nextSeq(),
      source: "trial",
      source_id: trial.trial_id,
      type: "trial.phase",
      severity: to === "cancelled" ? "warn" : "info",
      actor: this.o.actor ?? { kind: "system" },
      at: new Date((this.o.now ?? Date.now)()).toISOString(),
      payload: { from, to, attempt: 1, ...(reason === undefined ? {} : { reason }) },
    });
    await this.o.sink.emit(event);
  }
}
