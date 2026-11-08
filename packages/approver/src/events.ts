// Every approval decision is a counted, timed event, labelled simulated. The report reads these as
// "simulated approvals: N, latency" and never as human minutes (plan.md 17.2 rule 10).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const APPROVER_POLICIES = ["auto", "llm-reviewer", "human-sim"] as const;
export type ApproverPolicy = (typeof APPROVER_POLICIES)[number];

/** File name under EVAL_OUT. */
export const APPROVALS_FILE = "approvals.jsonl";

export const ApprovalEventSchema = z.strictObject({
  v: z.literal(1),
  /** Always true: no approval Anybench records ever comes from a real person. */
  simulated: z.literal(true),
  /** `tandem` board approvals or `naive` confirmTool / answer prompts. */
  kind: z.enum(["tandem", "naive"]),
  policy: z.enum(APPROVER_POLICIES),
  /** Hash of the approver config. Equal for every contender in a run (rule 4). */
  config_hash: z.string().regex(/^[0-9a-f]{16}$/),
  trial_id: z.string().min(1).optional(),
  contender_id: z.string().min(1).optional(),
  decision: z.enum(["approve", "reject", "allow", "deny", "answer"]),
  target: z.strictObject({
    type: z.enum(["epic", "task", "tool", "question"]),
    id: z.string().min(1),
    ticket: z.string().optional(),
    title: z.string().optional(),
  }),
  /**
   * Who decided, in our vocabulary: `policy:auto` / `policy:epic` (Tandem stamped it at birth or
   * by cascade), `human-sim` (our cookie session), or `agent:<name>` (the reviewer agent).
   */
  decided_by: z.string().min(1),
  /** What the board stored as approvedBy, when it says. Tandem stamps `human` for human-sim. */
  board_stamp: z.string().optional(),
  /** When the thing became waiting (board `createdAt` or when we first saw the prompt). */
  requested_at: z.iso.datetime({ offset: true }),
  decided_at: z.iso.datetime({ offset: true }),
  latency_ms: z.number().int().nonnegative(),
  reason: z.string().max(2000).optional(),
});
export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;

/** Appends events to `<dir>/approvals.jsonl` (one validated JSON object per line) and keeps them in memory. */
export class ApprovalLog {
  readonly path: string | null;
  readonly #events: ApprovalEvent[] = [];
  readonly #seen = new Set<string>();
  readonly #targets = new Set<string>();

  /** `outDir` null keeps events in memory only (tests). */
  constructor(outDir: string | null) {
    this.path = outDir === null ? null : join(outDir, APPROVALS_FILE);
    if (this.path) mkdirSync(dirname(this.path), { recursive: true });
  }

  /** Records one decision. A second event for the same target + decision is ignored. */
  record(event: ApprovalEvent): boolean {
    const parsed = ApprovalEventSchema.parse(event);
    const key = `${parsed.kind}:${parsed.target.type}:${parsed.target.id}:${parsed.decision}`;
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    this.#targets.add(`${parsed.kind}:${parsed.target.id}`);
    this.#events.push(parsed);
    if (this.path) appendFileSync(this.path, JSON.stringify(parsed) + "\n");
    return true;
  }

  has(kind: ApprovalEvent["kind"], targetId: string): boolean {
    return this.#targets.has(`${kind}:${targetId}`);
  }

  events(): readonly ApprovalEvent[] {
    return this.#events;
  }
}

/** Reads and validates an approvals.jsonl file. Throws on a malformed line. */
export function readApprovals(path: string): ApprovalEvent[] {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, i) => {
      const r = ApprovalEventSchema.safeParse(JSON.parse(l));
      if (!r.success) throw new Error(`${path}:${i + 1}: ${r.error.message}`);
      return r.data;
    });
}

export const ApprovalSummarySchema = z.strictObject({
  /** The label a report must print. Never "human minutes". */
  label: z.literal("simulated approvals"),
  simulated: z.literal(true),
  /** Approvals + allows + answers (what moved work forward). */
  approvals: z.number().int().nonnegative(),
  rejections: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  latency_ms: z.strictObject({
    p50: z.number().int().nonnegative(),
    p95: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  }),
  by_decided_by: z.record(z.string(), z.number().int().nonnegative()),
  policy: z.enum(APPROVER_POLICIES).nullable(),
});
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

/** "simulated approvals: N, latency p50/p95/max". */
export function summarizeApprovals(events: readonly ApprovalEvent[]): ApprovalSummary {
  const lat = events.map((e) => e.latency_ms).sort((a, b) => a - b);
  const by: Record<string, number> = {};
  for (const e of events) by[e.decided_by] = (by[e.decided_by] ?? 0) + 1;
  const policies = new Set(events.map((e) => e.policy));
  const rejections = events.filter((e) => e.decision === "reject" || e.decision === "deny").length;
  return ApprovalSummarySchema.parse({
    label: "simulated approvals",
    simulated: true,
    approvals: events.length - rejections,
    rejections,
    total: events.length,
    latency_ms: { p50: percentile(lat, 50), p95: percentile(lat, 95), max: lat.at(-1) ?? 0 },
    by_decided_by: by,
    policy: policies.size === 1 ? [...policies][0]! : null,
  });
}

/** One line for a report: `simulated approvals: 7, latency p50 120 ms, p95 900 ms`. */
export function formatApprovalSummary(s: ApprovalSummary): string {
  return `${s.label}: ${s.approvals}${s.rejections ? ` (+${s.rejections} rejected)` : ""}, latency p50 ${s.latency_ms.p50} ms, p95 ${s.latency_ms.p95} ms`;
}

/**
 * Rule 4 in code: every contender in a run must have been served by the same approver config.
 * Throws when two contenders' events carry different `config_hash` or `policy`.
 */
export function assertSameApproverForAll(events: readonly ApprovalEvent[]): void {
  const byContender = new Map<string, string>();
  for (const e of events) {
    const sig = `${e.policy}/${e.config_hash}`;
    const c = e.contender_id ?? "(none)";
    const prev = byContender.get(c);
    if (prev !== undefined && prev !== sig) {
      throw new Error(`contender '${c}' saw two approver configs (${prev}, ${sig})`);
    }
    byContender.set(c, sig);
  }
  const sigs = new Set(byContender.values());
  if (sigs.size > 1) {
    throw new Error(
      `approver differs across contenders: ${[...byContender].map(([c, s]) => `${c}=${s}`).join(", ")}`,
    );
  }
}
