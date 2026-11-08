// KitSpec → scheduler input (TDM-159). The scheduler (scheduler.ts) plans over the small
// `SchedulableKit` shape; this maps a validated KitSpec onto it so `expandTrials` runs on a real kit.
//
// Packing rules (cli/lib/service only, needs est_trial_seconds) are enforced by KitSpecSchema, so a
// kit that parsed is already safe to pack. When the kit gives no `est_trial_seconds` (packing off),
// the estimate falls back to the largest declared wall-clock cap (workload `timeout_s` or driver
// `wall_clock_cap_s`), then to the billing block: with packing off it does not change the plan.
import type { KitSpec } from "@anybench/core";
import { SchedulableKitSchema, type ExpandTrialsInput, type SchedulableKit } from "./scheduler.js";

/** Per-trial wall-time estimate for a kit, in whole seconds. */
export function estTrialSecondsFromKit(kit: KitSpec): number {
  if (kit.schedule.est_trial_seconds !== undefined) return kit.schedule.est_trial_seconds;
  const caps = [
    ...kit.workloads.map((w) => w.timeout_s),
    ...kit.contenders.map((c) => c.driver.wall_clock_cap_s),
  ].filter((s): s is number => s !== undefined);
  return caps.length > 0 ? Math.max(...caps) : kit.schedule.block_seconds;
}

/** The part of a KitSpec the scheduler needs, contenders and workloads in kit order. */
export function schedulableFromKit(kit: KitSpec): SchedulableKit {
  return SchedulableKitSchema.parse({
    contenders: kit.contenders.map((c) => c.id),
    workloads: kit.workloads.map((w) => w.id),
    repeats: kit.repeats,
    warmups: kit.schedule.warmups,
    est_trial_seconds: estTrialSecondsFromKit(kit),
    packing: kit.schedule.packing,
    ...(kit.schedule.order_seed === undefined ? {} : { order_seed: kit.schedule.order_seed }),
  });
}

/** Full `expandTrials` input for a run of this kit, carrying the kit's billing block. */
export function expandTrialsInputFromKit(run_id: string, kit: KitSpec): ExpandTrialsInput {
  return { run_id, kit: schedulableFromKit(kit), block_seconds: kit.schedule.block_seconds };
}
