// E18 [18.1] null pilot: the curated Tandem kit's A/A profile (Claude Code solo vs an identical
// copy of itself). No DB: the profile cut, the comparability rules and the kit-dir validator on
// it, the curated proof's hash check, the kit designer's routing, and scoreKit on A/A data shaped
// like the kit's own gates.
import { readFileSync } from "node:fs";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mulberry32, powerPlanForKit, scoreKit, type TrialResult } from "@anybench/bench";
import type { KitSpec } from "@anybench/core";
import { comparabilityIssues, loadKit, validateKitDir, type ContenderScript } from "@anybench/kit";
import { describe, expect, it } from "vitest";
import {
  CURATED_TANDEM_KIT,
  curatedKitStages,
  defaultKitsDir,
  headToHeadProfile,
  NULL_PILOT_BASELINE,
  NULL_PILOT_TWIN,
  nullPilotProfile,
  smokeProfile,
  trialCount,
  wantsFullBenchmark,
  wantsNullPilot,
  wantsSmoke,
} from "../src/orchestrator/curated.js";
import type { StageContext } from "../src/orchestrator/ports.js";
import { curatedProof } from "../src/orchestrator/proof-score.js";
import { kitSpecHash } from "../src/routes/kits.js";

const KIT_DIR_E18 = path.join(defaultKitsDir(), CURATED_TANDEM_KIT);
/** The question to type on the New run screen. */
const NULL_PILOT_QUESTION_E18 =
  "Null pilot: is Claude Code solo any different from an identical copy of itself?";

async function pilotE18(): Promise<{ full: KitSpec; pilot: KitSpec }> {
  const full = (await loadKit(KIT_DIR_E18)).spec;
  const r = nullPilotProfile(full);
  if (!r.ok) throw new Error(r.reason);
  return { full, pilot: r.spec };
}

function ctxE18(question: string, emitted: unknown[] = []): StageContext {
  return {
    run: {
      question,
      intake: { source: { kind: "github", github: "jaximus808/tandem", ref: "main" } },
    },
    idempotencyKey: "e18:design:0",
    signal: new AbortController().signal,
    emit: async (e: unknown[]) => void emitted.push(...e),
  } as unknown as StageContext;
}

