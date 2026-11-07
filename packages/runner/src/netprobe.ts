// Network probe before `run` (TDM-160). EnvSpec.network.allow is declared, not enforced, on Naïve
// (plan.md P1 "Network"), so the runner checks what the trial could actually reach: an HTTPS HEAD
// to each allowed host and to a canary the allow-list does not cover, each with its own timeout.
// Any HTTP response counts as reachable (a 403 still means the packets got there); only a network
// error or the timeout counts as blocked / failed. The result goes to EVAL_OUT/network.json (so it
// is in the bundle) and into a `trial.network` event. The probe never fails the trial.

import { z } from "zod";
import type { NetworkProbeConfig } from "./job.js";

export const NetworkProbeTargetSchema = z.object({
  url: z.string(),
  reachable: z.boolean(),
  http_status: z.int().nullable(),
  error: z.string().nullable(),
  ms: z.int().nonnegative(),
});
export type NetworkProbeTarget = z.infer<typeof NetworkProbeTargetSchema>;

/** EVAL_OUT/network.json */
export const NetworkProbeResultSchema = z.object({
  /** Declared host → whether an HTTPS HEAD got any response. */
  allowed: z.record(z.string(), z.enum(["ok", "failed"])),
  canary: z.enum(["blocked", "reachable"]),
  canary_url: z.string(),
  /** Per target detail. */
  details: z.object({
    allowed: z.record(z.string(), NetworkProbeTargetSchema),
    canary: NetworkProbeTargetSchema,
  }),
  probed_at: z.iso.datetime({ offset: true }),
  timeout_ms: z.int().positive(),
});
export type NetworkProbeResult = z.infer<typeof NetworkProbeResultSchema>;

/**
 * The URL probed for a declared host: `https://<host>[:port]/`. A `*.example.com` wildcard is
 * probed at its apex, `example.com`.
 */
export function probeUrlForHost(host: string): string {
  const h = host.startsWith("*.") ? host.slice(2) : host;
  return `https://${h}/`;
}

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

async function probeOne(
  url: string,
  timeoutMs: number,
  f: ProbeFetch,
): Promise<NetworkProbeTarget> {
  const t0 = Date.now();
  try {
    const res = await f(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer().catch(() => undefined);
    return { url, reachable: true, http_status: res.status, error: null, ms: Date.now() - t0 };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const detail = e.name === "TimeoutError" ? `timeout after ${timeoutMs} ms` : e.message;
    const cause = e.cause?.code ?? e.cause?.message;
    return {
      url,
      reachable: false,
      http_status: null,
      error: cause && !detail.includes(cause) ? `${detail} (${cause})` : detail,
      ms: Date.now() - t0,
    };
  }
}

export async function probeNetwork(
  config: NetworkProbeConfig,
  options: { fetch?: ProbeFetch; now?: () => Date } = {},
): Promise<NetworkProbeResult> {
  const f: ProbeFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const hosts = [...new Set(config.allow)];
  const [canary, ...allowed] = await Promise.all([
    probeOne(config.canary_url, config.timeout_ms, f),
    ...hosts.map((h) => probeOne(probeUrlForHost(h), config.timeout_ms, f)),
  ]);
  const allowedDetails: Record<string, NetworkProbeTarget> = {};
  const allowedMap: Record<string, "ok" | "failed"> = {};
  hosts.forEach((h, i) => {
    allowedDetails[h] = allowed[i]!;
    allowedMap[h] = allowed[i]!.reachable ? "ok" : "failed";
  });
  return {
    allowed: allowedMap,
    canary: canary!.reachable ? "reachable" : "blocked",
    canary_url: config.canary_url,
    details: { allowed: allowedDetails, canary: canary! },
    probed_at: (options.now?.() ?? new Date()).toISOString(),
    timeout_ms: config.timeout_ms,
  };
}
