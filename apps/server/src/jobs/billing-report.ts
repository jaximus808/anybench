// billing.report (stripe-onboarding, plan.md section 8 / ticket 10.5): every minute, send the
// ledger's unreported usage entries to the Stripe meter (lib/stripe-billing.ts reportUsageToStripe).
// Only entries the ledger recorded are sent, so its rules hold here too: nothing for a run our
// pipeline failed, compute but no run fee for a user cancel, nothing for a comped (founder demo)
// run. Idempotent: the meter dedupes on identifier = usage entry id, and an entry is marked
// reported only after Stripe accepted it. No Stripe on this deployment (BILLING_MODE=off, no test
// key, or live before 10.11) = the job does nothing.
import { z } from "zod";
import { reportUsageToStripe, stripeBillingFromConfig } from "../lib/stripe-billing.js";
import { defineJob } from "./types.js";

export const BILLING_REPORT_JOB = "billing.report";

export const billingReportJob = defineJob({
  name: BILLING_REPORT_JOB,
  payload: z.object({}).passthrough(),
  // Not `cron`: graphile crontab task names cannot contain a dot.
  everyMs: 60_000,
  jobKey: () => "billing:report",
  async run(_payload, ctx) {
    const port = stripeBillingFromConfig(ctx.config);
    if (!port) return;
    const report = await reportUsageToStripe(ctx.db, port, { logger: ctx.logger });
    if (report.sent + report.duplicate + report.zero + report.failed > 0) {
      ctx.logger.info({ report }, "billing.report: usage sent to the Stripe meter");
    }
  },
});
