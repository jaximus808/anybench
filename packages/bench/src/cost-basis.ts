// What a kit's `cost_micro_usd` measures (TDM-246, plan.md 17.2 rule 5).
//
// The rule: cost comes from the provider side, never from a file the agent can write. So a trial's
// scored cost is its eval computer time (what the provider bills us, at our billed price) plus the
// Naïve proxy spend of its model calls (the provider's ledger): basis `compute_proxy`.
//
// A trial on the user's own model key (AB_TOKEN_SOURCE=anthropic_key, BYOK) has no proxy spend, so
// under that basis its cost is computer time alone, and setups that differ mainly in tokens rank
// by how long their computer ran. The exception, narrow on purpose: when EVERY contender of the kit
// runs on the Anthropic key with the SAME pinned Claude Code version (and no `vary` axis changes
// either), the token spend is measured by the same tool for everyone, the runner's meter over
// Claude Code's own session totals (`total_cost_usd`, list prices; TDM-231/239), not by a
// contender's self-report. Then cost = computer time + that metered spend: basis
// `compute_byok_tokens`. Any other kit keeps `compute_proxy`.
import { isAgentDriver, type KitSpec } from "@anybench/core";

export type KitCostBasis =
  | { kind: "compute_proxy" }
  | { kind: "compute_byok_tokens"; tokenSource: "anthropic_key"; claudeCodeVersion: string };

/** The token source whose spend the runner meters from Claude Code's session totals. */
export const BYOK_COST_TOKEN_SOURCE = "anthropic_key";

/** The kit's cost basis (pure). */
export function kitCostBasis(spec: Pick<KitSpec, "contenders" | "vary">): KitCostBasis {
  const proxy: KitCostBasis = { kind: "compute_proxy" };
  if (spec.contenders.length === 0) return proxy;
  // A varied token source or Claude Code version would mix measuring tools inside one kit.
  const varied = Object.keys(spec.vary ?? {});
  if (varied.includes("AB_TOKEN_SOURCE") || varied.includes("CLAUDE_CODE_VERSION")) return proxy;
  const versions = new Set<string>();
  for (const c of spec.contenders) {
    if (!isAgentDriver(c.driver)) return proxy;
    if (String(c.driver.env?.AB_TOKEN_SOURCE ?? "") !== BYOK_COST_TOKEN_SOURCE) return proxy;
    const v = c.versions?.CLAUDE_CODE_VERSION;
    if (typeof v !== "string" || v.trim() === "") return proxy;
    versions.add(v.trim());
  }
  if (versions.size !== 1) return proxy;
  return {
    kind: "compute_byok_tokens",
    tokenSource: BYOK_COST_TOKEN_SOURCE,
    claudeCodeVersion: [...versions][0]!,
  };
}

/** The report's line for a basis that includes model tokens; null for `compute_proxy`. */
export function costBasisDisclosure(basis: KitCostBasis): string | null {
  return basis.kind === "compute_byok_tokens"
    ? `cost includes model tokens at list price, as reported by Claude Code ${basis.claudeCodeVersion}'s session totals`
    : null;
}
