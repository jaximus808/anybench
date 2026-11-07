// The event writer, reader and LISTEN fanout (TDM-72, plan.md section 6, ticket 8.1).
//
// appendEvents(db, runId, events)
//   - Validates every event with the core AnybenchEvent union, redacts it (core createRedactor:
//     known key patterns, plus the exact secrets a caller passes in `options.secrets`), re-validates
//     the redacted event and inserts it.
//   - The writer is authoritative for `run_id` and `seq`: a run's seqs come from `runs.next_seq`,
//     bumped by one UPDATE in the same transaction as the INSERT. The UPDATE row-locks the run until
//     commit, so per run, commit order == seq order: a reader that has seen seq N never later finds
//     a new row with seq < N. Polling `seq > after` therefore never skips an event.
//   - `owner_id` is copied from the run. Events with no run get owner_id NULL (invisible to
//     tenants) and take their seq from the events.id sequence, so they are ordered too.
//   - `pg_notify('anybench_events', '<run_id>:<last_seq>')` runs inside the same transaction.
//     Postgres delivers a NOTIFY only when that transaction commits (never on rollback), so
//     listeners hear about rows they can already read. One notification per call, for the last seq.
//     Runless events are not notified (no stream serves them). NOTIFY is fine through PgBouncer
//     transaction pooling; only LISTEN needs the direct URL.
//   - Pass a transaction to make the events part of a larger write (e.g. a run state change):
//     the seqs, rows and the notification then commit or roll back with it.
//
// readEvents(db, runId, {after, limit})
//   One page of a run's events with seq > after, oldest first, parsed back into AnybenchEvents.
//   Tenant code passes a scopedDb transaction so RLS limits it to the actor's runs.
//
// EventFanout
//   One shared LISTEN connection on DATABASE_URL_DIRECT for a long-lived process (local Node API,
//   worker). Open streams subscribe per run and are woken on each notification. It reconnects with
//   backoff and wakes every subscriber after a reconnect, since notifications sent while it was
//   down are lost. Never used on Vercel Functions (no long-held connections there).
import {
  AnybenchEventSchema,
  createRedactor,
  encodeAnybenchEvent,
  EventActorSchema,
  formatSchemaIssues,
  redactJson,
  type AnybenchEvent,
  type AnybenchEventType,
  type EventActor,
  type EventSeverity,
  type EventSource,
  type Redactor,
  type RunId,
  type SecretsInScope,
  type TrialId,
} from "@anybench/core";
import { and, asc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import pg from "pg";
import type { Database, DbTx } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { runs } from "../db/schema/runs.js";
import type { Logger } from "./logger.js";

/** A pooled Drizzle database (`deps.db`). */
export type Db = Database;
/** A transaction handle (`db.transaction(tx => ...)`, `scopedDb(...).transaction(tx => ...)`). */
export type Tx = DbTx;

/** The NOTIFY channel. Payload: `<run_id>:<last_seq>`. */
export const EVENTS_CHANNEL = "anybench_events";

/** Rows per INSERT statement (10 params each, far below Postgres' 65535 limit). */
const INSERT_CHUNK = 500;

export class RunNotFoundError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`run ${runId} does not exist`);
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

/** An event that fails the AnybenchEvent union, before or after redaction. Nothing was written. */
export class EventValidationError extends Error {
  readonly index: number;
  readonly issues: string[];
  constructor(index: number, issues: string[], stage: "input" | "redacted") {
    super(
      `event ${index} is not a valid AnybenchEvent${stage === "redacted" ? " after redaction" : ""}: ${issues.join("; ")}`,
    );
    this.name = "EventValidationError";
    this.index = index;
    this.issues = issues;
  }
}

export interface AppendEventsOptions {
  /** Exact secrets in scope (e.g. the trial's env), redacted by name on top of the key patterns. */
  secrets?: SecretsInScope;
  /** A precompiled redactor (wins over `secrets`); use one per trial on hot ingest paths. */
  redactor?: Redactor;
}

/** The text form of a NOTIFY payload. */
export function formatEventNotification(runId: string, seq: number): string {
  return `${runId}:${seq}`;
}

/** Parse a NOTIFY payload; undefined when it is not `<uuid>:<seq>`. */
export function parseEventNotification(
  payload: string,
): { runId: string; seq: number } | undefined {
  const m = /^([0-9a-f-]{36}):(\d+)$/i.exec(payload);
  if (!m) return undefined;
  return { runId: m[1]!.toLowerCase(), seq: Number(m[2]) };
}

function redactEvent(raw: unknown, index: number, redactor: Redactor): AnybenchEvent {
  const input = AnybenchEventSchema.safeParse(raw);
  if (!input.success) {
    throw new EventValidationError(index, formatSchemaIssues(input.error), "input");
  }
  const encoded = encodeAnybenchEvent(input.data) as Record<string, unknown>;
  // Redact what a producer controls: payload, actor and source_id. type/source/seq/at are fixed
  // shapes the schema already checked.
  const redacted = {
    ...encoded,
    payload: redactJson(encoded.payload, redactor),
    actor: redactJson(encoded.actor, redactor),
    source_id: typeof encoded.source_id === "string" ? redactor(encoded.source_id) : null,
  };
  const out = AnybenchEventSchema.safeParse(redacted);
  if (!out.success) {
    throw new EventValidationError(index, formatSchemaIssues(out.error), "redacted");
  }
  return out.data;
}

