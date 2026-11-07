// machine.json: what the trial ran on, written right before `run`. `load_1m` and `steal_pct` let
// the scheduler discard trials measured on a noisy computer (plan.md "Fairness").

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface MachineInfo {
  captured_at: string;
  hostname: string;
  platform: string;
  arch: string;
  /** `uname -a` */
  uname: string | null;
  /** `nproc` (falls back to os.availableParallelism) */
  nproc: number;
  /** Raw `lscpu` output. */
  lscpu: string | null;
  cpu_model: string | null;
  mem_total_kb: number | null;
  mem_available_kb: number | null;
  load_1m: number;
  load_5m: number;
  load_15m: number;
  /** CPU steal over a short sample window, percent of all CPU time. null off Linux. */
  steal_pct: number | null;
  steal_window_ms: number;
  runner_version: string;
}

async function run(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Parse /proc/meminfo into kB values. */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) out[m[1]!] = Number(m[2]);
  }
  return out;
}

/** The aggregate `cpu` line of /proc/stat: [total, steal] jiffies. */
export function parseProcStatCpu(text: string): { total: number; steal: number } | null {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal guest guest_nice; guest is already in user.
  const total = f.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { total, steal: f[7] ?? 0 };
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function sampleSteal(windowMs: number): Promise<number | null> {
  const a = parseProcStatCpu((await readText("/proc/stat")) ?? "");
  if (!a) return null;
  await new Promise((r) => setTimeout(r, windowMs));
  const b = parseProcStatCpu((await readText("/proc/stat")) ?? "");
  if (!b) return null;
  const dt = b.total - a.total;
  if (dt <= 0) return 0;
  return Math.round(((b.steal - a.steal) / dt) * 10_000) / 100;
}

export async function probeMachine(
  runnerVersion: string,
  stealWindowMs = 1000,
): Promise<MachineInfo> {
  const [uname, nprocText, lscpu, meminfoText, steal] = await Promise.all([
    run("uname", ["-a"]),
    run("nproc", []),
    run("lscpu", []),
    readText("/proc/meminfo"),
    sampleSteal(stealWindowMs),
  ]);
  const meminfo = meminfoText ? parseMeminfo(meminfoText) : {};
  const [l1, l5, l15] = os.loadavg();
  const nproc = Number(nprocText);
  return {
    captured_at: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uname,
    nproc: Number.isInteger(nproc) && nproc > 0 ? nproc : os.availableParallelism(),
    lscpu,
    cpu_model: os.cpus()[0]?.model ?? null,
    mem_total_kb: meminfo.MemTotal ?? null,
    mem_available_kb: meminfo.MemAvailable ?? null,
    load_1m: l1 ?? 0,
    load_5m: l5 ?? 0,
    load_15m: l15 ?? 0,
    steal_pct: steal,
    steal_window_ms: stealWindowMs,
    runner_version: runnerVersion,
  };
}
