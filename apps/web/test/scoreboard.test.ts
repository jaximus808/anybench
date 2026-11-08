// The scoreboard: raw success rate, time and cost per setup, overall and per task, from trials.
import { describe, expect, it } from "vitest";
import type { Trial } from "@anybench/core";
import { scoreboard } from "../components/report/scoreboard-model";

const t = (contender: string, task: string, ok: boolean, cost: number): Trial =>
  ({
    id: `t-${Math.random()}`,
    run_id: "r",
    contender_id: contender,
    workload_id: task,
    repeat: 0,
    attempt: 1,
    state: "done",
    failure_class: ok ? null : "gate",
    started_at: null,
    ended_at: null,
    cost_micro_usd: cost,
  }) as unknown as Trial;

describe("scoreboard", () => {
  const setups = [
    { id: "solo", name: "Solo", baseline: true },
    { id: "tandem", name: "Tandem", baseline: false },
  ];
  const trials = [
    t("solo", "a", true, 400_000),
    t("solo", "a", true, 400_000),
    t("solo", "b", false, 200_000),
    t("tandem", "a", true, 2_000_000),
    t("tandem", "b", true, 2_000_000),
    t("tandem", "b", true, 2_000_000),
    { ...t("tandem", "b", true, 9_000_000), state: "failed_infra" } as Trial,
  ];
  it("counts graded trials only and marks the better bar", () => {
    const b = scoreboard(setups, trials, null)!;
    const rate = b.headline.find((g) => g.key === "rate")!;
    expect(rate.bars.map((x) => [x.label, x.sub, x.best])).toEqual([
      ["67%", "2/3", false],
      ["100%", "3/3", true],
    ]);
    const cost = b.headline.find((g) => g.key === "cost")!;
    expect(cost.bars.map((x) => [x.label, x.best])).toEqual([
      ["$0.33", true],
      ["$2.00", false],
    ]);
    expect(b.tasks.map((x) => x.task)).toEqual(["a", "b"]);
    expect(b.headline.some((g) => g.key === "time")).toBe(false);
  });
  it("is empty before any trial is graded", () => {
    expect(scoreboard(setups, [], null)).toBeNull();
  });
});
