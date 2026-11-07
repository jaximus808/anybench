// TDM-159: KitSpec `schedule` (warm-ups, per-trial estimate, packing, billing block).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KIT_BLOCK_SECONDS,
  DEFAULT_KIT_WARMUPS,
  KitScheduleSchema,
  KitSpecSchema,
  PACKABLE_DRIVER_TYPES,
  safeParseKitSpec,
} from "../src/index.js";

const FIXTURES_TDM159 = [
  "kit-agent",
  "kit-harness-tandem",
  "kit-software-cli",
  "kit-terminal-pty",
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadKitTdm159(name: (typeof FIXTURES_TDM159)[number]): any {
  const url = new URL(`./fixtures/kits/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function errorsTdm159(input: unknown): string[] {
  const r = safeParseKitSpec(input);
  if (r.success) throw new Error("expected the kit to fail validation");
  return r.errors;
}

describe("KitSpec schedule", () => {
  it.each(FIXTURES_TDM159)("%s validates without a schedule and gets the defaults", (name) => {
    const kit = KitSpecSchema.parse(loadKitTdm159(name));
    expect(kit.schedule).toEqual({
      warmups: DEFAULT_KIT_WARMUPS,
      packing: false,
      block_seconds: DEFAULT_KIT_BLOCK_SECONDS,
    });
    expect(DEFAULT_KIT_WARMUPS).toBe(1);
    expect(DEFAULT_KIT_BLOCK_SECONDS).toBe(600);
  });

  it("fills defaults inside a partial schedule", () => {
    expect(KitScheduleSchema.parse({ est_trial_seconds: 90 })).toEqual({
      warmups: 1,
      est_trial_seconds: 90,
      packing: false,
      block_seconds: 600,
    });
    expect(KitScheduleSchema.parse({ warmups: 0 }).warmups).toBe(0);
  });

  it("rejects bad values and unknown keys", () => {
    for (const bad of [
      { warmups: -1 },
      { warmups: 1.5 },
      { est_trial_seconds: 0 },
      { block_seconds: 0 },
      { packing: "yes" },
      { pack: true },
    ]) {
      expect(KitScheduleSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("allows packing for a kit of cli contenders with an estimate", () => {
    const kit = loadKitTdm159("kit-software-cli");
    kit.schedule = { packing: true, est_trial_seconds: 60 };
    const r = safeParseKitSpec(kit);
    if (!r.success) throw new Error(r.errors.join("\n"));
    expect(r.data.schedule).toMatchObject({ packing: true, est_trial_seconds: 60, warmups: 1 });
  });

  it("packing needs est_trial_seconds", () => {
    const kit = loadKitTdm159("kit-software-cli");
    kit.schedule = { packing: true };
    expect(errorsTdm159(kit)).toEqual([
      "schedule.est_trial_seconds: packing needs est_trial_seconds to size the billing blocks",
    ]);
  });

  it.each([
    ["kit-agent", 0, "my-claude-setup", "coding-agent"],
    ["kit-harness-tandem", 0, "tandem", "harness"],
    ["kit-terminal-pty", 0, "velocitty", "pty"],
  ] as const)("rejects packing for %s", (name, i, id, type) => {
    const kit = loadKitTdm159(name);
    kit.schedule = { packing: true, est_trial_seconds: 60 };
    expect(errorsTdm159(kit)).toContain(
      `schedule.packing: packing is allowed only when every contender's driver type is cli, lib, service; contenders[${i}] '${id}' is '${type}'`,
    );
  });

  it("rejects packing when one contender of a software kit is not packable", () => {
    const kit = loadKitTdm159("kit-software-cli");
    kit.contenders[1].driver = loadKitTdm159("kit-terminal-pty").contenders[0].driver;
    kit.schedule = { packing: true, est_trial_seconds: 60 };
    const errors = errorsTdm159(kit);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^schedule\.packing: .*contenders\[1\] 'gnu-grep' is 'pty'$/);
  });

  it("lists cli, lib and service as packable", () => {
    expect([...PACKABLE_DRIVER_TYPES].sort()).toEqual(["cli", "lib", "service"]);
  });
});
