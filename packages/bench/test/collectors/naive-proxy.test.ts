import { describe, expect, it } from "vitest";
import { collectNaiveProxy, parseProxyCalls } from "../../src/collectors/naive-proxy.js";
import { fixture, row, value } from "./fixture.js";

// Fixture is SYNTHETIC (fixtures/collectors/PROVENANCE.md), shaped like the SDK's ProxyCallTrace.
describe("naive-proxy collector (client.proxy.calls page)", () => {
  const page = fixture("naive-proxy/proxy-calls-page.synthetic.json");
  const A = "ses_01jx0000000000000000000aaa";

  it("filters to the trial's session and orders oldest first", () => {
    const calls = parseProxyCalls(page, { sessionId: A });
    expect(calls.map((c) => c.id.slice(-3))).toEqual(["001", "002", "003"]);
    expect(parseProxyCalls(page)).toHaveLength(4);
    expect(
      parseProxyCalls(page, {
        since: "2026-11-07T21:10:05.000Z",
        until: "2026-11-07T21:10:08.000Z",
      }),
    ).toHaveLength(2);
  });

  it("sums tokens, tool calls, errors and billed micro-USD as bigint", () => {
    const rows = collectNaiveProxy(page, { sessionId: A });
    expect(value(rows, "proxy_calls")).toBe(3);
    expect(value(rows, "proxy_input_tokens")).toBe(4110);
    expect(value(rows, "proxy_output_tokens")).toBe(315);
    expect(value(rows, "proxy_cache_read_tokens")).toBe(1800);
    expect(value(rows, "proxy_cache_write_tokens")).toBe(1800);
    expect(value(rows, "proxy_reasoning_tokens")).toBe(64);
    expect(value(rows, "proxy_tool_calls")).toBe(2);
    expect(value(rows, "proxy_errors")).toBe(1);
    expect(value(rows, "proxy_errors_by_class", { error_class: "rate_limited" })).toBe(1);
    expect(value(rows, "proxy_unbilled_calls")).toBe(1);
    const billed = row(rows, "proxy_billed_micro_usd");
    expect(billed).toMatchObject({ value: 5705n, unit: "micro_usd" });
    expect(value(rows, "proxy_vendor_cost_micro_usd")).toBe(4750n);
    expect(
      value(rows, "proxy_billed_micro_usd_by_model", { model: "anthropic/claude-haiku-4.5" }),
    ).toBe(4180n);
    expect(value(rows, "proxy_calls_by_model", { model: "anthropic/claude-haiku-4.5" })).toBe(2);
  });

  it("emits one latency sample per call", () => {
    const samples = collectNaiveProxy(page, { sessionId: A }).filter(
      (m) => m.name === "proxy_call_ms",
    );
    expect(samples.map((m) => [m.sample, m.value])).toEqual([
      [0, 1410],
      [1, 2950],
      [2, 1840],
    ]);
  });

  it("accepts the parsed page object, a data array and JSONL", () => {
    const obj = JSON.parse(page) as { data: unknown[] };
    const jsonl = obj.data.map((d) => JSON.stringify(d)).join("\n");
    for (const input of [obj, obj.data, jsonl]) {
      expect(value(collectNaiveProxy(input, { sessionId: A }), "proxy_billed_micro_usd")).toBe(
        5705n,
      );
    }
  });

  it("rejects a fractional micro-USD amount", () => {
    const bad = page.replace('"billed_micro_usd": 4180', '"billed_micro_usd": 4180.5');
    expect(() => collectNaiveProxy(bad)).toThrow(/integer/);
  });
});
