import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // The shared dev Mac runs many workers at once; imports and DB setup can be slow under load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
