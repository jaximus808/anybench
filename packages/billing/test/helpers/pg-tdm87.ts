// Local Postgres fixture for the ledger tests (TDM-87): a fresh database per test file, migrated
// with apps/server/drizzle (the schema owner, TDM-11). Read by path, not imported, because
// apps/server depends on this package. LOCAL_DATABASE_URL from docker-compose.dev.yml (55432).
// Without a reachable Postgres the suites skip, unless ANYBENCH_REQUIRE_DB=1 (CI), then they fail.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export const LOCAL_URL_TDM87 =
  process.env.LOCAL_DATABASE_URL || "postgres://anybench:anybench@localhost:55432/anybench";
export const REQUIRE_DB_TDM87 = process.env.ANYBENCH_REQUIRE_DB === "1";
export const MIGRATIONS_FOLDER_TDM87 = fileURLToPath(
  new URL("../../../../apps/server/drizzle", import.meta.url),
);

export async function pgAvailableTdm87(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: LOCAL_URL_TDM87,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch (err) {
    if (REQUIRE_DB_TDM87) throw err;
    console.warn(`[billing db tests] skipped: no Postgres at LOCAL_DATABASE_URL: ${String(err)}`);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

export interface FreshDbTdm87 {
  db: NodePgDatabase;
  pool: pg.Pool;
  url: string;
  drop(): Promise<void>;
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: LOCAL_URL_TDM87 });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function freshMigratedDbTdm87(options: { max?: number } = {}): Promise<FreshDbTdm87> {
  const name = `anybench_tdm87_${randomBytes(6).toString("hex")}`;
  await admin((c) => c.query(`create database "${name}"`));
  const u = new URL(LOCAL_URL_TDM87);
  u.pathname = `/${name}`;
  const url = u.toString();
  const migratePool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(migratePool), { migrationsFolder: MIGRATIONS_FOLDER_TDM87 });
  } finally {
    await migratePool.end();
  }
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 });
  return {
    db: drizzle(pool),
    pool,
    url,
    async drop() {
      await pool.end();
      await admin((c) => c.query(`drop database if exists "${name}" with (force)`));
    },
  };
}

export interface FixtureUserTdm87 {
  userId: string;
  runId: string;
  trialIds: string[];
  /** An interventions row about runId, for comped entries. */
  interventionId: string;
  /** An interventions row about userId, for admin grants. */
  userInterventionId: string;
}

let seq = 0;

export interface SeedOptionsTdm87 {
  /** Stored state of each trial (default "done"); trial i uses states[i % states.length]. */
  states?: readonly string[];
  /** Comp the run (runs.comped_by + comp_intervention_id), as the admin comp action would. */
  comped?: boolean;
}

/** A user with one run, `trials` trials and the intervention rows comps and admin grants need. */
export async function seedUserTdm87(
  pool: pg.Pool,
  trials = 4,
  options: SeedOptionsTdm87 = {},
): Promise<FixtureUserTdm87> {
  const states = options.states?.length ? options.states : ["done"];
  const n = ++seq;
  const login = `tdm87_${randomBytes(4).toString("hex")}_${n}`;
  const c = await pool.connect();
  try {
    const user = await c.query<{ id: string }>(
      "insert into users (github_login, github_id) values ($1, $2) returning id",
      [login, Math.floor(Math.random() * 1e12) + n],
    );
    const userId = user.rows[0]!.id;
    const run = await c.query<{ id: string }>(
      "insert into runs (owner_id, question, budget_micro_usd) values ($1, 'q', 100000000) returning id",
      [userId],
    );
    const runId = run.rows[0]!.id;
    const contender = await c.query<{ id: string }>(
      "insert into contenders (run_id, source, role) values ($1, 'gh:x/y', 'candidate') returning id",
      [runId],
    );
    const trialIds: string[] = [];
    for (let i = 0; i < trials; i++) {
      const t = await c.query<{ id: string }>(
        "insert into trials (owner_id, run_id, contender_id, workload_id, repeat, state) values ($1, $2, $3, 'w', $4, $5) returning id",
        [userId, runId, contender.rows[0]!.id, i, states[i % states.length]],
      );
      trialIds.push(t.rows[0]!.id);
    }
    const iv = await c.query<{ id: string }>(
      "insert into interventions (run_id, user_id, who, what, why) values ($1, $2, 'jaxon', 'comp', 'test') returning id",
      [runId, userId],
    );
    if (options.comped) {
      await c.query(
        "update runs set comped_by = 'jaxon', comped_reason = 'test', comp_intervention_id = $1 where id = $2",
        [iv.rows[0]!.id, runId],
      );
    }
    const uiv = await c.query<{ id: string }>(
      "insert into interventions (user_id, who, what, why) values ($1, 'jaxon', 'grant', 'test') returning id",
      [userId],
    );
    return {
      userId,
      runId,
      trialIds,
      interventionId: iv.rows[0]!.id,
      userInterventionId: uiv.rows[0]!.id,
    };
  } finally {
    c.release();
  }
}

/** Overwrite a trial's stored state (the ledger must trust this, not the caller). */
export async function setTrialStateTdm87(pool: pg.Pool, trialId: string, state: string) {
  await pool.query("update trials set state = $1 where id = $2", [state, trialId]);
}
