import { describe, expect, it } from "vitest";

describe("@anybench/publish scaffold", () => {
  it("loads the package entry", async () => {
    const mod = await import("../src/index.js");
    expect(mod).toBeTypeOf("object");
  });
});
