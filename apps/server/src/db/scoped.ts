// scopedDb(actor): the only way tenant code should touch the database (TDM-11, plan.md section 9).
//
// For a user actor every call runs in a transaction that does
//   SET LOCAL ROLE anybench_app;  set_config('app.actor_id', <user id>, true)
// anybench_app is a non-owner role (created in migration 0001), so the RLS policies on
// runs, kits, trials, reviews, reports, events and user_secrets apply even when the pool connects
// as the table owner (owners bypass RLS). A query that forgets its `where owner_id = ...` still only
// sees the actor's rows. Both settings are LOCAL, so they end with the transaction, which keeps
// this safe on Neon's PgBouncer transaction pooling.
//
// The system actor (worker, webhooks, admin jobs) skips the role switch and sees every row; it must
// name a reason so the call site is greppable.
import { UserIdSchema } from "@anybench/core";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database, type DbTx } from "./client.js";

export const APP_ROLE = "anybench_app";

export const dbActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: UserIdSchema }),
  z.object({ kind: z.literal("system"), reason: z.string().min(1) }),
]);
/** Input shape: userId may be a plain uuid string; it is parsed (and lowercased) here. */
export type DbActor = z.input<typeof dbActorSchema>;

export interface ScopedDb {
  readonly actor: z.output<typeof dbActorSchema>;
  /** Run `fn` in one transaction with the actor's RLS scope applied. */
  transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
}

export function scopedDb(actor: DbActor, database: Database = getDb()): ScopedDb {
  const parsed = dbActorSchema.parse(actor);
  return {
    actor: parsed,
    transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      return database.transaction(async (tx) => {
        if (parsed.kind === "user") {
          await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
          await tx.execute(sql`select set_config('app.actor_id', ${parsed.userId}, true)`);
        } else {
          await tx.execute(sql`select set_config('app.system_reason', ${parsed.reason}, true)`);
        }
        return fn(tx);
      });
    },
  };
}
