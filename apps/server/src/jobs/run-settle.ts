// run.settle (worker-hardening): after an operator settle (POST /runs/:id/settle or
// scripts/ops/settle-run.ts, orchestrator/settle.ts), destroy the settled trials' computers,
// revoke their Naïve proxy keys, and wake run.advance so the run scores with the trials it has.
import type { NaiveProxyKeysApi } from "@anybench/naive";
import type { ComputeProvider } from "@anybench/providers";
import { z } from "zod";
import { computeProviderFromConfig, proxyDepsFromConfig } from "../lib/compute.js";
import { RUN_ADVANCE_JOB } from "../orchestrator/advance.js";
import { cleanupSettledTrials, RUN_SETTLE_JOB } from "../orchestrator/settle.js";
import { defineJob, type JobContext } from "./types.js";

export { RUN_SETTLE_JOB };

export interface RunSettleJobOptions {
  provider?: (ctx: JobContext) => ComputeProvider | null;
  proxyKeys?: (ctx: JobContext) => NaiveProxyKeysApi | null;
}

export function createRunSettleJob(options: RunSettleJobOptions = {}) {
  return defineJob({
    name: RUN_SETTLE_JOB,
    payload: z.object({ run_id: z.uuid() }),
    async run(payload, ctx, helpers) {
      const log = ctx.logger.child({ job: RUN_SETTLE_JOB, runId: payload.run_id });
      const out = await cleanupSettledTrials(
        {
          db: ctx.db,
          provider: (options.provider ?? ((c) => computeProviderFromConfig(c.config)))(ctx),
          proxyKeys: (options.proxyKeys ?? ((c) => proxyDepsFromConfig(c.config)?.keys ?? null))(
            ctx,
          ),
          pricePerBlockMicroUsd: ctx.config.COMPUTER_BLOCK_PRICE_MICRO_USD,
          actor: { kind: "worker", id: ctx.workerId },
          logger: log,
        },
        payload.run_id,
      );
      log.info(out, "settled trials cleaned up");
      await helpers.addJob(
        RUN_ADVANCE_JOB,
        { run_id: payload.run_id, reason: "settled" },
        { jobKey: `runs:${payload.run_id}:settle-advance` },
      );
    },
  });
}

export const runSettleJob = createRunSettleJob();
