// computer.reap (TDM-31, plan.md sections 5 and 7): no leaked spend. Every 60 s, list every
// provider computer carrying an Anybench tag (`ab-<run>-<trial>`), and destroy any whose trial is
// not live and whose last activity is more than 15 min ago. Each one emits `computer.leaked`
// and goes into an alert-ready payload (rule "Computer alive with no live trial for > 15 min",
// critical). A destroy that fails is flagged `leaked` and retried on the next tick; the job never
// throws for it, because a throw would only make graphile-worker retry the whole sweep.
//
// Ours or not: the reaper only ever destroys a computer it can prove is ours, i.e. one with a
// `computers` row, or one whose `ab-<run>-<trial>` tag names a trial in THIS database. Anything
// else carrying an `ab-` tag (another deployment, `ab-test`, a hand-made box) is logged and left
// alone, and `ab-infra-*` (our own infrastructure, e.g. the worker host) is never touched.
//
// "Live" is deliberately generous, because destroying a live trial's computer is worse than
// paying for one more tick. A computer is live if a trial still holds it (trialHoldsComputer:
// trial not terminal, failed_infra only while it may still retry, run not terminal), where
// "holds" means either
//   - the trial named in its tag, with no computer_id yet (forking) or computer_id = this row, or
//   - any trial whose computer_id = this row (packed blocks: several trials share one computer).
import {
  AnybenchEventSchema,
  isTerminalRunState,
  isTerminalTrialState,
  TRIAL_MAX_INFRA_RETRIES,
  type AnybenchEvent,
  type RunState,
  type TrialState,
} from "@anybench/core";
import {
  createComputerRegistry,
  INFRA_COMPUTER_TAG_PREFIX,
  type ComputerRecord,
  type ComputerRegistry,
} from "@anybench/envs";
import {
  ANYBENCH_TAG_PREFIX,
  hyphenateUuid,
  parseTrialTag,
  type ComputeProvider,
  type ComputerInfo,
} from "@anybench/providers";
import { eq, inArray, or } from "drizzle-orm";
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
  /** Left alone: an `ab-` tag we cannot prove is ours (no row, no trial in this DB). */
  foreign: number;
  /** Left alone: tagged `ab-infra-*`. */
  infra: number;
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
  state: TrialState;
  attempt: number;
  runState: RunState;
  computerId: string | null;
  updatedAt: Date;
  endedAt: Date | null;
}

/**
 * Whether a trial may still be using a computer. failed_infra is not terminal: a retry may reuse
 * the computer, so it holds it while `attempt <= TRIAL_MAX_INFRA_RETRIES` and not after.
 */
export function trialHoldsComputer(t: {
  state: TrialState;
  attempt: number;
  runState: RunState;
}): boolean {
  if (isTerminalRunState(t.runState)) return false;
  if (isTerminalTrialState(t.state)) return false;
  if (t.state === "failed_infra" && t.attempt > TRIAL_MAX_INFRA_RETRIES) return false;
  return true;
}

function trialRef(info: ComputerInfo): { runId: string; trialId: string } | null {
  for (const tag of info.tags) {
    const parsed = parseTrialTag(tag);
    if (!parsed) continue;
    try {
      return { runId: hyphenateUuid(parsed.runId), trialId: hyphenateUuid(parsed.trialId) };
    } catch {
      // An ab- tag whose parts are not UUIDs (`ab-foo-bar`): not ours to interpret.
    }
  }
  return null;
}

/** Trials named by a tag, plus every trial pointing at one of these computers rows. */
async function loadTrials(
  db: Database,
  trialIds: string[],
  computerIds: string[],
): Promise<TrialLiveness[]> {
  const conds = [
    ...(trialIds.length > 0 ? [inArray(trials.id, trialIds)] : []),
    ...(computerIds.length > 0 ? [inArray(trials.computerId, computerIds)] : []),
  ];
  if (conds.length === 0) return [];
  return db
    .select({
      id: trials.id,
      runId: trials.runId,
      state: trials.state,
      attempt: trials.attempt,
      runState: runs.state,
      computerId: trials.computerId,
      updatedAt: trials.updatedAt,
      endedAt: trials.endedAt,
    })
    .from(trials)
    .innerJoin(runs, eq(runs.id, trials.runId))
    .where(or(...conds));
}

function lastActivity(
  info: ComputerInfo,
  record: ComputerRecord | null,
  related: readonly TrialLiveness[],
): Date {
  const times = [
    Date.parse(info.createdAt),
    record?.createdAt.getTime(),
    record?.lastSeenAt?.getTime(),
    ...related.flatMap((t) => [t.updatedAt.getTime(), t.endedAt?.getTime()]),
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
    foreign: 0,
    infra: 0,
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

    const candidates: {
      info: ComputerInfo;
      ref: ReturnType<typeof trialRef>;
      record: ComputerRecord | null;
    }[] = [];
    for (const info of listed) {
      if (info.tags.some((t) => t.startsWith(INFRA_COMPUTER_TAG_PREFIX))) {
        report.infra++;
        continue;
      }
      candidates.push({
        info,
        ref: trialRef(info),
        record: await registry.findByProviderId(info.id),
      });
    }
    const trialIds = [...new Set(candidates.flatMap((c) => (c.ref ? [c.ref.trialId] : [])))];
    const computerIds = candidates.flatMap((c) => (c.record ? [c.record.id] : []));
    const loaded = await loadTrials(deps.db, trialIds, computerIds);
    const byId = new Map(loaded.map((t) => [t.id, t]));

    for (const c of candidates) {
      const { info, ref } = c;
      let record = c.record;
      const named = ref ? byId.get(ref.trialId) : undefined;
      const tagTrial = named && named.runId === ref!.runId ? named : undefined;
      if (!record && !tagTrial) {
        // Not provably ours: never destroy it.
        report.foreign++;
        deps.logger?.info(
          { provider: provider.name, providerId: info.id, tags: info.tags },
          "computer.reap: ab- tagged computer with no row and no trial here; left alone",
        );
        continue;
      }
      const holders = record ? loaded.filter((t) => t.computerId === record!.id) : [];
      const tagHolds =
        tagTrial !== undefined &&
        trialHoldsComputer(tagTrial) &&
        (tagTrial.computerId === null || tagTrial.computerId === record?.id);
      if (tagHolds || holders.some(trialHoldsComputer)) {
        report.live++;
        continue;
      }
      const at = now();
      const related = [...(tagTrial ? [tagTrial] : []), ...holders];
      const idle = at.getTime() - lastActivity(info, record, related).getTime();
      if (idle <= idleMs) {
        report.recent++;
        continue;
      }

      // Only now (well past any create→update window) do we adopt a computer with no row.
      const runId = record?.runId ?? tagTrial?.runId ?? null;
      const trialId = record?.trialId ?? tagTrial?.id ?? null;
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
