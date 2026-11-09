// Replay a trial's runner stdout (the `[run] {...}` tap lines) or stream.jsonl through the runner's
// own TokenMeter (packages/runner token-cap.ts) with the Opus 5.5 prices the worker passes
// (bench FIRST_PARTY_TOKEN_PRICES), and print where the $25 cap trips and what the meter reads at
// the end, next to Claude Code's own session totals (TDM-229). Read-only, no network.
//
//   pnpm exec tsx scripts/spikes/harness-league/replay-meter.ts <stdout.log|stream.jsonl>...
import { readFileSync } from "node:fs";
import { FIRST_PARTY_TOKEN_PRICES } from "../../../packages/bench/src/executor.js";
import { TokenMeter } from "../../../packages/runner/src/token-cap.js";

const usd = (m: bigint): string => `$${(Number(m) / 1e6).toFixed(2)}`;
const prices = FIRST_PARTY_TOKEN_PRICES["claude-opus-5-5"];

for (const file of process.argv.slice(2)) {
  let tripped: string | null = null;
  let n = 0;
  const meter = new TokenMeter(25_000_000n, prices, (s) => {
    tripped =
      `line ${n}: spent ${usd(s.spent_micro_usd)} (${s.source}) + margin ${usd(s.margin_micro_usd)}; ` +
      `msgs ${s.messages}, results ${s.results}, sessions ${s.sessions}, open ${s.open_sessions}; ` +
      `out ${s.tokens.output} (usage ${s.usage_output}) cr ${s.tokens.cache_read} cw ${s.tokens.cache_creation}`;
  });
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    n++;
    meter.line(raw.startsWith("[run] ") ? raw.slice(6) : raw);
  }
  const s = meter.snapshot();
  console.log(file.split("/").slice(-2).join("/"));
  console.log(`  tripped: ${tripped ?? "never"}`);
  console.log(
    `  end: spent ${usd(s.spent_micro_usd)} (${s.source}); estimate ${usd(s.estimate_micro_usd)}, ` +
      `reported ${usd(s.reported_micro_usd)}; msgs ${s.messages}, results ${s.results}, ` +
      `sessions ${s.sessions}; in ${s.tokens.input} out ${s.tokens.output} (usage ${s.usage_output}) ` +
      `cr ${s.tokens.cache_read} cw ${s.tokens.cache_creation}`,
  );
}
