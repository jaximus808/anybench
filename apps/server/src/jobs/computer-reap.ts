// computer.reap (TDM-31, plan.md sections 5 and 7): no leaked spend. Every 60 s, list every
// provider computer carrying an Anybench tag (`ab-<run>-<trial>`), and destroy any whose trial is
// not live and whose last activity is more than 15 min ago. Each one emits `computer.leaked`
// and goes into an alert-ready payload (rule "Computer alive with no live trial for > 15 min",
// critical). A destroy that fails is flagged `leaked` and retried on the next tick; the job never
// throws for it, because a throw would only make graphile-worker retry the whole sweep.
//
// "Live" is deliberately generous, because destroying a live trial's computer is worse than
// paying for one more tick: the trial row exists, its state is not terminal, its run is not
// terminal, and either the trial has no computer_id yet or it points at this computer.
import type { AnybenchEvent } from "@anybench/core";
import { AnybenchEventSchema } from "@anybench/core";
import { createComputerRegistry, type ComputerRecord, type ComputerRegistry } from "@anybench/envs";
import {
  ANYBENCH_TAG_PREFIX,
  hyphenateUuid,
  parseTrialTag,
  type ComputeProvider,
  type ComputerInfo,
} from "@anybench/providers";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import { drizzleComputerStore } from "../lib/computer-store.js";
import type { Logger } from "../lib/logger.js";
import { defineJob, type JobContext } from "./types.js";

export const COMPUTER_REAP_INTERVAL_MS = 60_000;
/** plan.md section 7: "Computer alive with no live trial for > 15 min". */
export const COMPUTER_LEAK_IDLE_MS = 15 * 60_000;
export const COMPUTER_LEAK_RULE_KEY = "computer.leaked";

const TERMINAL_TRIAL_STATES = new Set(["done", "failed_infra", "failed_subject", "cancelled"]);
const TERMINAL_RUN_STATES = new Set(["delivered", "failed", "cancelled"]);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the appender assigns `run_id` and the run-wide `seq`. */
export type EventDraft = DistributiveOmit<AnybenchEvent, "seq" | "run_id">;

/** The events port; TDM-72's `appendEvents(db, runId, events)` in src/lib/events.ts fits it. */
export interface EventsPort {
  append(db: Database, runId: string | null, events: EventDraft[]): Promise<unknown>;
}

export interface LeakedComputer {
  computerId: string;
  provider: string;
  providerId: string;
  runId: string | null;
  trialId: string | null;
  idleS: number;
  /** destroyed now, or flagged (destroy failed; retried next tick). */
  action: "destroyed" | "flagged";
  blocksBilled: number;
  costMicroUsd: bigint;
  error?: string;
}

/** One row for the `alerts` table (deduped by fingerprint while unresolved). JSON-safe payload. */
export interface ComputerLeakAlert {
  ruleKey: typeof COMPUTER_LEAK_RULE_KEY;
  scope: "computer";
  severity: "critical";
  fingerprint: string;
  runId: string | null;
  title: string;
  payload: {
    /** Empty only if the registry row could not be written either. */
    computer_id: string;
    provider: string;
    provider_id: string;
    trial_id: string | null;
    idle_s: number;
    action: "destroyed" | "flagged";
    blocks_billed: number;
    cost_micro_usd: string;
    error?: string;
  };
}

export interface ReapReport {
  /** Tagged provider computers seen this tick. */
  checked: number;
  /** Left alone: their trial is live. */
  live: number;
  /** Left alone: not live, but active within the idle window. */
  recent: number;
  reaped: LeakedComputer[];
  failed: LeakedComputer[];
  alerts: ComputerLeakAlert[];
  totalLeakedCostMicroUsd: bigint;
}

export interface ReapDeps {
  db: Database;
  /** One registry per provider to sweep. */
  registries: readonly ComputerRegistry[];
  events: EventsPort;
  now?: () => Date;
  idleMs?: number;
  logger?: Logger;
  actor?: EventDraft["actor"];
}

interface TrialLiveness {
  id: string;
  runId: string;
  state: string;
  runState: string | null;
  computerId: string | null;
  updatedAt: Date;
  endedAt: Date | null;
}

function trialRef(info: ComputerInfo): { runId: string; trialId: string } | null {
  for (const tag of info.tags) {
    const parsed = parseTrialTag(tag);
    if (!parsed) continue;
    try {
      return { runId: hyphenateUuid(parsed.runId), trialId: hyphenateUuid(parsed.trialId) };
    } catch {
      // An ab- tag whose parts are not UUIDs: not ours to interpret.
    }
  }
  return null;
}