type EventRow = typeof events.$inferInsert;

function toRow(ev: AnybenchEvent, ownerId: string | null, id?: number): EventRow {
  const encoded = encodeAnybenchEvent(ev);
  return {
    ...(id === undefined ? {} : { id }),
    ownerId,
    runId: ev.run_id,
    seq: ev.seq,
    source: ev.source,
    sourceId: ev.source_id,
    type: ev.type,
    severity: ev.severity,
    actor: JSON.stringify(ev.actor),
    payload: encoded.payload,
    costDeltaMicroUsd: ev.cost_delta_micro_usd,
    at: new Date(ev.at),
  };
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  return (result as { rows: Record<string, unknown>[] }).rows;
}

/**
 * Append events to a run (or, with runId null, to the account-level stream). Assigns seqs from
 * runs.next_seq in the same transaction, redacts before insert and NOTIFYs on commit.
 * Returns the seq range written; `{firstSeq: 0, lastSeq: 0}` for an empty list.
 * Throws EventValidationError (nothing written) or RunNotFoundError.
 */
export async function appendEvents(
  db: Db | Tx,
  runId: RunId | null,
  evs: AnybenchEvent[],
  options: AppendEventsOptions = {},
): Promise<{ firstSeq: number; lastSeq: number }> {
  if (evs.length === 0) return { firstSeq: 0, lastSeq: 0 };
  const redactor = options.redactor ?? createRedactor(options.secrets ?? {});
  // Validate and redact everything before touching the database: one bad event writes nothing.
  const clean = evs.map((ev, i) => redactEvent(ev, i, redactor));
  const n = clean.length;

  // On a Database this opens the transaction; on a Tx it is a savepoint inside the caller's
  // transaction, so the rows and the NOTIFY commit (or roll back) with the caller.
  return db.transaction(async (tx) => {
    let firstSeq: number;
    let ownerId: string | null;
    let ids: number[] | undefined;
    if (runId !== null) {
      const res = rowsOf(
        await tx.execute(sql`
          update ${runs} set next_seq = next_seq + ${n}
          where id = ${runId}
          returning next_seq - ${n} as first_seq, owner_id`),
      );
      const row = res[0];
      if (!row) throw new RunNotFoundError(runId);
      firstSeq = Number(row.first_seq);
      ownerId = String(row.owner_id);
    } else {
      const res = rowsOf(
        await tx.execute(
          sql`select nextval(pg_get_serial_sequence('events', 'id'))::bigint as v from generate_series(1, ${n})`,
        ),
      );
      ids = res.map((r) => Number(r.v)).sort((a, b) => a - b);
      firstSeq = ids[0]!;
      ownerId = null;
    }

    const rows = clean.map((ev, i) => {
      const seq = ids ? ids[i]! : firstSeq + i;
      return toRow({ ...ev, run_id: runId, seq }, ownerId, ids ? seq : undefined);
    });
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(events).values(rows.slice(i, i + INSERT_CHUNK));
    }
    const lastSeq = rows[rows.length - 1]!.seq;
    if (runId !== null) {
      await tx.execute(
        sql`select pg_notify(${EVENTS_CHANNEL}, ${formatEventNotification(runId, lastSeq)})`,
      );
    }
    return { firstSeq: rows[0]!.seq, lastSeq };
  });
}

export interface ReadEventsOptions {
  /** Only seq > after. Default 0. */
  after?: number;
  /** Page size. Default 200. */
  limit?: number;
  types?: readonly AnybenchEventType[];
  sources?: readonly EventSource[];
  severities?: readonly EventSeverity[];
  /** Events whose source_id is the trial, or whose payload names it (`payload.trial_id`). */
  trialId?: TrialId | string;
}

function parseActor(text: string | null): EventActor {
  if (text) {
    try {
      const parsed = EventActorSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through: rows written outside the writer may hold a bare string
    }
  }
  return { kind: "system" };
}

function fromRow(row: typeof events.$inferSelect): AnybenchEvent {
  return AnybenchEventSchema.parse({
    run_id: row.runId,
    seq: row.seq,
    source: row.source,
    source_id: row.sourceId,
    type: row.type,
    severity: row.severity,
    actor: parseActor(row.actor),
    payload: row.payload,
    cost_delta_micro_usd: row.costDeltaMicroUsd,
    at: row.at.toISOString(),
  });
}

