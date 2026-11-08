// The run gate's 402 links here (`<web>/settings/billing?run=<id>`, apps/server lib/billing-gate.ts);
// the billing page lives at /billing. Keep only `run`, so nothing else rides along.
import { RunIdSchema } from "@anybench/core";
import { redirect } from "next/navigation";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SettingsBillingRedirect({ searchParams }: Props) {
  const run = RunIdSchema.safeParse((await searchParams).run);
  redirect(run.success ? `/billing?run=${run.data}` : "/billing");
}
