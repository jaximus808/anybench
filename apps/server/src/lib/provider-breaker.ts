// The provider-outage circuit breaker on Postgres (worker-hardening). One `provider_breakers` row
// per compute provider is the shared state every job and worker process reads; the transitions
// are packages/bench breaker.ts, applied under a row lock.
//
//   dbLaunchBreaker(db, provider)   the LaunchBreaker trial.execute (through the executor) and
//                                   trial.gate check before each create / fork / mint.
//   probeProvider(provider)         the cheap health probe: list computers, then a tiny create +
//                                   destroy (tag `ab-infra-probe`, which the reaper never touches;
//                                   a probe computer a failed destroy left behind is destroyed by
//                                   the next probe).
//   runBreakerProbe(...)            provider.probe (every 15 s): when the breaker is open and its
//                                   next probe is due, probe, and close it if the probe passed.
//
// When the breaker opens or closes, a `provider.outage` event goes to every run with unfinished
// trials, so the live page can say "Naïve is having an outage; trials paused, nothing billed".
import {
  breakerOnFailure,
  breakerOnProbe,
  breakerOnSuccess,
  CLOSED_BREAKER,
  DEFAULT_BREAKER_CONFIG,
  outageMessage,
  recoveredMessage,
  type BreakerConfig,
  type BreakerState,
  type LaunchBreaker,
} from "@anybench/bench";
import { AnybenchEventSchema, RunIdSchema, type EventActor } from "@anybench/core";
import type { ComputeProvider } from "@anybench/providers";
import { eq, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Database, DbTx } from "../db/client.js";
import { providerBreakers } from "../db/schema/provider_breakers.js";
import { appendEvents } from "./events.js";

/** Tag on the probe's computer; `ab-infra-*` is never touched by the reaper. */
export const PROBE_COMPUTER_TAG = "ab-infra-probe";

type Row = typeof providerBreakers.$inferSelect;

function toState(r: Row | undefined): BreakerState {
  if (!r) return { ...CLOSED_BREAKER };
  return {
    status: r.status,
    failures: r.failures,
    windowStartedAt: r.windowStartedAt?.getTime() ?? null,
    openedAt: r.openedAt?.getTime() ?? null,
    nextProbeAt: r.nextProbeAt?.getTime() ?? null,
    lastError: r.lastError,
  };
}

function toColumns(s: BreakerState) {
  const d = (ms: number | null) => (ms === null ? null : new Date(ms));
  return {
    status: s.status,
    failures: s.failures,
    windowStartedAt: d(s.windowStartedAt),
    openedAt: d(s.openedAt),
    nextProbeAt: d(s.nextProbeAt),
    lastError: s.lastError === null ? null : s.lastError.slice(0, 2000),
    updatedAt: new Date(),
  };
}

export function breakerConfigFrom(
  config: Partial<
    Pick<
      Config,
      "PROVIDER_BREAKER_THRESHOLD" | "PROVIDER_BREAKER_WINDOW_MS" | "PROVIDER_BREAKER_PROBE_MS"
    >
  >,
): BreakerConfig {
  return {
    threshold: config.PROVIDER_BREAKER_THRESHOLD ?? DEFAULT_BREAKER_CONFIG.threshold,
    windowMs: config.PROVIDER_BREAKER_WINDOW_MS ?? DEFAULT_BREAKER_CONFIG.windowMs,
    probeIntervalMs: config.PROVIDER_BREAKER_PROBE_MS ?? DEFAULT_BREAKER_CONFIG.probeIntervalMs,
  };
}

/** Read the breaker (closed when there is no row yet). */
export async function readBreaker(db: Database | DbTx, provider: string): Promise<BreakerState> {
  const [r] = await db
    .select()
    .from(providerBreakers)
    .where(eq(providerBreakers.provider, provider));
  return toState(r);
}

/** Apply `step` to the breaker row under a lock; returns the before and after states. */
async function updateBreaker(
  db: Database,
  provider: string,
  step: (s: BreakerState) => BreakerState,
): Promise<{ before: BreakerState; after: BreakerState }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(providerBreakers)
      .values({ provider })
      .onConflictDoNothing({ target: providerBreakers.provider });
    const [r] = await tx
      .select()
      .from(providerBreakers)
      .where(eq(providerBreakers.provider, provider))
      .for("update");
    const before = toState(r);
    const after = step(before);
    if (after !== before) {
      await tx
        .update(providerBreakers)
        .set(toColumns(after))
        .where(eq(providerBreakers.provider, provider));
    }
    if (before.status !== after.status) await announce(tx, provider, after);
    return { before, after };
  });
}

