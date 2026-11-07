import { describe, expect, it } from "vitest";
import {
  AnybenchEventSchema,
  EVENT_SOURCE_BY_TYPE,
  EVENT_TYPES,
  encodeAnybenchEvent,
  parseAnybenchEvent,
  serializeAnybenchEvent,
  type AnybenchEventInput,
  type AnybenchEventType,
} from "../src/index.js";

const at = "2026-11-07T21:30:00.000Z";

function tdm8Event(
  type: AnybenchEventType,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    run_id: "run_1",
    seq: 7,
    source: EVENT_SOURCE_BY_TYPE[type],
    source_id: "src_1",
    type,
    severity: "info",
    actor: { kind: "worker", id: "worker-a" },
    cost_delta_micro_usd: "0",
    at,
    payload,
    ...extra,
  } as AnybenchEventInput;
}

// One fixture per event type; the Record type makes a missing type a compile error.
const tdm8Fixtures: Record<AnybenchEventType, AnybenchEventInput> = {
  "run.state_changed": tdm8Event("run.state_changed", {
    from: "proof",
    to: "awaiting_go",
    command: "advance",
  }),
  "trial.phase": tdm8Event("trial.phase", { from: "gating", to: "reviewing", attempt: 1 }),
  "trial.heartbeat": tdm8Event(
    "trial.heartbeat",
    {
      phase: "running",
      lease_owner: "worker-a",
      lease_until: "2026-11-07T21:31:30.000Z",
      log_offset: 4096,
    },
    { severity: "debug" },
  ),
  "trial.log_chunk": tdm8Event("trial.log_chunk", {
    stream: "stdout",
    offset: 4096,
    bytes: 1024,
    url: "s3://anybench-logs/run_1/trial_1/stdout",
  }),
  "trial.network": tdm8Event("trial.network", {
    allowed: { "api.anthropic.com": "ok" },
    canary: "blocked",
    canary_url: "https://example.com",
  }),
  "trial.gate": tdm8Event("trial.gate", {
    gate: "tests_pass",
    passed: false,
    summary: "3 of 40 tests failed",
    evidence_url: "https://storage.example/evidence.json",
    details: { failed: ["a", "b", "c"] },
  }),
  "agent.tool.started": tdm8Event(
    "agent.tool.started",
    { agent_role: "researcher", naive_seq: 12, tool: "web_search", tool_use_id: "tu_1" },
    { actor: { kind: "agent", id: "as_1" }, cost_delta_micro_usd: 1500 },
  ),
  "agent.message": tdm8Event("agent.message", {
    agent_role: "kit_designer",
    naive_seq: 13,
    message_role: "assistant",
    text: "Drafted 4 workloads.",
    truncated: false,
  }),
  "computer.created": tdm8Event("computer.created", {
    provider: "naive",
    provider_id: "cmp_9",
    trial_id: "trial_1",
  }),
  "computer.destroyed": tdm8Event(
    "computer.destroyed",
    { provider: "vultr", reason: "trial done", blocks_billed: 3 },
    { cost_delta_micro_usd: 42_000n },
  ),
  "computer.leaked": tdm8Event(
    "computer.leaked",
    { provider: "vultr", idle_s: 960, last_trial_id: "trial_1", action: "destroyed" },
    { severity: "critical", actor: { kind: "system" } },
  ),
  "usage.recorded": tdm8Event(
    "usage.recorded",
    {
      user_id: "u_1",
      trial_id: "trial_1",
      kind: "trial_fee",
      amount_micro_usd: "250000",
      comped: false,
    },
    { cost_delta_micro_usd: "250000" },
  ),
  "alert.fired": tdm8Event(
    "alert.fired",
    {
      rule_key: "run_spend_90",
      fingerprint: "run_spend_90:run_1",
      alert_severity: "critical",
      count: 1,
      message: "Run spend is at 90% of its cap",
    },
    { severity: "critical" },
  ),
  "alert.acked": tdm8Event(
    "alert.acked",
    { rule_key: "run_spend_90", acked_by: "u_1" },
    { actor: { kind: "user", id: "u_1" } },
  ),
  "alert.resolved": tdm8Event("alert.resolved", { rule_key: "run_spend_90", resolved_by: null }),
  "billing.payment_failed": tdm8Event(
    "billing.payment_failed",
    { user_id: "u_1", stripe_event_id: "evt_1", invoice_id: "in_1", action: "block_new_runs" },
    { run_id: null, severity: "error", actor: { kind: "webhook", id: "stripe" } },
  ),
  "publish.version_created": tdm8Event("publish.version_created", {
    benchmark_id: "pb_1",
    slug: "tandem-vs-claude-code",
    version: 2,
    key_id: "k1",
  }),
};

