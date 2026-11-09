// TDM-210: the scoreboard shows the share of hidden tests passed (every graded trial) when the
// signed snapshot carries it, and is unchanged when it doesn't.
import { describe, expect, it } from "vitest";
import type { PublicationScoreCell } from "@anybench/core";
import { buildBoard, cellsFromPublication } from "../components/report/scoreboard-model";

const setups = [
  { id: "solo", name: "Solo", baseline: true },
  { id: "tandem", name: "Tandem", baseline: false },
];
const cell = (id: string, extra: Partial<PublicationScoreCell> = {}): PublicationScoreCell => ({
  contender_id: id as PublicationScoreCell["contender_id"],
  workload_id: null,
  graded: 3,
  passed: 0,
  cost_micro_usd: 30_000_000,
  wall_s_mean: null,
  wall_n: 0,
  ...extra,
});

describe("scoreboard: hidden tests passed (TDM-210)", () => {
  it("adds a 'Hidden tests passed' bar from the snapshot, even with 0% fully passing", () => {
    const b = buildBoard(
      setups,
      cellsFromPublication([
        cell("solo", { hidden_test_fraction_mean: 0.3, hidden_test_fraction_n: 3 }),
        cell("tandem", { hidden_test_fraction_mean: 0.85, hidden_test_fraction_n: 3 }),
      ]),
    )!;
    expect(b.headline.map((g) => g.key)).toEqual(["rate", "tests", "cost"]);
    const tests = b.headline.find((g) => g.key === "tests")!;
    expect(tests.bars.map((x) => [x.label, x.sub, x.best])).toEqual([
      ["30%", "n=3", false],
      ["85%", "n=3", true],
    ]);
    expect(b.headline.find((g) => g.key === "rate")!.bars.map((x) => x.label)).toEqual([
      "0%",
      "0%",
    ]);
  });

  it("older snapshots without the fraction render as before", () => {
    const b = buildBoard(setups, cellsFromPublication([cell("solo"), cell("tandem")]))!;
    expect(b.headline.map((g) => g.key)).toEqual(["rate", "cost"]);
  });
});
