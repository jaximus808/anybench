// TDM-187 [16.16]: the skeptic role: its folder loads, the input has no field for contender
// scores, model findings are verified by code, the final verdict is code's, and the model-family
// rule picks an independent model per kit.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KitSpec } from "@anybench/core";
import { checkSkepticModel, runSkepticChecks } from "@anybench/kit";
import { describe, expect, it } from "vitest";
import {
  buildSkepticInput,
  DEFAULT_ROLES_DIR,
  designerModels,
  finalizeSkepticReview,
  loadRole,
  roleAgentSpec,
  SKEPTIC_MODEL_FALLBACKS,
  SKEPTIC_ROLE,
  SkepticInputSchema,
  SkepticOutputSchema,
  skepticModelFor,
  verifySkepticFindings,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TANDEM_KIT = path.join(here, "..", "..", "..", "kits", "tandem-vs-claude-code");
const CLI_KIT = path.join(here, "..", "..", "kit", "examples", "cli");

async function tandemTdm187() {
  const r = await runSkepticChecks(TANDEM_KIT);
  if (!r.material) throw new Error("tandem kit did not load");
  return { findings: r.findings, material: r.material };
}

describe("skeptic role (TDM-187)", () => {
  it("the role folder loads, and its model obeys the independence rule", () => {
    const def = loadRole(SKEPTIC_ROLE);
    expect(def.config.model).toBe("openai/gpt-5-mini");
    expect(def.outputSchema).not.toBeNull();
    const spec = roleAgentSpec(SKEPTIC_ROLE);
    expect(spec.budget.maxTaskMicroUsd).toBe(150_000n);
    expect(
      checkSkepticModel(def.config.model, { designer: designerModels(), contenders: [] }).ok,
    ).toBe(true);
    for (const m of SKEPTIC_MODEL_FALLBACKS) {
      expect(checkSkepticModel(m, { designer: designerModels(), contenders: [] }).ok, m).toBe(true);
    }
  });

  it("output.schema.json and SkepticOutputSchema name the same fields", () => {
    const json = JSON.parse(
      readFileSync(path.join(DEFAULT_ROLES_DIR, SKEPTIC_ROLE, "output.schema.json"), "utf8"),
    ) as { properties: Record<string, { items?: { properties: Record<string, unknown> } }> };
    expect(Object.keys(json.properties).sort()).toEqual(
      Object.keys(SkepticOutputSchema.shape).sort(),
    );
    expect(Object.keys(json.properties.findings!.items!.properties).sort()).toEqual([
      "check",
      "evidence",
      "quote",
      "severity",
      "why",
    ]);
  });

  it("the input is bounded, numbered and has no field for contender scores (rule 6)", async () => {
    const { findings, material } = await tandemTdm187();
    const input = buildSkepticInput(material, findings, {
      proof: [{ check: "oracle_passes", pass: true, reason: "42/42", evidence: [] }],
    });
    const text = JSON.stringify(input);
    expect(text.length).toBeLessThan(120_000);
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    walk(input);
    expect([...keys].filter((k) => /score|trial|metric_value|result_value/i.test(k))).toEqual([]);
    const bug = input.kit.workloads.find((w) => w.id === "bug-hunt")!;
    expect(bug.instruction!.lines.split("\n")[0]).toBe(
      "1| # Task: fix the broken CSV export (support ticket #231)",
    );
    expect(
      input.hidden_tests.some((h) => h.path === "gates/hidden-tests/bug-hunt/csv-quoting.test.ts"),
    ).toBe(true);
    expect(input.contender_help.map((h) => h.path)).toContain(
      "adapters/claude-code-solo/CLAUDE.md",
    );
    expect(input.kit.requirements.find((r) => r.id === "quality")!.weight).toBe(20);
    expect(input.deterministic_findings).toHaveLength(findings.length);
    // The strict schema refuses anything score-shaped, wherever someone tries to add it.
    expect(SkepticInputSchema.safeParse({ ...input, scores: { tandem: 91 } }).success).toBe(false);
    expect(
      SkepticInputSchema.safeParse({
        ...input,
        kit: { ...input.kit, contenders: input.kit.contenders.map((c) => ({ ...c, score: 1 })) },
      }).success,
    ).toBe(false);
    expect(
      SkepticInputSchema.safeParse({
        ...input,
        proof_results: [{ check: "oracle_passes", pass: true, reason: "ok", evidence: ["x"] }],
      }).success,
    ).toBe(false);
  });

  it("model findings: a quote on the cited line is kept; a wrong line, file or quote is a warning", async () => {
    const { material } = await tandemTdm187();
    const out = SkepticOutputSchema.parse({
      verdict: "repair",
      summary: "bug-hunt hands over the fix",
      findings: [
        {
          check: "solution_leakage",
          severity: "block",
          evidence: "workloads/bug-hunt/instruction.md:19",
          quote: "any double quote inside it is doubled",
          why: "the quoting rule is the fix",
        },
        {
          check: "contamination",
          severity: "block",
          evidence: "workloads/todo-api/instruction.md:1",
          quote: "this text is not there",
          why: "todo CRUD is a memorised genre",
        },
        {
          check: "made_up_check",
          severity: "block",
          evidence: "nope/missing.md:3",
          quote: "x",
          why: "invented",
        },
      ],
    });
    const v = verifySkepticFindings(out, material);
    expect(v.map((f) => [f.severity, f.check, f.source])).toEqual([
      ["block", "solution_leakage", "model"],
      ["warn", "contamination", "model"],
      ["warn", "other", "model"],
    ]);
    expect(v[1]!.why).toMatch(
      /^\[unverified: the quote is not on workloads\/todo-api\/instruction\.md:1\]/,
    );
    expect(v[2]!.evidence).toBe("anybench.yaml:1");
  });

  it("the final verdict is code's: an unverified model block cannot block, a model 'pass' cannot pass a block", async () => {
    const m = { files: [{ path: "a.md", text: "line one\nline two\n", sha256: "", size: 0 }] };
    const pass = finalizeSkepticReview(
      [],
      SkepticOutputSchema.parse({
        verdict: "hold",
        findings: [{ check: "other", severity: "block", evidence: "a.md:9", quote: "x", why: "y" }],
      }),
      m,
    );
    expect(pass).toMatchObject({ verdict: "pass", advisoryVerdict: "hold" });

    const { findings, material } = await tandemTdm187();
    const r = finalizeSkepticReview(
      findings,
      SkepticOutputSchema.parse({ verdict: "pass", findings: [] }),
      material,
    );
    expect(r).toMatchObject({ verdict: "repair", advisoryVerdict: "pass" });

    const hold = finalizeSkepticReview(
      [],
      SkepticOutputSchema.parse({
        verdict: "pass",
        findings: [
          {
            check: "contamination",
            severity: "block",
            evidence: "a.md:2",
            quote: "line two",
            why: "public fix",
          },
        ],
      }),
      m,
    );
    expect(hold.verdict).toBe("hold");
  });

  it("skepticModelFor: the role model by default; a fallback when contenders share its family; none → refused", async () => {
    const { material } = await tandemTdm187();
    expect(skepticModelFor(material.spec)).toEqual({ model: "openai/gpt-5-mini", refused: [] });

    const openaiKit = {
      ...material.spec,
      contenders: material.spec.contenders.map((c) =>
        c.driver.type === "coding-agent"
          ? { ...c, driver: { ...c.driver, model: "openai/gpt-5.5" } }
          : c,
      ),
    } as KitSpec;
    const fb = skepticModelFor(openaiKit);
    expect(fb.model).toBe("google/gemini-3.1-flash-lite");
    expect(fb.refused[0]).toMatch(/contender model 'openai\/gpt-5.5'/);

    expect(skepticModelFor(openaiKit, { designer: ["google/gemini-3.5-flash"] }).model).toBe(
      "qwen/qwen3.8-flash",
    );

    const none = skepticModelFor(material.spec, {
      candidates: ["anthropic/claude-haiku-4.5", "deepseek/deepseek-v4-pro"],
    });
    expect(none.model).toBeNull();
    expect(none.refused).toHaveLength(2);

    const cli = await runSkepticChecks(CLI_KIT);
    expect(skepticModelFor(cli.material!.spec).model).toBe("openai/gpt-5-mini");
  });
});
