/**
 * The run shown in the hero and in the product mock's Running screen:
 * 4 setups x 3 tasks x 5 runs. p passed, f failed, r running, q queued.
 */
export type TileState = "p" | "f" | "r" | "q";

export const EXAMPLE_TASKS = ["todo-api", "auth-refactor", "bug-hunt"] as const;

export const EXAMPLE_RUN: ReadonlyArray<readonly [setup: string, tiles: string]> = [
  ["A · claude code solo", "ppfppfpfpfprrrq"],
  ["B · claude code + subagents", "pppfppffpprrrqq"],
  ["C · tandem ×3", "pppppfpfprrrrqq"],
  ["D · tandem ×5", "ppfppffprrrrqqq"],
];

export function countTiles(state: TileState): number {
  return EXAMPLE_RUN.reduce(
    (n, [, tiles]) => n + tiles.split("").filter((c) => c === state).length,
    0,
  );
}

/** Splits a row's 15 tiles into its three tasks of 5 runs. */
export function taskGroups(tiles: string): TileState[][] {
  const states = tiles.split("") as TileState[];
  return [states.slice(0, 5), states.slice(5, 10), states.slice(10, 15)];
}
