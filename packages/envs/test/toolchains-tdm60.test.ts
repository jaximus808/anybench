// TDM-60 [6.6]: declared toolchains → recipes (subject and scoring images), unknown → an error.
import { describe, expect, it } from "vitest";
import {
  loadRecipeCatalog,
  toolchainRecipes,
  toolchainVersionMatches,
  withRecipes,
  BASE_RECIPES,
} from "../src/index.js";

describe("toolchains (TDM-60)", () => {
  it("maps node / python / go to the pinned recipes, version by prefix", async () => {
    const cat = await loadRecipeCatalog();
    expect(cat.recipes.get("go")!.manifest.version).toBe("1.26.3");
    expect(cat.recipes.get("go")!.manifest.downloads.x64!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      toolchainRecipes(cat, [
        { name: "node", version: "22" },
        { name: "go", version: "1.26" },
        { name: "python", version: "3.12" },
      ]),
    ).toEqual({
      ok: true,
      recipes: ["node22", "go", "python312-uv"],
    });
    expect(toolchainVersionMatches("1.26", "1.26.3")).toBe(true);
    expect(toolchainVersionMatches("1.2", "1.26.3")).toBe(false);
    expect(toolchainVersionMatches("3.12", "3.12.15-uv0.13.4")).toBe(true);
  });

  it("refuses an unknown toolchain or an uncarried version, never skips", async () => {
    const cat = await loadRecipeCatalog();
    expect(toolchainRecipes(cat, [{ name: "rust", version: "stable" }])).toEqual({
      ok: false,
      reason: "toolchain 'rust' has no recipe yet (known: node, python, go)",
    });
    expect(toolchainRecipes(cat, [{ name: "go", version: "1.25" }])).toEqual({
      ok: false,
      reason: "toolchain go 1.25: the catalog carries go 1.26.3 only",
    });
  });

  it("adds toolchain recipes after the profile's, without duplicates", () => {
    expect(withRecipes(BASE_RECIPES, ["node22", "go"])).toEqual([...BASE_RECIPES, "go"]);
  });
});
