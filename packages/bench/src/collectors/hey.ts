// `hey` default text summary -> Metric rows: RPS, latency percentiles, status codes, errors.
// Fixture: fixtures/collectors/hey/ (hey v0.1.4 against nginx in Docker).
import { metric, type Metric } from "../metric.js";

export interface HeyReport {
  total_s: number;
  slowest_s: number;
  fastest_s: number;
  average_s: number;
  rps: number;
  total_data_bytes: number | null;
  size_per_request_bytes: number | null;
  /** Percentile (10, 25, 50, ...) -> seconds. */
  latency: Map<number, number>;
  /** HTTP status -> responses. */
  status: Map<number, number>;
  /** Error message -> count. */
  errors: Map<string, number>;
}

function secs(fields: Map<string, string>, label: string): number {
  const v = fields.get(label);
  const m = v === undefined ? null : /^(\d+(?:\.\d+)?) secs$/.exec(v);
  if (!m) throw new Error(`hey summary is missing "${label}" (got ${JSON.stringify(v)})`);
  return Number(m[1]);
}

function bytes(fields: Map<string, string>, label: string): number | null {
  const m = /^(\d+) bytes$/.exec(fields.get(label) ?? "");
  return m ? Number(m[1]) : null;
}

/** Parse the report hey prints to stdout (no `-o csv`). */
export function parseHey(text: string): HeyReport {
  let section = "";
  const summary = new Map<string, string>();
  const latency = new Map<number, number>();
  const status = new Map<number, number>();
  const errors = new Map<string, number>();
  for (const raw of text.split("\n")) {
    if (/^\S.*:\s*$/.test(raw)) {
      section = raw.trim().replace(/:$/, "");
      continue;
    }
    const line = raw.trim();
    if (line === "") continue;
    if (section === "Summary") {
      const m = /^([^:]+):\s+(.+)$/.exec(line);
      if (m) summary.set(m[1]!.trim(), m[2]!.trim());
    } else if (section === "Latency distribution") {
      const m = /^(\d+(?:\.\d+)?)% in (\d+(?:\.\d+)?) secs$/.exec(line);
      if (m) latency.set(Number(m[1]), Number(m[2]));
    } else if (section === "Status code distribution") {
      const m = /^\[(\d{3})\]\s+(\d+) responses?$/.exec(line);
      if (m) status.set(Number(m[1]), Number(m[2]));
    } else if (section === "Error distribution") {
      const m = /^\[(\d+)\]\s+(.+)$/.exec(line);
      if (m) errors.set(m[2]!, (errors.get(m[2]!) ?? 0) + Number(m[1]));
    }
  }
  const rpsText = summary.get("Requests/sec");
  if (rpsText === undefined || !/^\d+(\.\d+)?$/.test(rpsText)) {
    throw new Error("hey summary is missing Requests/sec: is this hey's default text output?");
  }
  return {
    total_s: secs(summary, "Total"),
    slowest_s: secs(summary, "Slowest"),
    fastest_s: secs(summary, "Fastest"),
    average_s: secs(summary, "Average"),
    rps: Number(rpsText),
    total_data_bytes: bytes(summary, "Total data"),
    size_per_request_bytes: bytes(summary, "Size/request"),
    latency,
    status,
    errors,
  };
}

/** Seconds -> ms without float noise past the microsecond (hey prints 4 decimals of seconds). */
export const sToMs = (s: number): number => Math.round(s * 1e6) / 1e3;

/** Shared load-test metric names, used by both `hey` and `k6`. */
export function loadMetrics(
  collector: "hey" | "k6",
  r: {
    rps: number;
    requests: number;
    failed: number;
    mean_ms: number;
    min_ms: number;
    max_ms: number;
    percentiles_ms: ReadonlyMap<number, number>;
    duration_s?: number;
  },
): Metric[] {
  const t = (
    name: string,
    value: number,
    unit: Metric["unit"],
    labels?: Record<string, string>,
  ): Metric =>
    metric({ name, value, unit, level: "trial", collector, ...(labels ? { labels } : {}) });
  const rows = [
    t("rps", r.rps, "per_s"),
    t("http_requests", r.requests, "count"),
    t("http_failed", r.failed, "count"),
    t("error_rate", r.requests === 0 ? 0 : r.failed / r.requests, "ratio"),
    t("latency_mean_ms", r.mean_ms, "ms"),
    t("latency_min_ms", r.min_ms, "ms"),
    t("latency_max_ms", r.max_ms, "ms"),
  ];
  if (r.duration_s !== undefined) rows.push(t("load_duration_s", r.duration_s, "s"));
  for (const [p, ms] of [...r.percentiles_ms].sort((a, b) => a[0] - b[0])) {
    rows.push(t(`p${String(p).replace(".", "_")}_ms`, ms, "ms"));
  }
  return rows;
}

/** hey report -> Metric rows. A request "failed" if it errored or got a non-2xx/3xx status. */
export function collectHey(text: string): Metric[] {
  const r = parseHey(text);
  let responses = 0;
  let badStatus = 0;
  for (const [code, n] of r.status) {
    responses += n;
    if (code >= 400) badStatus += n;
  }
  const errored = [...r.errors.values()].reduce((a, b) => a + b, 0);
  const percentiles = new Map([...r.latency].map(([p, s]) => [p, sToMs(s)] as const));
  const rows = loadMetrics("hey", {
    rps: r.rps,
    requests: responses + errored,
    failed: badStatus + errored,
    mean_ms: sToMs(r.average_s),
    min_ms: sToMs(r.fastest_s),
    max_ms: sToMs(r.slowest_s),
    percentiles_ms: percentiles,
    duration_s: r.total_s,
  });
  for (const [code, n] of [...r.status].sort((a, b) => a[0] - b[0])) {
    rows.push(
      metric({
        name: "http_status",
        value: n,
        unit: "count",
        level: "trial",
        collector: "hey",
        labels: { status: String(code) },
      }),
    );
  }
  if (errored > 0) {
    rows.push(
      metric({
        name: "http_errors",
        value: errored,
        unit: "count",
        level: "trial",
        collector: "hey",
      }),
    );
  }
  if (r.total_data_bytes !== null) {
    rows.push(
      metric({
        name: "http_data_bytes",
        value: r.total_data_bytes,
        unit: "bytes",
        level: "trial",
        collector: "hey",
      }),
    );
  }
  return rows;
}
