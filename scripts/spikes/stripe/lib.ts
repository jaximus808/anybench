// TDM-21 Stripe spike: shared client + call log. TEST MODE ONLY.
//
// The key comes from the environment (run with `node --env-file=<repo>/.env ...`). It is never
// printed, logged or passed on a command line. Anything but an sk_test_/rk_test_ key is refused.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Stripe from "stripe";
import { z } from "zod";

const SpikeEnvSchema = z.object({
  STRIPE_TEST_SECRET_KEY: z
    .string()
    .regex(
      /^(sk|rk)_test_[A-Za-z0-9]+$/,
      "must be a TEST key (sk_test_ or rk_test_); live mode is refused",
    ),
  SPIKE_OUT_DIR: z.string().min(1).optional(),
});

export interface CallLogEntry {
  method: string;
  path: string;
  status: number;
  request_id: string;
  elapsed_ms: number;
  idempotency_key?: string;
}

export interface SpikeContext {
  stripe: Stripe;
  calls: CallLogEntry[];
  outDir: string;
  /** Write `<name>.json` (pretty) into the output dir and return its path. */
  save(name: string, data: unknown): string;
}

export function createSpikeContext(): SpikeContext {
  const parsed = SpikeEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Never echo the value: only the issue messages.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`refusing to run: ${issues}`);
  }
  const stripe = new Stripe(parsed.data.STRIPE_TEST_SECRET_KEY, {
    maxNetworkRetries: 2,
    appInfo: { name: "anybench-spike-tdm21" },
  });
  const calls: CallLogEntry[] = [];
  stripe.on("response", (e: Stripe.ResponseEvent) => {
    calls.push({
      method: e.method,
      path: e.path,
      status: e.status,
      request_id: e.request_id,
      elapsed_ms: e.elapsed,
      ...(e.idempotency_key ? { idempotency_key: e.idempotency_key } : {}),
    });
  });
  const outDir = parsed.data.SPIKE_OUT_DIR ?? join(tmpdir(), "anybench-stripe-spike");
  mkdirSync(outDir, { recursive: true });
  return {
    stripe,
    calls,
    outDir,
    save(name, data) {
      const file = join(outDir, `${name}.json`);
      writeFileSync(file, JSON.stringify(data, bigintReplacer, 2) + "\n");
      return file;
    },
  };
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Print one step line: `[step] message {json}`. Values here are ids and amounts, never secrets. */
export function step(name: string, message: string, data?: unknown): void {
  const suffix = data === undefined ? "" : " " + JSON.stringify(data, bigintReplacer);
  console.log(`[${name}] ${message}${suffix}`);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Short random run id so every scenario run makes fresh customers/clocks. */
export function runId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Best-effort error summary for the findings doc (type/code/message, no request body). */
export function errorSummary(err: unknown): Record<string, unknown> {
  if (err instanceof Stripe.errors.StripeError) {
    return {
      type: err.type,
      code: err.code,
      status: err.statusCode,
      message: err.message,
      request_id: err.requestId,
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

/** Advance a test clock and wait until it is `ready` again (Stripe runs billing for the jump). */
export async function advanceClock(
  stripe: Stripe,
  clockId: string,
  to: number,
  label: string,
): Promise<Stripe.TestHelpers.TestClock> {
  step("clock", `advance ${label}`, {
    clock: clockId,
    frozen_time: to,
    iso: new Date(to * 1000).toISOString(),
  });
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
  const started = Date.now();
  for (;;) {
    await sleep(3000);
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === "ready") {
      step("clock", `ready after ${Math.round((Date.now() - started) / 1000)}s`, {
        status: clock.status,
      });
      return clock;
    }
    if (clock.status === "internal_failure")
      throw new Error(`test clock ${clockId} internal_failure`);
    if (Date.now() - started > 10 * 60_000)
      throw new Error(`test clock ${clockId} still ${clock.status} after 10 min`);
  }
}