describe("AnybenchEvent", () => {
  it("EVENT_TYPES lists exactly the section 6 types", () => {
    expect([...EVENT_TYPES].sort()).toEqual(Object.keys(tdm8Fixtures).sort());
    expect(EVENT_TYPES).toHaveLength(17);
  });

  it.each(EVENT_TYPES)("%s round-trips parse → serialize → parse", (type) => {
    const parsed = AnybenchEventSchema.parse(tdm8Fixtures[type]);
    expect(parsed.type).toBe(type);
    expect(typeof parsed.cost_delta_micro_usd).toBe("bigint");
    const json = serializeAnybenchEvent(parsed);
    expect(parseAnybenchEvent(json)).toEqual(parsed);
    expect(AnybenchEventSchema.parse(encodeAnybenchEvent(parsed))).toEqual(parsed);
  });

  it("serializes bigint money as decimal strings", () => {
    const parsed = AnybenchEventSchema.parse(tdm8Fixtures["usage.recorded"]);
    expect(parsed.cost_delta_micro_usd).toBe(250_000n);
    if (parsed.type === "usage.recorded") expect(parsed.payload.amount_micro_usd).toBe(250_000n);
    const wire = JSON.parse(serializeAnybenchEvent(parsed));
    expect(wire.cost_delta_micro_usd).toBe("250000");
    expect(wire.payload.amount_micro_usd).toBe("250000");
  });

  it("keeps precision beyond Number.MAX_SAFE_INTEGER", () => {
    const big = "9007199254740993123";
    const parsed = parseAnybenchEvent(
      serializeAnybenchEvent(
        AnybenchEventSchema.parse({ ...tdm8Fixtures["trial.gate"], cost_delta_micro_usd: big }),
      ),
    );
    expect(parsed.cost_delta_micro_usd.toString()).toBe(big);
  });

  it("defaults cost_delta_micro_usd to 0n and strips the DB id", () => {
    const { cost_delta_micro_usd: _omit, ...rest } = tdm8Fixtures["alert.acked"] as Record<
      string,
      unknown
    >;
    const parsed = AnybenchEventSchema.parse({ ...rest, id: "123" });
    expect(parsed.cost_delta_micro_usd).toBe(0n);
    expect("id" in parsed).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["unknown type", { type: "run.exploded" }],
    ["source does not match type", { source: "trial" }],
    ["float money", { cost_delta_micro_usd: 1.5 }],
    ["decimal money string", { cost_delta_micro_usd: "1.50" }],
    ["unknown severity", { severity: "fatal" }],
    ["actor without id", { actor: { kind: "user" } }],
    ["bad timestamp", { at: "yesterday" }],
    ["negative seq", { seq: -1 }],
  ])("rejects %s", (_name, override) => {
    expect(
      AnybenchEventSchema.safeParse({ ...tdm8Fixtures["run.state_changed"], ...override }).success,
    ).toBe(false);
  });

  it("rejects state changes the state machines forbid", () => {
    const bad = (type: "run.state_changed" | "trial.phase", payload: Record<string, unknown>) =>
      AnybenchEventSchema.safeParse(tdm8Event(type, payload)).success;
    expect(bad("run.state_changed", { from: "intake", to: "running" })).toBe(false);
    expect(bad("run.state_changed", { from: null, to: "proof" })).toBe(false);
    expect(bad("run.state_changed", { from: null, to: "intake" })).toBe(true);
    expect(
      bad("run.state_changed", { from: "proof", to: "awaiting_go", command: "teleport" }),
    ).toBe(false);
    expect(bad("trial.phase", { from: "queued", to: "done", attempt: 1 })).toBe(false);
    expect(bad("trial.phase", { from: "failed_infra", to: "queued", attempt: 2 })).toBe(true);
    expect(bad("trial.phase", { from: null, to: "queued", attempt: 1 })).toBe(true);
  });
});
