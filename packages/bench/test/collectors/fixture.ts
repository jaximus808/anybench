import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Metric } from "../../src/metric.js";

const ROOT = fileURLToPath(new URL("../../fixtures/collectors/", import.meta.url));

/** Read a committed collector fixture. */
export function fixture(path: string): string {
  return readFileSync(ROOT + path, "utf8");
}

/** The one row with this name (and these labels, if given). Fails if there are zero or several. */
export function row(
  rows: readonly Metric[],
  name: string,
  labels?: Record<string, string>,
): Metric {
  const hits = rows.filter(
    (m) =>
      m.name === name &&
      (labels === undefined || Object.entries(labels).every(([k, v]) => m.labels?.[k] === v)),
  );
  if (hits.length !== 1)
    throw new Error(`expected one ${name} ${JSON.stringify(labels ?? {})}, got ${hits.length}`);
  return hits[0]!;
}

export const value = (rows: readonly Metric[], name: string, labels?: Record<string, string>) =>
  row(rows, name, labels).value;
