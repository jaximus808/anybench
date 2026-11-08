// TDM-60 [6.6]: a kit's declared `env.toolchains` → recipes. The subject image gets them on top of
// its profile (the agent under test runs the project's tests); the scoring image gets them on
// top of SCORING_RECIPES (the hidden-tests gate runs the same tests). A toolchain without a
// recipe, or with a version the catalog does not carry, is an error the caller holds the run on:
// never a silent skip.
import type { RecipeCatalog } from "./recipe.js";

/** Toolchain name → recipe. */
export const TOOLCHAIN_RECIPES: Readonly<Record<string, string>> = {
  node: "node22",
  python: "python312-uv",
  go: "go",
};

export type ToolchainRecipes = { ok: true; recipes: string[] } | { ok: false; reason: string };

/** A toolchain version matches a recipe when it is the recipe's version or a prefix of it at a dot. */
export function toolchainVersionMatches(want: string, recipeVersion: string): boolean {
  const w = want.trim().replace(/^v/, "");
  if (w === "") return false;
  return (
    recipeVersion === w || recipeVersion.startsWith(`${w}.`) || recipeVersion.startsWith(`${w}-`)
  );
}

export function toolchainRecipes(
  catalog: RecipeCatalog,
  toolchains: readonly { name: string; version: string }[],
): ToolchainRecipes {
  const out: string[] = [];
  for (const t of toolchains) {
    const name = TOOLCHAIN_RECIPES[t.name.toLowerCase()];
    if (!name) {
      return {
        ok: false,
        reason: `toolchain '${t.name}' has no recipe yet (known: ${Object.keys(TOOLCHAIN_RECIPES).join(", ")})`,
      };
    }
    const recipe = catalog.recipes.get(name);
    if (!recipe)
      return { ok: false, reason: `toolchain '${t.name}': recipe '${name}' is not in the catalog` };
    if (!toolchainVersionMatches(t.version, recipe.manifest.version)) {
      return {
        ok: false,
        reason: `toolchain ${t.name} ${t.version}: the catalog carries ${name} ${recipe.manifest.version} only`,
      };
    }
    if (!out.includes(name)) out.push(name);
  }
  return { ok: true, recipes: out };
}

/** `base` + `extra`, kit order kept, duplicates dropped. */
export function withRecipes(base: readonly string[], extra: readonly string[]): string[] {
  return [...base, ...extra.filter((r) => !base.includes(r))].filter(
    (r, i, a) => a.indexOf(r) === i,
  );
}
