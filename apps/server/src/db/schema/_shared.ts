// Column helpers shared by every table file (TDM-11).
import { sql, type SQL } from "drizzle-orm";
import { bigint, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * uuid primary key, defaulting to gen_random_uuid(). Prefer passing `newId(XIdSchema)` from
 * @anybench/core (UUIDv7, sorts by creation time). Schema files must not import workspace
 * packages: drizzle-kit loads them through CJS require and @anybench/* are ESM-only.
 */
export const idPk = () => uuid("id").primaryKey().defaultRandom();

/** Integer micro-USD. Always `bigint` in Postgres and `bigint` in TypeScript: never a float. */
export const microUsd = (name: string) => bigint(name, { mode: "bigint" });

/** Same as microUsd but NOT NULL DEFAULT 0. */
export const microUsdZero = (name: string) =>
  bigint(name, { mode: "bigint" })
    .notNull()
    .default(sql`0`);

export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const createdAt = () => tstz("created_at").notNull().defaultNow();
export const updatedAt = () => tstz("updated_at").notNull().defaultNow();

/** SQL `col IN ('a','b',...)` for CHECK constraints on text enums. */
export function inList(column: { name: string }, values: readonly string[]): SQL {
  return sql`${sql.identifier(column.name)} in (${sql.join(
    values.map((v) => sql.raw(`'${v.replace(/'/g, "''")}'`)),
    sql`, `,
  )})`;
}