async function loadTrials(db: Database, trialIds: string[]): Promise<Map<string, TrialLiveness>> {
  const out = new Map<string, TrialLiveness>();
  if (trialIds.length === 0) return out;
  const rows = await db
    .select({
      id: trials.id,
      runId: trials.runId,
      state: trials.state,
      computerId: trials.computerId,
      updatedAt: trials.updatedAt,
      endedAt: trials.endedAt,
    })
    .from(trials)
    .where(inArray(trials.id, trialIds));
  const runIds = [...new Set(rows.map((r) => r.runId))];
  const runStates = new Map<string, string>();
  if (runIds.length > 0) {
    for (const r of await db
      .select({ id: runs.id, state: runs.state })
      .from(runs)
      .where(inArray(runs.id, runIds))) {
      runStates.set(r.id, r.state);
    }
  }
  for (const r of rows) out.set(r.id, { ...r, runState: runStates.get(r.runId) ?? null });
  return out;
}

function isLive(trial: TrialLiveness | undefined, record: ComputerRecord | null): boolean {
  if (!trial) return false;
  if (TERMINAL_TRIAL_STATES.has(trial.state)) return false;
  if (trial.runState !== null && TERMINAL_RUN_STATES.has(trial.runState)) return false;
  return trial.computerId === null || (record !== null && trial.computerId === record.id);
}

function lastActivity(
  info: ComputerInfo,
  record: ComputerRecord | null,
  trial: TrialLiveness | undefined,
): Date {
  const times = [
    Date.parse(info.createdAt),
    record?.createdAt.getTime(),
    record?.lastSeenAt?.getTime(),
    trial?.updatedAt.getTime(),
    trial?.endedAt?.getTime(),
  ].filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  return new Date(Math.max(...times));
}

function leakedEvent(
  leak: LeakedComputer,
  at: Date,
  actor: EventDraft["actor"],
  lastTrialId: string | null,
): EventDraft {
  const draft = {
    type: "computer.leaked" as const,
    source: "computer" as const,
    source_id: leak.computerId,
    severity: "critical" as const,
    actor,
    cost_delta_micro_usd: 0n,
    at: at.toISOString(),
    payload: {
      provider: leak.provider,
      idle_s: leak.idleS,
      action: leak.action,
      ...(lastTrialId ? { last_trial_id: lastTrialId } : {}),
    },
  };
  // zod at the boundary: the draft must be a valid AnybenchEvent once seq/run_id are assigned.
  AnybenchEventSchema.parse({ ...draft, run_id: leak.runId, seq: 0 });
  return draft;
}

function toAlert(leak: LeakedComputer): ComputerLeakAlert {
  return {
    ruleKey: COMPUTER_LEAK_RULE_KEY,
    scope: "computer",
    severity: "critical",
    // Keyed by the provider's id: stable across ticks even if the row could not be written.
    fingerprint: `${COMPUTER_LEAK_RULE_KEY}:${leak.provider}:${leak.providerId}`,
    runId: leak.runId,
    title:
      leak.action === "destroyed"
        ? `Leaked computer ${leak.providerId} (${leak.provider}) destroyed after ${Math.floor(leak.idleS / 60)} min with no live trial`
        : `Leaked computer ${leak.providerId} (${leak.provider}) could not be destroyed; retrying every minute`,
    payload: {
      computer_id: leak.computerId,
      provider: leak.provider,
      provider_id: leak.providerId,
      trial_id: leak.trialId,
      idle_s: leak.idleS,
      action: leak.action,
      blocks_billed: leak.blocksBilled,
      cost_micro_usd: leak.costMicroUsd.toString(),
      ...(leak.error !== undefined ? { error: leak.error } : {}),
    },
  };
}

