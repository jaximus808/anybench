"use client";
// DEV ONLY (app/dev/traces): renders a trace or a run summary from JSON, inside a drawer-sized frame.
import { RunTraceSummarySchema, TrialTraceSchema } from "@anybench/core";
import { TimeBreakdown } from "../../../components/trace/TimeBreakdown";
import { TraceView } from "../../../components/trace/TraceView";

export function TraceDev({ traceJson, summaryJson }: { traceJson?: string; summaryJson?: string }) {
  const frame = {
    maxWidth: 1100,
    margin: "0 auto",
    padding: "24px 24px 64px",
    background: "var(--surface)",
    borderLeft: "1px solid var(--line-strong)",
    borderRight: "1px solid var(--line-strong)",
    minHeight: "100vh",
  };
  if (summaryJson) {
    const summary = RunTraceSummarySchema.parse(JSON.parse(summaryJson));
    const names = Object.fromEntries(
      summary.setups.map((x) => [x.contender_id, x.setup ?? x.contender_id.slice(0, 8)]),
    );
    return (
      <div className="instrument" style={{ background: "var(--bg)" }}>
        <div style={frame}>
          <TimeBreakdown summary={summary} names={names} />
        </div>
      </div>
    );
  }
  const trace = TrialTraceSchema.parse(JSON.parse(traceJson!));
  return (
    <div className="instrument" style={{ background: "var(--bg)" }}>
      <div style={frame}>
        <p className="eyebrow" style={{ marginBottom: 4 }}>
          Trial {trace.trial_id.slice(0, 8)}, {trace.setup}
        </p>
        <TraceView trace={trace} />
      </div>
    </div>
  );
}