/** A `provider.outage` event on every run with unfinished trials. */
async function announce(tx: DbTx, provider: string, s: BreakerState): Promise<void> {
  const res = await tx.execute(sql`
    select distinct run_id from trials
    where state not in ('done', 'failed_subject', 'cancelled')`);
  const runIds = (res as unknown as { rows: { run_id: string }[] }).rows.map((r) => r.run_id);
  const actor: EventActor = { kind: "system" };
  const at = new Date().toISOString();
  for (const runId of runIds) {
    const run = RunIdSchema.parse(runId);
    await appendEvents(tx, run, [
      AnybenchEventSchema.parse({
        run_id: run,
        seq: 0,
        type: "provider.outage",
        source: "system",
        source_id: null,
        severity: s.status === "open" ? "warn" : "info",
        actor,
        cost_delta_micro_usd: 0n,
        at,
        payload: {
          provider,
          status: s.status,
          message: s.status === "open" ? outageMessage(provider) : recoveredMessage(provider),
          last_error: s.lastError,
          next_probe_at: s.nextProbeAt === null ? null : new Date(s.nextProbeAt).toISOString(),
        },
      }),
    ]);
  }
}

export interface DbLaunchBreakerOptions {
  config?: BreakerConfig;
  now?: () => number;
  logger?: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

/** The shared LaunchBreaker for one provider. */
export function dbLaunchBreaker(
  db: Database,
  provider: string,
  options: DbLaunchBreakerOptions = {},
): LaunchBreaker {
  const cfg = options.config ?? DEFAULT_BREAKER_CONFIG;
  const now = options.now ?? Date.now;
  return {
    async blockedUntil() {
      const s = await readBreaker(db, provider);
      return s.status === "open" ? Math.max(s.nextProbeAt ?? now(), now()) : null;
    },
    async recordFailure(op, err) {
      const message = `${op}: ${err instanceof Error ? err.message : String(err)}`;
      const { before, after } = await updateBreaker(
        db,
        provider,
        (s) => breakerOnFailure(s, now(), message, cfg).state,
      );
      if (before.status === "closed" && after.status === "open") {
        options.logger?.warn(
          { provider, failures: after.failures, lastError: after.lastError },
          "provider outage: breaker OPEN, launches paused",
        );
      }
      return after;
    },
    async recordSuccess() {
      // Cheap read first: almost every success finds a clean closed breaker.
      const s = await readBreaker(db, provider);
      if (s.status === "closed" && s.failures === 0) return;
      await updateBreaker(db, provider, breakerOnSuccess);
    },
  };
}

/**
 * The health probe: list computers, then a tiny create + destroy (1 vCPU, 1 GiB, 5 GB disk; the
 * create answering is what failed in the outage, so we do not wait for it to boot). Throws on any
 * failure.
 */
export async function probeProvider(provider: ComputeProvider): Promise<void> {
  const leftovers = await provider.list({ tag: PROBE_COMPUTER_TAG });
  for (const c of leftovers) await provider.destroy(c.id).catch(() => undefined);
  const created = await provider.create({
    name: "anybench-health-probe",
    vcpu: 1,
    memoryMb: 1024,
    diskGb: 5,
    tags: [PROBE_COMPUTER_TAG],
  });
  await provider.destroy(created.id);
}

export interface BreakerProbeDeps {
  db: Database;
  provider: ComputeProvider;
  config?: BreakerConfig;
  now?: () => number;
  /** Default probeProvider. */
  probe?: (provider: ComputeProvider) => Promise<void>;
  logger?: DbLaunchBreakerOptions["logger"];
}

export type BreakerProbeResult = "closed_already" | "not_due" | "passed" | "failed";

/** One provider.probe tick. */
export async function runBreakerProbe(deps: BreakerProbeDeps): Promise<BreakerProbeResult> {
  const now = deps.now ?? Date.now;
  const name = deps.provider.name;
  const s = await readBreaker(deps.db, name);
  if (s.status !== "open") return "closed_already";
  if (s.nextProbeAt !== null && s.nextProbeAt > now()) return "not_due";
  let error: string | null = null;
  try {
    await (deps.probe ?? probeProvider)(deps.provider);
  } catch (err) {
    error = `probe: ${err instanceof Error ? err.message : String(err)}`;
  }
  const cfg = deps.config ?? DEFAULT_BREAKER_CONFIG;
  await updateBreaker(
    deps.db,
    name,
    (cur) => breakerOnProbe(cur, now(), error === null, error, cfg).state,
  );
  if (error === null) {
    deps.logger?.info({ provider: name }, "provider outage over: probe passed, breaker CLOSED");
    return "passed";
  }
  deps.logger?.warn({ provider: name, error }, "provider still failing: breaker stays open");
  return "failed";
}
