// Cost-plus fixtures (TDM-171) on top of the TDM-87 Postgres helper: computers rows (as the TDM-31
// registry leaves them), trial -> computer pointers and run states.
import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { seedUserTdm87, type FixtureUserTdm87, type SeedOptionsTdm87 } from "./pg-tdm87.js";

export interface ComputerOptionsTdm171 {
  runId: string;
  /** The creating trial (its tag); null for a run-level (scoring) computer. */
  trialId: string | null;
  status?: string;
  cost?: bigint;
  blocks?: number;
  /** Also set trials.computer_id = this computer for the creating trial (default true). */
  point?: boolean;
}

/** Insert a computers row; by default the creating trial points at it. Returns its id. */
export async function addComputerTdm171(pool: pg.Pool, o: ComputerOptionsTdm171): Promise<string> {
  const id = randomUUID();
  const status = o.status ?? "destroyed";
  await pool.query(
    `insert into computers (id, provider, provider_id, run_id, trial_id, status, destroyed_at, blocks_billed, cost_micro_usd)
     values ($1, 'fake', $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      `fake_${randomBytes(6).toString("hex")}`,
      o.runId,
      o.trialId,
      status,
      status === "destroyed" ? new Date() : null,
      o.blocks ?? 1,
      (o.cost ?? 27_600n).toString(),
    ],
  );
  if (o.trialId !== null && (o.point ?? true)) await pointTrialTdm171(pool, o.trialId, id);
  return id;
}

export async function pointTrialTdm171(pool: pg.Pool, trialId: string, computerId: string | null) {
  await pool.query("update trials set computer_id = $1 where id = $2", [computerId, trialId]);
}

export async function setRunStateTdm171(pool: pg.Pool, runId: string, state: string) {
  await pool.query("update runs set state = $1 where id = $2", [state, runId]);
}

export async function setComputerTdm171(
  pool: pg.Pool,
  computerId: string,
  patch: { status?: string; cost?: bigint },
) {
  if (patch.status !== undefined) {
    await pool.query("update computers set status = $1 where id = $2", [patch.status, computerId]);
  }
  if (patch.cost !== undefined) {
    await pool.query("update computers set cost_micro_usd = $1 where id = $2", [
      patch.cost.toString(),
      computerId,
    ]);
  }
}

/** seedUserTdm87, with the run moved to `delivered` (or `runState`). */
export async function seedDeliveredTdm171(
  pool: pg.Pool,
  trials: number,
  options: SeedOptionsTdm87 & { runState?: string } = {},
): Promise<FixtureUserTdm87> {
  const u = await seedUserTdm87(pool, trials, options);
  await setRunStateTdm171(pool, u.runId, options.runState ?? "delivered");
  return u;
}

export interface BilledFixtureTdm171 extends FixtureUserTdm87 {
  /** computerIds[i] is trial i's destroyed computer. */
  computerIds: string[];
}

/**
 * A user with one run and `trials` trials, each with its own destroyed computer costing `cost`.
 * The run is `delivered` unless `runState` says otherwise (compute bills only terminal runs).
 */
export async function seedWithComputersTdm171(
  pool: pg.Pool,
  trials: number,
  options: SeedOptionsTdm87 & { cost?: bigint | readonly bigint[]; runState?: string } = {},
): Promise<BilledFixtureTdm171> {
  const u = await seedUserTdm87(pool, trials, options);
  await setRunStateTdm171(pool, u.runId, options.runState ?? "delivered");
  const computerIds: string[] = [];
  for (let i = 0; i < u.trialIds.length; i++) {
    const cost =
      options.cost === undefined
        ? undefined
        : typeof options.cost === "bigint"
          ? options.cost
          : options.cost[i]!;
    computerIds.push(
      await addComputerTdm171(pool, {
        runId: u.runId,
        trialId: u.trialIds[i]!,
        ...(cost === undefined ? {} : { cost }),
      }),
    );
  }
  return { ...u, computerIds };
}
