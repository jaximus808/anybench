// L3 workload: deterministic inputs, sha256 recorded per trial (plan.md P2).
import { z } from "zod";
import { KitSlugSchema, KitPathSchema, KitSha256Schema } from "./kit-primitives.js";

export const WorkloadSchema = z.strictObject({
  id: KitSlugSchema,
  title: z.string().min(1).optional(),
  /** Defaults to `workloads/<id>/input/`. */
  input: KitPathSchema.optional(),
  /** Task text for agents and harnesses, e.g. `workloads/<id>/instruction.md`. */
  instruction: KitPathSchema.optional(),
  /** Prepares `EVAL_WS` before the run, e.g. `workloads/<id>/setup.sh`. */
  setup: KitPathSchema.optional(),
  /** Content hash of the input bytes, when already known. The runner records the real one per trial. */
  sha256: KitSha256Schema.optional(),
  /** Per-workload wall-clock cap; overrides the driver's. */
  timeout_s: z.int().positive().max(86_400).optional(),
  /** Free-form knobs the driver reads (rows, cols, rps, ...). */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type Workload = z.infer<typeof WorkloadSchema>;