/** A page of events with seq > after, oldest first. runId null reads the runless stream. */
export async function readEvents(
  db: Db | Tx,
  runId: RunId | null,
  options: ReadEventsOptions = {},
): Promise<AnybenchEvent[]> {
  const after = options.after ?? 0;
  const limit = options.limit ?? 200;
  const where: (SQL | undefined)[] = [
    runId === null ? isNull(events.runId) : eq(events.runId, runId),
    gt(events.seq, after),
  ];
  if (options.types?.length) where.push(inArray(events.type, [...options.types]));
  if (options.sources?.length) where.push(inArray(events.source, [...options.sources]));
  if (options.severities?.length) where.push(inArray(events.severity, [...options.severities]));
  if (options.trialId) {
    where.push(
      or(
        eq(events.sourceId, options.trialId),
        sql`${events.payload}->>'trial_id' = ${options.trialId}`,
      ),
    );
  }
  const rows = await db
    .select()
    .from(events)
    .where(and(...where))
    .orderBy(asc(events.seq))
    .limit(limit);
  return rows.map(fromRow);
}

// ---------------------------------------------------------------------------------------------
// LISTEN fanout (long-lived processes only)

/** Called with the notified last seq, or Infinity after a reconnect ("re-check, you may have missed some"). */
export type EventWakeListener = (seq: number) => void;

export interface EventFanoutOptions {
  /** The DIRECT (unpooled) URL: LISTEN does not survive PgBouncer transaction pooling. */
  url: string;
  logger?: Pick<Logger, "info" | "warn" | "error">;
  /** First reconnect delay; doubles up to 30 s. Default 500 ms. */
  reconnectMs?: number;
}

export class EventFanout {
  readonly #url: string;
  readonly #logger: EventFanoutOptions["logger"];
  readonly #baseDelay: number;
  readonly #subs = new Map<string, Set<EventWakeListener>>();
  #client: pg.Client | undefined;
  #closed = false;
  #delay: number;
  #timer: NodeJS.Timeout | undefined;
  #everConnected = false;
  #ready: Promise<void>;
  #resolveReady!: () => void;

  constructor(options: EventFanoutOptions) {
    this.#url = options.url;
    this.#logger = options.logger;
    this.#baseDelay = options.reconnectMs ?? 500;
    this.#delay = this.#baseDelay;
    this.#ready = new Promise((resolve) => (this.#resolveReady = resolve));
  }

  /** Start connecting (retries forever with backoff). Await `ready()` for the first LISTEN. */
  start(): this {
    if (!this.#client && !this.#timer && !this.#closed) void this.#connect();
    return this;
  }

  /** Resolves once the first LISTEN is active. */
  ready(): Promise<void> {
    return this.#ready;
  }

  get listening(): boolean {
    return this.#client !== undefined;
  }

  /** Wake `listener` on every notification for `runId`. Returns the unsubscribe function. */
  subscribe(runId: string, listener: EventWakeListener): () => void {
    const key = runId.toLowerCase();
    let set = this.#subs.get(key);
    if (!set) this.#subs.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      const s = this.#subs.get(key);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.#subs.delete(key);
    };
  }

  /** Open subscriptions (all runs). */
  get subscriberCount(): number {
    let n = 0;
    for (const s of this.#subs.values()) n += s.size;
    return n;
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const c = this.#client;
    this.#client = undefined;
    await c?.end().catch(() => {});
  }

  #wake(runId: string, seq: number): void {
    const set = this.#subs.get(runId);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(seq);
      } catch (err) {
        this.#logger?.error({ err }, "events fanout: listener threw");
      }
    }
  }

  #wakeAll(): void {
    for (const runId of [...this.#subs.keys()]) this.#wake(runId, Number.POSITIVE_INFINITY);
  }

  async #connect(): Promise<void> {
    this.#timer = undefined;
    if (this.#closed) return;
    const client = new pg.Client({ connectionString: this.#url, keepAlive: true });
    let dropped = false;
    const drop = (err?: unknown) => {
      if (dropped) return;
      dropped = true;
      if (this.#client === client) this.#client = undefined;
      client.removeAllListeners("notification");
      void client.end().catch(() => {});
      if (this.#closed) return;
      this.#logger?.warn({ err, retryMs: this.#delay }, "events fanout: LISTEN connection lost");
      this.#schedule();
    };
    client.on("error", drop);
    client.on("end", () => drop());
    client.on("notification", (msg) => {
      if (msg.channel !== EVENTS_CHANNEL || !msg.payload) return;
      const n = parseEventNotification(msg.payload);
      if (n) this.#wake(n.runId, n.seq);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    } catch (err) {
      drop(err);
      return;
    }
    if (this.#closed || dropped) {
      void client.end().catch(() => {});
      return;
    }
    this.#client = client;
    this.#delay = this.#baseDelay;
    const reconnected = this.#everConnected;
    this.#everConnected = true;
    this.#logger?.info({ channel: EVENTS_CHANNEL }, "events fanout: listening");
    this.#resolveReady();
    // Anything notified while we were down is lost: make every open stream re-read the table.
    if (reconnected) this.#wakeAll();
  }

  #schedule(): void {
    if (this.#closed || this.#timer) return;
    const delay = this.#delay;
    this.#delay = Math.min(this.#delay * 2, 30_000);
    this.#timer = setTimeout(() => void this.#connect(), delay);
    this.#timer.unref?.();
  }
}
