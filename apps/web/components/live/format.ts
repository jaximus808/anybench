// Small formatters for the live run page. Money is bigint micro-USD and goes through formatUsd.
import { formatUsd } from "@anybench/core";

export function usd(amount: bigint, decimals = 2): string {
  return formatUsd(amount, { decimals });
}

/** Small spends ($0.004) need more digits than totals. */
export function usdSmall(amount: bigint): string {
  return formatUsd(amount, { decimals: amount < 10_000n ? 4 : amount < 1_000_000n ? 3 : 2 });
}

/** Spent as a percentage of a budget, integer maths; for bar widths only. */
export function pctOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  const tenths = (part * 1000n) / whole;
  return Math.max(0, Math.min(100, Number(tenths) / 10));
}

export function ms(at: string | null): number {
  return at ? Date.parse(at) : 0;
}

/** "1:05" / "12:40" / "1:02:03" for a duration in ms. */
export function clock(durationMs: number): string {
  const s = Math.max(0, Math.floor(durationMs / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** "2h 14m" / "4m 10s" / "12s". */
export function span(durationMs: number): string {
  const s = Math.max(0, Math.round(durationMs / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
