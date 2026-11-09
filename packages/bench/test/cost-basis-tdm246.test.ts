// TDM-246: a kit's cost basis. Every contender on the Anthropic key with one pinned Claude Code
// version → cost = compute + metered model tokens; anything else keeps compute + Naïve proxy spend.
import { readFileSync } from "node:fs";
import { isAgentDriver, safeParseKitSpec, type KitSpec } from "@anybench/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { costBasisDisclosure, kitCostBasis } from "../src/index.js";

function kitTdm246(name: string): KitSpec {
  const url = new URL(`../../../kits/${name}/anybench.yaml`, import.meta.url);
  const r = safeParseKitSpec(parse(readFileSync(url, "utf8")));
  if (!r.success) throw new Error(`${name}: ${r.errors.join("; ")}`);
  return r.data;
}

/** The kit with contender `id`'s driver env / versions changed. */
function editTdm246(
  spec: KitSpec,
  id: string,
  edit: { env?: Record<string, string>; versions?: Record<string, string> },
): KitSpec {
  return {
    ...spec,
    contenders: spec.contenders.map((c) =>
      c.id !== id || !isAgentDriver(c.driver)
        ? c
        : {
            ...c,
            driver: { ...c.driver, env: { ...c.driver.env, ...edit.env } },
            ...(edit.versions ? { versions: { ...c.versions, ...edit.versions } } : {}),
          },
    ),
  };
}

describe("kit cost basis (TDM-246)", () => {
  it("the harness league and E18: all on the Anthropic key with Claude Code 2.1.319 → tokens count", () => {
    for (const name of ["harness-league", "tandem-long-horizon"]) {
      const basis = kitCostBasis(kitTdm246(name));
      expect(basis, name).toEqual({
        kind: "compute_byok_tokens",
        tokenSource: "anthropic_key",
        claudeCodeVersion: "2.1.319",
      });
      expect(costBasisDisclosure(basis)).toBe(
        "cost includes model tokens at list price, as reported by Claude Code 2.1.319's session totals",
      );
    }
  });

  it("anything else keeps compute + proxy: the Naïve-proxy kit, one setup off the key, two versions, a varied source, no pin", () => {
    const league = kitTdm246("harness-league");
    const cases: [string, KitSpec][] = [
      ["tandem-vs-claude-code (naive proxy)", kitTdm246("tandem-vs-claude-code")],
      [
        "one setup on the proxy",
        editTdm246(league, "gstack", { env: { AB_TOKEN_SOURCE: "naive_proxy" } }),
      ],
      [
        "one setup on another version",
        editTdm246(league, "superpowers", { versions: { CLAUDE_CODE_VERSION: "2.1.320" } }),
      ],
      [
        "a varied token source",
        { ...league, vary: { AB_TOKEN_SOURCE: ["anthropic_key", "naive_proxy"] } },
      ],
      [
        "a setup with no pinned Claude Code",
        {
          ...league,
          contenders: league.contenders.map((c) =>
            c.id === "tandem" ? { ...c, versions: { TANDEM_VERSION: "0.2.0" } } : c,
          ),
        },
      ],
      ["no contenders", { ...league, contenders: [] }],
    ];
    for (const [what, spec] of cases) {
      expect(kitCostBasis(spec), what).toEqual({ kind: "compute_proxy" });
      expect(costBasisDisclosure(kitCostBasis(spec))).toBeNull();
    }
  });
});
