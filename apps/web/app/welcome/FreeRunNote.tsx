// The free starter run line (TDM-224) for onboarding (/welcome) and billing: the billing summary's
// `free_run` in words, and the starter limits while it is available.
import type { FreeRunStatus } from "@anybench/core";
import Link from "next/link";
import { usd } from "../../components/live/format";

/** The free-run line for onboarding and billing: what it is, and the starter limits. */
export function FreeRunNote({ free }: { free: FreeRunStatus }) {
  return (
    <div data-slot="free-run" data-status={free.status}>
      <p role="status">{free.message}</p>
      {free.status === "available" ? (
        <p className="muted">
          A free run compares up to {free.limits.max_setups} setups in up to{" "}
          {free.limits.max_trials} trials, with up to {usd(free.limits.compute_cap_micro_usd, 0)} of
          compute on us. Your agent runs on your own model key.
        </p>
      ) : null}
      {free.run_id && free.status === "in_use" ? (
        <p>
          <Link href={`/runs/${free.run_id}`}>Open your free run</Link>
        </p>
      ) : null}
    </div>
  );
}
