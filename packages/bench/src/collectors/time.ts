// `/usr/bin/time -v` (GNU time) report -> trial-level Metric rows: wall, CPU, peak RSS.
// Fixture: fixtures/collectors/time/ (captured in debian:bookworm-slim, GNU time 1.9).
import { metric, type Metric } from "../metric.js";

export interface TimeReport {
  command: string | null;
  user_s: number;
  sys_s: number;
  /** null when GNU time printed `?%` (elapsed too short to divide by). */
  cpu_percent: number | null;
  wall_s: number;
  max_rss_kb: number;
  major_faults: number;
  minor_faults: number;
  voluntary_ctx_switches: number;
  involuntary_ctx_switches: number;
  fs_inputs: number;
  fs_outputs: number;
  exit_status: number;
  /** Set when the report starts with "Command terminated by signal N". */
  signal: number | null;
}

/** "0:00.69", "1:02.5", "1:02:03" (h:mm:ss or m:ss) -> seconds. */
export function parseElapsed(text: string): number {
  const parts = text.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
    throw new Error(`bad elapsed time: ${JSON.stringify(text)}`);
  }
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

function field(fields: Map<string, string>, label: string): string {
  const v = fields.get(label);
  if (v === undefined) throw new Error(`/usr/bin/time -v report is missing "${label}"`);
  return v;
}

function int(fields: Map<string, string>, label: string): number {
  const v = field(fields, label);
  if (!/^\d+$/.test(v)) throw new Error(`"${label}" is not an integer: ${JSON.stringify(v)}`);
  return Number(v);
}

function num(fields: Map<string, string>, label: string): number {
  const v = field(fields, label);
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`"${label}" is not a number: ${JSON.stringify(v)}`);
  return Number(v);
}

/** Parse the text GNU time writes with `-v` (to stderr, or to the `-o` file). */
export function parseTimeReport(text: string): TimeReport {
  const fields = new Map<string, string>();
  let signal: number | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const sig = /^Command terminated by signal (\d+)$/.exec(line);
    if (sig) signal = Number(sig[1]);
    // "Elapsed (wall clock) time (h:mm:ss or m:ss): 0:00.69" has colons in the value: split at ": ".
    const at = line.indexOf(": ");
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 2).trim());
  }
  const cmd = fields.get("Command being timed");
  const pct = field(fields, "Percent of CPU this job got");
  return {
    command: cmd === undefined ? null : cmd.replace(/^"|"$/g, ""),
    user_s: num(fields, "User time (seconds)"),
    sys_s: num(fields, "System time (seconds)"),
    cpu_percent: /^\d+%$/.test(pct) ? Number(pct.slice(0, -1)) : null,
    wall_s: parseElapsed(field(fields, "Elapsed (wall clock) time (h:mm:ss or m:ss)")),
    max_rss_kb: int(fields, "Maximum resident set size (kbytes)"),
    major_faults: int(fields, "Major (requiring I/O) page faults"),
    minor_faults: int(fields, "Minor (reclaiming a frame) page faults"),
    voluntary_ctx_switches: int(fields, "Voluntary context switches"),
    involuntary_ctx_switches: int(fields, "Involuntary context switches"),
    fs_inputs: int(fields, "File system inputs"),
    fs_outputs: int(fields, "File system outputs"),
    exit_status: int(fields, "Exit status"),
    signal,
  };
}

/** Round to microseconds so `user + sys` does not carry float noise into the report. */
const roundUs = (s: number): number => Math.round(s * 1e6) / 1e6;

/** GNU time report -> Metric rows (all trial-level). */
export function collectTime(text: string): Metric[] {
  const r = parseTimeReport(text);
  const t = (name: string, value: number, unit: Metric["unit"]): Metric =>
    metric({ name, value, unit, level: "trial", collector: "time" });
  const rows = [
    t("wall_s", r.wall_s, "s"),
    t("user_cpu_s", r.user_s, "s"),
    t("sys_cpu_s", r.sys_s, "s"),
    t("cpu_s", roundUs(r.user_s + r.sys_s), "s"),
    t("peak_rss_bytes", r.max_rss_kb * 1024, "bytes"),
    t("major_page_faults", r.major_faults, "count"),
    t("minor_page_faults", r.minor_faults, "count"),
    t("voluntary_ctx_switches", r.voluntary_ctx_switches, "count"),
    t("involuntary_ctx_switches", r.involuntary_ctx_switches, "count"),
    t("fs_inputs", r.fs_inputs, "count"),
    t("fs_outputs", r.fs_outputs, "count"),
    t("exit_code", r.exit_status, "count"),
  ];
  if (r.cpu_percent !== null) rows.push(t("cpu_percent", r.cpu_percent, "percent"));
  if (r.signal !== null) rows.push(t("term_signal", r.signal, "count"));
  return rows;
}
