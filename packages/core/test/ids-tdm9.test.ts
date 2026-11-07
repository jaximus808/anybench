import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  RunIdSchema,
  TrialIdSchema,
  newId,
  uuidv7,
  uuidv7Timestamp,
  type RunId,
  type TrialId,
} from "../src/ids.js";

describe("ids (TDM-9)", () => {
  it("uuidv7 has the right version, variant and timestamp", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 48 - 1 }), (ms) => {
        const id = uuidv7(ms);
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(uuidv7Timestamp(id)).toBe(ms);
      }),
    );
  });

  it("ids sort by creation time across milliseconds", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
  });

  it("newId returns a parsed, branded id", () => {
    const run = newId(RunIdSchema);
    expect(RunIdSchema.parse(run)).toBe(run);
    expectTypeOf(run).toEqualTypeOf<RunId>();
    expectTypeOf(newId(TrialIdSchema)).toEqualTypeOf<TrialId>();
    expectTypeOf<RunId>().not.toEqualTypeOf<TrialId>();
    const unique = new Set(Array.from({ length: 1000 }, () => newId(RunIdSchema)));
    expect(unique.size).toBe(1000);
  });

  it("id schemas accept any UUID (lowercased) and reject non-UUIDs", () => {
    expect(RunIdSchema.parse("6F9619FF-8B86-4011-B42D-00C04FC964FF")).toBe(
      "6f9619ff-8b86-4011-b42d-00c04fc964ff",
    );
    for (const bad of ["", "run_123", "6f9619ff8b864011b42d00c04fc964ff", 42, null]) {
      expect(RunIdSchema.safeParse(bad).success).toBe(false);
    }
  });
});
