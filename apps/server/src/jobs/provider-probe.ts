// provider.probe (worker-hardening): while the provider-outage breaker is open, probe the provider
// (list computers, then a tiny create + delete) at its next probe time and close the breaker when
// the probe passes; trials and gates parked by the outage then resume on their own schedule.
// Cheap when the breaker is closed: one row read every 15 s.
import type { ComputeProvider } from "@anybench/providers";
import { z } from "zod";
import { computeProviderFromConfig } from "../lib/compute.js";
import {
  breakerConfigFrom,
  runBreakerProbe,
  type BreakerProbeDeps,
} from "../lib/provider-breaker.js";
import { defineJob, type JobContext } from "./types.js";

export const PROVIDER_PROBE_JOB = "provider.probe";
export const PROVIDER_PROBE_INTERVAL_MS = 15_000;

export interface ProviderProbeJobOptions {
  provider?: (ctx: JobContext) => ComputeProvider | null;
  probe?: BreakerProbeDeps["probe"];
}

export function createProviderProbeJob(options: ProviderProbeJobOptions = {}) {
  return defineJob({
    name: PROVIDER_PROBE_JOB,
    payload: z.object({}),
    everyMs: PROVIDER_PROBE_INTERVAL_MS,
    jobKey: () => "provider_breakers:probe",
    async run(_payload, ctx) {
      const provider = (options.provider ?? ((c) => computeProviderFromConfig(c.config)))(ctx);
      if (!provider) return;
      await runBreakerProbe({
        db: ctx.db,
        provider,
        config: breakerConfigFrom(ctx.config),
        logger: ctx.logger.child({ job: PROVIDER_PROBE_JOB }),
        ...(options.probe ? { probe: options.probe } : {}),
      });
    },
  });
}

export const providerProbeJob = createProviderProbeJob();
