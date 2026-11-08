// TDM-39 [4.7] done condition, metrics half: the coding-agent driver's EVAL_OUT/stream.jsonl,
// read through @anybench/kit's readCodingAgentCollectorOutputs, parses with bench's stream-json
// collector into tokens, turns, cost, tool calls and 429s, and the rows a measured requirement of
// examples/coding-agent reads (cost_micro_usd) come back stamped with its gate. The transcript is
// the kit's recorded-shape fixture (packages/kit/test/fixtures/tdm39-stream-json/PROVENANCE.md).
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODING_AGENT_OUTPUT_PATHS, loadKit, readCodingAgentCollectorOutputs } from "@anybench/kit";
import { afterAll, describe, expect, it } from "vitest";
import { COLLECTOR_OUTPUT_FILES, collect, parseStreamJson, type Metric } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.join(here, "..", "..", "kit");
const FIXTURE = path.join(KIT, "test", "fixtures", "tdm39-stream-json", "slugify.synthetic.jsonl");
const EXAMPLE = path.join(KIT, "examples", "coding-agent");
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const row = (rows: Metric[], name: string) => rows.find((r) => r.name === name && !r.labels);

describe("coding-agent stream.jsonl -> stream-json collector", () => {
  it("the driver writes the stream where bench reads it", () => {
    expect(CODING_AGENT_OUTPUT_PATHS.stream).toBe(COLLECTOR_OUTPUT_FILES["stream-json"]);
  });

  it("parses tokens, turns, cost, tool calls and 429s, linked to the kit's gate", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "tdm39-bench-"));
    dirs.push(out);
    await copyFile(FIXTURE, path.join(out, CODING_AGENT_OUTPUT_PATHS.stream));
    const { inputs, missing } = await readCodingAgentCollectorOutputs(out);
    expect(missing).toEqual([]);

    const s = parseStreamJson(inputs[0]!.raw);
    expect(s).toMatchObject({
      model: "anthropic/claude-sonnet-4.6",
      claude_code_version: "2.1.319",
      turns: 5,
      token_source: "modelUsage",
      tokens: { input: 9, output: 1820, cache_read: 48210, cache_creation: 6120 },
      tool_calls: 4,
      tool_calls_by_name: { Read: 1, Write: 1, Bash: 1, Edit: 1 },
      tool_errors: 1,
      http_429: 1,
      api_retries: 1,
      cost_micro_usd: 42_130n,
      is_error: false,
      unparsed_lines: 0,
    });

    const kit = await loadKit(EXAMPLE);
    const r = collect(inputs, kit.spec.requirements);
    expect(r.errors).toEqual([]);
    expect(row(r.metrics, "cost_micro_usd")).toMatchObject({
      value: 42_130n,
      unit: "micro_usd",
      gate_id: "hidden-tests",
    });
    expect(row(r.metrics, "turns")?.value).toBe(5);
    expect(row(r.metrics, "total_tokens")?.value).toBe(9 + 1820 + 48210 + 6120);
    expect(row(r.metrics, "http_429")?.value).toBe(1);
    expect(row(r.metrics, "tool_calls")?.value).toBe(4);
    expect(row(r.metrics, "agent_error")?.value).toBe(0);
    // gate_pass_rate and wall_s come from the gate and the worker, not this collector.
    expect(r.missing.map((m) => m.metric).sort()).toEqual(["gate_pass_rate", "wall_s"]);
  });

  it("a trial with no stream reports the collector missing, never a zero", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "tdm39-bench-empty-"));
    dirs.push(out);
    const { inputs, missing } = await readCodingAgentCollectorOutputs(out);
    expect(inputs).toEqual([]);
    expect(missing).toEqual(["stream-json"]);
    const kit = await loadKit(EXAMPLE);
    expect(collect(inputs, kit.spec.requirements).missing.map((m) => m.metric)).toContain(
      "cost_micro_usd",
    );
  });
});
