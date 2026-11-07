// Shared vitest base for every workspace package (TDM-169). Each package's
// vitest.config.ts merges this with mergeConfig and adds only its own overrides.
// The dev Mac runs many workers at once, so imports and DB setup can be slow
// under load: 30 s per test and per hook.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