/** One sweep. Never throws for a single computer's failure; a list() failure skips that provider. */
export async function reapComputers(deps: ReapDeps): Promise<ReapReport> {
  const now = deps.now ?? (() => new Date());
  const idleMs = deps.idleMs ?? COMPUTER_LEAK_IDLE_MS;
  const actor = deps.actor ?? { kind: "system" as const };
  const report: ReapReport = {
    checked: 0,
    live: 0,
    recent: 0,
    reaped: [],
    failed: [],
    alerts: [],
    totalLeakedCostMicroUsd: 0n,
  };
  const eventsByRun = new Map<string | null, EventDraft[]>();

  for (const registry of deps.registries) {
    const provider: ComputeProvider = registry.provider;
    let listed: ComputerInfo[];
    try {
      listed = await provider.list({ tagPrefix: ANYBENCH_TAG_PREFIX });
    } catch (err) {
      deps.logger?.warn({ err, provider: provider.name }, "computer.reap: list failed; next tick");
      continue;
    }
    listed = listed.filter((c) => c.status !== "destroyed");
    report.checked += listed.length;

    const refs = new Map(listed.map((c) => [c.id, trialRef(c)]));
    const trialIds = [...new Set([...refs.values()].flatMap((r) => (r ? [r.trialId] : [])))];
    const liveness = await loadTrials(deps.db, trialIds);

    for (const info of listed) {
      const ref = refs.get(info.id) ?? null;
      let record = await registry.findByProviderId(info.id);
      const trial = ref ? liveness.get(ref.trialId) : undefined;
      if (isLive(trial, record)) {
        report.live++;
        continue;
      }
      const at = now();
      const idle = at.getTime() - lastActivity(info, record, trial).getTime();
      if (idle <= idleMs) {
        report.recent++;
        continue;
      }

      // Only now (well past any create→update window) do we adopt a computer with no row.
      const runId = record?.runId ?? (trial ? trial.runId : null);
      const trialId = record?.trialId ?? (trial ? trial.id : null);
      const wasFlagged = record?.status === "leaked";
      const leak: LeakedComputer = {
        computerId: "",
        provider: provider.name,
        providerId: info.id,
        runId,
        trialId,
        idleS: Math.floor(idle / 1000),
        action: "destroyed",
        blocksBilled: 0,
        costMicroUsd: 0n,
      };
      try {
        record ??= await registry.adopt(info, { runId, trialId });
        leak.computerId = record.id;
        const out = await registry.destroy(record.id);
        leak.blocksBilled = out.blocksBilled;
        leak.costMicroUsd = out.costMicroUsd;
        report.reaped.push(leak);
      } catch (err) {
        leak.action = "flagged";
        leak.error = err instanceof Error ? err.message : String(err);
        if (record) {
          leak.computerId = record.id;
          const cost = registry.costOf(record, at);
          leak.blocksBilled = cost.blocksBilled;
          leak.costMicroUsd = cost.costMicroUsd;
          await registry.markLeaked(record.id).catch((e: unknown) => {
            deps.logger?.warn({ err: e, computerId: record?.id }, "computer.reap: mark failed");
          });
        }
        report.failed.push(leak);
        deps.logger?.warn(
          { err, provider: provider.name, providerId: info.id },
          "computer.reap: destroy failed; retrying next tick",
        );
      }
      report.totalLeakedCostMicroUsd += leak.costMicroUsd;
      // Alerts dedupe by fingerprint, so a still-failing leak re-reports into the same open alert.
      report.alerts.push(toAlert(leak));
      // Events: one flag per leak, not one per minute while the provider keeps failing.
      if (leak.computerId === "" || (leak.action === "flagged" && wasFlagged)) continue;
      const list = eventsByRun.get(leak.runId) ?? [];
      list.push(leakedEvent(leak, at, actor, trialId));
      eventsByRun.set(leak.runId, list);
    }
  }

  for (const [runId, events] of eventsByRun) {
    try {
      await deps.events.append(deps.db, runId, events);
    } catch (err) {
      deps.logger?.error({ err, runId }, "computer.reap: could not append computer.leaked events");
    }
  }
  return report;
}

// ---------- job ----------

export interface ComputerReapJobOptions {
  /** Providers to sweep. */
  providers?: (ctx: JobContext) => readonly ComputeProvider[];
  events?: EventsPort;
  now?: () => Date;
}

/** Until the real appender lands, leaks still reach the logs (and the returned alert payload). */
const loggingEventsPort = (logger: Logger): EventsPort => ({
  async append(_db, runId, events) {
    logger.warn(
      { runId, events: events.map((e) => e.type) },
      "computer.reap: events not persisted",
    );
  },
});

export function createComputerReapJob(options: ComputerReapJobOptions = {}) {
  return defineJob({
    name: "computer.reap",
    payload: z.object({}),
    everyMs: COMPUTER_REAP_INTERVAL_MS,
    jobKey: () => "computers:reap",
    async run(_payload, ctx) {
      // TODO([3.1] naive provider): sweep the configured providers (naive, docker-local) once a provider factory exists.
      const providers = options.providers?.(ctx) ?? [];
      if (providers.length === 0) {
        ctx.logger.debug({ job: "computer.reap" }, "no providers configured");
        return;
      }
      const store = drizzleComputerStore(ctx.db);
      const pricing = { pricePerBlockMicroUsd: ctx.config.COMPUTER_BLOCK_PRICE_MICRO_USD };
      // TODO(TDM-72): default `events` to { append: appendEvents } from ../lib/events.js once it is on main.
      const events = options.events ?? loggingEventsPort(ctx.logger);
      const report = await reapComputers({
        db: ctx.db,
        registries: providers.map((provider) =>
          createComputerRegistry({ provider, store, pricing, now: options.now }),
        ),
        events,
        now: options.now,
        logger: ctx.logger,
        actor: { kind: "worker", id: ctx.workerId },
      });
      if (report.alerts.length > 0) {
        ctx.logger.error(
          {
            job: "computer.reap",
            reaped: report.reaped.length,
            failed: report.failed.length,
            costMicroUsd: report.totalLeakedCostMicroUsd.toString(),
            alerts: report.alerts,
          },
          "leaked computers",
        );
      }
    },
  });
}

export const computerReapJob = createComputerReapJob();
