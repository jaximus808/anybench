import { describe, expect, it } from "vitest";

describe("@anybench/mcp scaffold", () => {
  it("loads the package entry", async () => {
    const mod = await import("../src/index.js");
    expect(mod).toBeTypeOf("object");
  });
});
