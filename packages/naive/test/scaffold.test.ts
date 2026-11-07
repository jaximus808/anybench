import { describe, expect, it } from "vitest";

describe("@anybench/naive scaffold", () => {
  it("loads the package entry", async () => {
    const mod = await import("../src/index.js");
    expect(mod).toBeTypeOf("object");
  });
});
