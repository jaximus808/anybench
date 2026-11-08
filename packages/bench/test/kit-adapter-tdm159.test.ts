// TDM-159: schedulableFromKit maps a real KitSpec onto the scheduler's input.
import { readFileSync } from "node:fs";
import { KitSpecSchema, type KitSpec } from "@anybench/core";
import { describe, expect, it } from "vitest";
import {
  expandTrials,
  expandTrialsInputFromKit,
  groupBlocks,
  schedulableFromKit,
} from "../src/index.js";

type FixtureTdm159 = "kit-agent" | "kit-harness-tandem" | "kit-software-cli" | "kit-terminal-pty";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawKitTdm159(name: FixtureTdm159): any {
  const url = new URL(`../../core/test/fixtures/kits/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function kitTdm159(name: FixtureTdm159, schedule?: unknown): KitSpec {
  const raw = rawKitTdm159(name);
  if (schedule !== undefined) raw.schedule = schedule;
  return KitSpecSchema.parse(raw);
}

describe("schedulableFromKit", () => {
  it("maps the harness-tandem fixture with the schedule defaults", () => {
    const kit = kitTdm159("kit-harness-tandem");
    const s = schedulableFromKit(kit);
    expect(s.contenders).toEqual(kit.contenders.map((c) => c.id));
    expect(s.workloads).toEqual(kit.workloads.map((w) => w.id));
    expect(s).toMatchObject({ repeats: kit.repeats, warmups: 1, packing: false });
    expect(s.est_trial_seconds).toBeGreaterThan(0);
  });

  it("expands harness-tandem to contenders × workloads × (repeats + warm-ups), packing off", () => {
    const kit = kitTdm159("kit-harness-tandem");
    const nC = kit.contenders.length;
    const nW = kit.workloads.length;
    const plans = expandTrials(expandTrialsInputFromKit("run-tdm159", kit));

    expect(plans).toHaveLength(nC * nW * (kit.repeats + 1));
    expect(plans.filter((p) => p.warmup)).toHaveLength(nC * nW);
    expect(plans.filter((p) => !p.warmup)).toHaveLength(nC * nW * kit.repeats);
    // Packing off: every trial is its own computer.
    expect(groupBlocks(plans)).toHaveLength(plans.length);
    // Interleaved A B C within the first workload.
    expect(plans.slice(0, nC).map((p) => p.contender_id)).toEqual(kit.contenders.map((c) => c.id));
    expect(plans.every((p) => p.run_id === "run-tdm159")).toBe(true);
  });

  it("carries packing, warm-ups, estimate and block into the plan for a software kit", () => {
    const kit = kitTdm159("kit-software-cli", {
      packing: true,
      est_trial_seconds: 60,
      warmups: 0,
      block_seconds: 600,
    });
    const input = expandTrialsInputFromKit("run-tdm159-pack", kit);
    expect(input.block_seconds).toBe(600);
    expect(input.kit).toMatchObject({ packing: true, est_trial_seconds: 60, warmups: 0 });
    const plans = expandTrials(input);
    expect(plans).toHaveLength(kit.contenders.length * kit.workloads.length * kit.repeats);
    expect(plans.some((p) => p.warmup)).toBe(false);
    // Packed: fewer computers than trials.
    expect(groupBlocks(plans).length).toBeLessThan(plans.length);
  });

  it("uses est_trial_seconds when given, else the largest cap, else the block", () => {
    expect(
      schedulableFromKit(kitTdm159("kit-agent", { est_trial_seconds: 42 })).est_trial_seconds,
    ).toBe(42);

    const capped = rawKitTdm159("kit-agent");
    capped.workloads[0].timeout_s = 1200;
    capped.contenders[0].driver.wall_clock_cap_s = 900;
    expect(schedulableFromKit(KitSpecSchema.parse(capped)).est_trial_seconds).toBe(1200);

    const bare = rawKitTdm159("kit-agent");
    for (const w of bare.workloads) delete w.timeout_s;
    for (const c of bare.contenders) delete c.driver.wall_clock_cap_s;
    // TDM-174: an agent kit's wall_s needs a cap to count failures at; give it on the requirement.
    for (const r of bare.requirements) if (r.metric === "wall_s") r.cap = 3600;
    bare.schedule = { block_seconds: 300 };
    expect(schedulableFromKit(KitSpecSchema.parse(bare)).est_trial_seconds).toBe(300);
  });

  it.each(["kit-agent", "kit-harness-tandem", "kit-software-cli", "kit-terminal-pty"] as const)(
    "%s expands without error",
    (name) => {
      const kit = kitTdm159(name);
      expect(expandTrials(expandTrialsInputFromKit("r", kit)).length).toBeGreaterThan(0);
    },
  );
});