describe("null pilot profile (E18 18.1)", () => {
  it("is triggered by 'null pilot' only, ahead of every other profile", () => {
    expect(wantsNullPilot(NULL_PILOT_QUESTION_E18)).toBe(true);
    expect(wantsNullPilot("run the NULL-PILOT")).toBe(true);
    expect(wantsNullPilot("Does Tandem beat Claude Code?")).toBe(false);
    expect(wantsNullPilot("nullpilotish")).toBe(false);
    // The pilot question doesn't also ask for another profile.
    expect(wantsSmoke(NULL_PILOT_QUESTION_E18)).toBe(false);
    expect(wantsFullBenchmark(NULL_PILOT_QUESTION_E18)).toBe(false);
  });

  it("is Claude Code solo twice, identical but for id, name and role, on all 3 tasks at the power plan's repeats", async () => {
    const { full, pilot } = await pilotE18();
    expect(pilot.contenders.map((c) => [c.id, c.role])).toEqual([
      [NULL_PILOT_BASELINE, "baseline"],
      [NULL_PILOT_TWIN, "subject"],
    ]);
    const solo = full.contenders.find((c) => c.id === NULL_PILOT_BASELINE)!;
    const [a, b] = pilot.contenders;
    const strip = (c: KitSpec["contenders"][number]) => {
      const { id: _id, name: _name, role: _role, found_by: _found, ...rest } = c;
      return rest;
    };
    expect(strip(a!)).toEqual(strip(solo));
    expect(strip(b!)).toEqual(strip(solo));
    expect(b!.name).not.toBe(a!.name);
    expect(pilot.workloads.map((w) => w.id)).toEqual(full.workloads.map((w) => w.id));
    expect(pilot.requirements).toEqual(full.requirements);
    expect(pilot.gates).toEqual(full.gates);
    expect(pilot.scoring).toEqual(full.scoring);
    expect(pilot.vary).toEqual({});
    expect(pilot.schedule.warmups).toBe(0);
    expect(pilot.schedule.order_seed).toBe(full.schedule.order_seed);

    const plan = powerPlanForKit(pilot);
    expect(pilot.repeats).toBe(plan.recommendedRepeats);
    expect(pilot.repeats).toBe(10);
    expect(trialCount(pilot)).toBe(60);
    expect(plan.trials.total).toBe(60);
    // The power plan is honest that 3 tasks can't show a difference: the pilot can't call a winner.
    expect(plan.recommended.passRate).toBeNull();
    expect(plan.notes.join(" ")).toMatch(/3 tasks can't show any difference/);
  });

  it("passes the comparability rules and the kit-dir validator", async () => {
    const { pilot } = await pilotE18();
    const scripts: ContenderScript[] = [];
    pilot.contenders.forEach((c, i) => {
      const fields: [string | undefined, PropertyKey[]][] = [
        [c.install?.script, ["install", "script"]],
        [c.install?.healthcheck, ["install", "healthcheck"]],
        ["script" in c.driver ? c.driver.script : undefined, ["driver", "script"]],
      ];
      for (const [rel, field] of fields) {
        if (rel === undefined) continue;
        scripts.push({
          contender: i,
          path: rel,
          field,
          text: readFileSync(path.join(KIT_DIR_E18, rel), "utf8"),
        });
      }
    });
    expect(scripts.length).toBeGreaterThanOrEqual(6);
    expect(comparabilityIssues(pilot, scripts).filter((i) => i.severity === "error")).toEqual([]);

    // The whole validator on a copy of the kit whose manifest is the pilot (YAML ⊇ JSON).
    const dir = mkdtempSync(path.join(tmpdir(), "e18-null-pilot-"));
    cpSync(KIT_DIR_E18, dir, { recursive: true });
    writeFileSync(path.join(dir, "anybench.yaml"), JSON.stringify(pilot, null, 2));
    const v = await validateKitDir(dir);
    expect(v.lines).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("is accepted by the curated proof's hash check, like the smoke and head-to-head cuts", async () => {
    const { full, pilot } = await pilotE18();
    const h2h = headToHeadProfile(full);
    const smoke = smokeProfile(full);
    expect(h2h.ok && smoke.ok).toBe(true);
    const hashes = new Set([
      kitSpecHash(full),
      kitSpecHash(pilot),
      ...(h2h.ok ? [kitSpecHash(h2h.spec)] : []),
      ...(smoke.ok ? [kitSpecHash(smoke.spec)] : []),
    ]);
    expect(hashes.size).toBe(4);
    const ctx = ctxE18(NULL_PILOT_QUESTION_E18);
    const ok = await curatedProof()(ctx, { kit_id: "k", kit: pilot, env: null });
    expect(ok.ok).toBe(true);
    // An edited pilot is a different kit.
    const edited = await curatedProof()(ctx, {
      kit_id: "k",
      kit: { ...pilot, repeats: pilot.repeats + 1 },
      env: null,
    });
    expect(edited.ok).toBe(false);
  });

  it("the kit designer returns it for a 'null pilot' question and says what it will run", async () => {
    const emitted: { payload?: { text?: string } }[] = [];
    const r = await curatedKitStages().designKit(ctxE18(NULL_PILOT_QUESTION_E18, emitted), {
      digest: null,
      understanding: null,
      research: null,
      previous: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { pilot } = await pilotE18();
    expect(kitSpecHash(r.value.spec as KitSpec)).toBe(kitSpecHash(pilot));
    const texts = emitted.map((e) => e.payload?.text ?? "");
    expect(texts.some((t) => t.startsWith("null pilot profile: 60 trials"))).toBe(true);
  });
});

describe("null pilot verdicts on A/A data shaped like the kit's gates", () => {
  /** One A/A run of the pilot: both arms from one per-task generator, gates as the kit writes them. */
  function aaTrialsE18(pilot: KitSpec, seed: number): TrialResult[] {
    const rand = mulberry32(seed);
    const out: TrialResult[] = [];
    for (const w of pilot.workloads) {
      const p = 0.2 + 0.7 * rand();
      const wall = 400 + 2000 * rand();
      for (const c of pilot.contenders) {
        for (let repeat = 0; repeat < pilot.repeats; repeat++) {
          const pass = rand() < p;
          const api = w.id === "todo-api";
          const metrics: Record<string, number> = {
            wall_s: wall * (0.6 + 0.8 * rand()),
            cost_micro_usd: Math.round(300_000 + 900_000 * rand()),
          };
          if (api && pass) metrics.api_p95_ms = 60 + 60 * rand();
          out.push({
            contenderId: c.id,
            workloadId: w.id,
            repeat,
            metrics,
            gates: {
              "hidden-tests": { pass, reason: pass ? "pass" : "fail", evidence: [] },
              "api-load": api
                ? { pass, reason: pass ? "p95 measured" : "tests failed", evidence: [] }
                : { pass: false, applicable: false, reason: "not applicable", evidence: [] },
            },
            reviews: pass ? { quality: 1 + Math.floor(4 * rand()) } : {},
          });
        }
      }
    }
    return out;
  }

  it("every requirement says 'no detectable difference' on every seed", async () => {
    const { pilot } = await pilotE18();
    for (let seed = 1; seed <= 20; seed++) {
      const r = scoreKit(pilot, aaTrialsE18(pilot, seed), { seed });
      expect(r.stats.baseline).toBe(NULL_PILOT_BASELINE);
      expect(r.stats.clustered).toBe(true);
      const twin = r.contenders.find((c) => c.contenderId === NULL_PILOT_TWIN)!;
      const compared = twin.requirements.filter((q) => q.scored && q.verdict !== null);
      expect(compared.length).toBeGreaterThanOrEqual(4);
      for (const q of compared) {
        if (!q.scored) continue;
        expect(q.verdict).toBe("indistinguishable");
        expect(q.comparison!.statement).toMatch(/^no detectable difference at n=/);
      }
    }
  }, 60_000);
});
