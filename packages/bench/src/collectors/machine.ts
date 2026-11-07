// machine.json (written by the in-VM runner right before `run`) -> Metric rows. `load_1m` and
// `steal_pct` let the scheduler discard trials measured on a noisy computer (plan.md Fairness).
// Shape matches the runner's MachineInfo (packages/runner/src/machine.ts, TDM-46); unknown keys
// are kept so a newer runner does not break an older reader. Fixture: fixtures/collectors/machine/.
import { z } from "zod";
import { metric, type Metric } from "../metric.js";

const Finite = z.number().refine(Number.isFinite, { error: "must be a finite number" });
const KbOrNull = z.int().nonnegative().nullable().optional();

export const MachineJsonSchema = z.looseObject({
  captured_at: z.string().optional(),
  hostname: z.string().optional(),
  platform: z.string().optional(),
  arch: z.string().optional(),
  uname: z.string().nullable().optional(),
  nproc: z.int().positive(),
  lscpu: z.string().nullable().optional(),
  cpu_model: z.string().nullable().optional(),
  mem_total_kb: KbOrNull,
  mem_available_kb: KbOrNull,
  load_1m: Finite.nonnegative(),
  load_5m: Finite.nonnegative().optional(),
  load_15m: Finite.nonnegative().optional(),
  steal_pct: Finite.min(0).max(100).nullable().optional(),
  steal_window_ms: z.int().nonnegative().optional(),
  runner_version: z.string().optional(),
});
export type MachineJson = z.infer<typeof MachineJsonSchema>;

export function parseMachineJson(json: string | unknown): MachineJson {
  return MachineJsonSchema.parse(typeof json === "string" ? JSON.parse(json) : json);
}

/** One `Field: value` line of raw `lscpu` text. `-` (unknown, common on ARM) reads as null. */
export function lscpuField(lscpu: string, field: string): string | null {
  for (const line of lscpu.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0 && line.slice(0, at).trim() === field) {
      const v = line.slice(at + 1).trim();
      return v === "" || v === "-" ? null : v;
    }
  }
  return null;
}

/** machine.json -> Metric rows (trial-level), labelled with the CPU model and arch. */
export function collectMachine(json: string | unknown): Metric[] {
  const m = parseMachineJson(json);
  const cpu =
    m.cpu_model ??
    (m.lscpu ? (lscpuField(m.lscpu, "Model name") ?? lscpuField(m.lscpu, "Vendor ID")) : null);
  const labels: Record<string, string> = {};
  if (cpu) labels.cpu_model = cpu;
  if (m.arch) labels.arch = m.arch;
  const t = (name: string, value: number, unit: Metric["unit"]): Metric =>
    metric({
      name,
      value,
      unit,
      level: "trial",
      collector: "machine",
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    });
  const rows = [t("nproc", m.nproc, "count"), t("load_1m", m.load_1m, "ratio")];
  if (m.load_5m !== undefined) rows.push(t("load_5m", m.load_5m, "ratio"));
  if (m.load_15m !== undefined) rows.push(t("load_15m", m.load_15m, "ratio"));
  if (m.steal_pct != null) rows.push(t("steal_pct", m.steal_pct, "percent"));
  if (m.mem_total_kb != null) rows.push(t("mem_total_bytes", m.mem_total_kb * 1024, "bytes"));
  if (m.mem_available_kb != null)
    rows.push(t("mem_available_bytes", m.mem_available_kb * 1024, "bytes"));
  return rows;
}
