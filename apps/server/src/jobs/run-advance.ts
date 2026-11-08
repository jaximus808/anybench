// `run.advance` (TDM-67 stub). The API enqueues it in the same transaction that creates a run,
// passes Go, saves a kit edit or cancels (lib/job-queue.ts), with job key `runs:<run_id>:<step>`
// (`kits:<kit_id>:1` for a kit edit), so the write and its job commit together. The orchestrator ([5.9]) replaces `run`
// with the real state machine driver (ingest, agents, proof, trials, cleanup on cancel); until then
// it only logs, so enqueued jobs complete and nothing is spent.
import { z } from "zod";
import { defineJob } from "./types.js";

export const RunAdvancePayloadSchema = z.object({
  run_id: z.uuid(),
  /** Why the API woke the orchestrator. */
  reason: z.enum(["created", "go", "kit_edited", "cancelled"]),
  kit_id: z.uuid().optional(),
});
export type RunAdvancePayload = z.infer<typeof RunAdvancePayloadSchema>;

export const RUN_ADVANCE_JOB = "run.advance";

export const runAdvanceJob = defineJob({
  name: RUN_ADVANCE_JOB,
  payload: RunAdvancePayloadSchema,
  async run(payload, ctx) {
    ctx.logger.info(
      { job: RUN_ADVANCE_JOB, ...payload },
      "run.advance stub: orchestrator not built",
    );
  },
});
